import { createWorker, PSM, type Worker } from 'tesseract.js';
import { binarize, cropCanvas, deskewAngle, rotateCanvas, scaleCanvas } from './geometry';
import { asset, canonicalQuantity, dropZeroRows, type Box, type InventoryRow, type PageReport } from './model';
import { decide } from './vote';
import { continuationValid, detectLayout, extractRows, headerAnchor, LOCATION_OVERFLOW, splitTrailingQuantity, type Layout, type Reading, type Span } from './parser';
import type { DocumentSource } from './source';
import { extractTextPage } from './textlayer';
export type OCRProgress = (message: string, fraction?: number) => void;
function unpack(data: any, x = 0, y = 0): Reading {
  const words: Span[] = []; const lines: Span[] = [];
  for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) {
    const span = (item: any): Span => ({ text: item.text ?? '', confidence: item.confidence ?? 0,
      x0: item.bbox.x0 + x, y0: item.bbox.y0 + y, x1: item.bbox.x1 + x, y1: item.bbox.y1 + y });
    if (line.bbox) lines.push(span(line)); for (const word of line.words ?? []) if (word.bbox) words.push(span(word));
  }
  return { text: data.text ?? '', words, lines, confidence: data.confidence ?? 0 };
}
/** A small PNG of one cell (about 40 px high) shown next to the field during review. */
function cellImage(canvas: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }): string {
  const raw = cropCanvas(canvas, box); const small = scaleCanvas(raw, Math.min(1, 40 / Math.max(1, raw.height))); raw.width = raw.height = 1;
  try { return small.toDataURL('image/png'); } finally { small.width = small.height = 1; }
}
export class OCREngine {
  // layout: from an OCR page; textLayout: from a text-layer page (kept apart, frames differ).
  chinese?: Worker; numeric?: Worker; layout?: Layout; textLayout?: Layout; rotation?: number; workers?: Promise<void>;
  progress: OCRProgress; terminated = false; busyCanvases = 0; peakCanvases = 0;
  headerDebug: unknown[] = [];
  constructor(progress: OCRProgress) { this.progress = progress; }
  /** Workers load on first OCR use, so a system-printed PDF never downloads the models. */
  async initialize(): Promise<void> {}
  private ensureWorkers(): Promise<void> {
    if (this.terminated) return Promise.reject(new DOMException('已取消', 'AbortError'));
    return this.workers ??= this.loadWorkers();
  }
  private async loadWorkers(): Promise<void> {
    const options = { workerPath: asset('ocr/worker.min.js'), corePath: asset('ocr/core'), langPath: asset('tessdata'),
      cacheMethod: 'none' as const, workerBlobURL: false,
      logger: (message: { status: string; progress: number }) => { if (message.status.includes('loading')) this.progress('載入辨識模型', message.progress); } };
    this.chinese = await createWorker('chi_tra', 1, options);
    this.numeric = await createWorker('eng', 1, options);
    // Cancelled while loading: terminate() ran before these workers existed.
    if (this.terminated) { await this.terminate(); throw new DOMException('已取消', 'AbortError'); }
    await this.numeric.setParameters({ tessedit_char_whitelist: '0123456789,.-', tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    await this.chinese.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  }
  async recognize(canvas: HTMLCanvasElement, type: 'chinese'|'numeric', psm: PSM, rectangle?: {x:number;y:number;width:number;height:number}): Promise<Reading> {
    await this.ensureWorkers();
    const image = rectangle ? cropCanvas(canvas, rectangle) : canvas;
    try {
      const worker = (type === 'chinese' ? this.chinese : this.numeric)!;
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
      return unpack(data, rectangle?.x ?? 0, rectangle?.y ?? 0);
    } finally { if (image !== canvas) image.width = image.height = 1; }
  }
  async headerReading(canvas: HTMLCanvasElement): Promise<{header:Reading;layout:Layout|null}> {
    const broad=await this.recognize(canvas,'chinese',PSM.AUTO,{x:0,y:0,width:canvas.width,height:Math.round(canvas.height*.18)});
    let layout=detectLayout(broad,canvas.width,canvas.height);
    if(layout)return {header:broad,layout};
    // Automatic segmentation can skip the whole column-header line; sparse text
    // mode reads isolated words and usually finds it (measured on both scans).
    const sparse=await this.recognize(canvas,'chinese',PSM.SPARSE_TEXT,{x:0,y:0,width:canvas.width,height:Math.round(canvas.height*.18)});
    layout=detectLayout(broad,canvas.width,canvas.height,[sparse]);
    if(layout)return {header:broad,layout};
    const anchor=headerAnchor(broad.words,'國際條碼')??headerAnchor(broad.words,'商品代號')??headerAnchor(sparse.words,'國際條碼')??headerAnchor(sparse.words,'商品代號');
    if(anchor){
      const y=Math.max(0,Math.round(anchor.y0-(anchor.y1-anchor.y0)*.2));
      const height=Math.min(canvas.height-y,Math.round((anchor.y1-anchor.y0)*1.8));
      const attempts: Reading[] = [];
      for (const mode of [PSM.SINGLE_LINE, PSM.SINGLE_BLOCK, PSM.SPARSE_TEXT]) {
        const band=await this.recognize(canvas,'chinese',mode,{x:0,y,width:canvas.width,height});
        attempts.push(band);
        layout=detectLayout(broad,canvas.width,canvas.height,[sparse,...attempts]);
        if(layout)break;
      }
      // Metadata stays with the broad reading; a failed retry never erases
      // headings already read correctly in that pass.
      return {header:broad,layout};
    }
    return {header:broad,layout};
  }
  async extract(source: DocumentSource, page: number, forcedRotation?: number): Promise<{ report: PageReport; rows: InventoryRow[] }> {
    // A forced rotation is a manual retry of a page the text layer could not read.
    if (forcedRotation === undefined) {
      this.progress('讀取 PDF 文字');
      const text = await source.textPage(page);
      const result = text && extractTextPage(page, text, this.textLayout);
      if (result) {
        if (result.layout) this.textLayout = result.layout;
        const { kept, skipped } = dropZeroRows(result.rows);
        result.report.rowCount = kept.length; result.report.skippedZero = skipped.length;
        return { report: result.report, rows: kept };
      }
    }
    const original = await source.render(page); this.busyCanvases++; this.peakCanvases = Math.max(this.peakCanvases, this.busyCanvases);
    let canvas = original; let rotation = forcedRotation ?? this.rotation ?? 0; let deskew = 0;
    try {
      this.progress('校正方向與檢查表頭');
      let header: Reading | undefined; let currentLayout: Layout | null = null;
      const candidates = forcedRotation !== undefined ? [forcedRotation] : this.rotation !== undefined ? [this.rotation] : original.width < original.height ? [90,270,0,180] : [0,180,90,270];
      for (const candidate of candidates) {
        if (canvas !== original) canvas.width = canvas.height = 1;
        canvas = rotateCanvas(original, candidate); rotation = candidate;
        ({header,layout:currentLayout}=await this.headerReading(canvas));
        if(import.meta.env.DEV) this.headerDebug.push({ page, rotation:candidate, width:canvas.width, height:canvas.height, text:header.text, words:header.words, layout:currentLayout });
        if (currentLayout || this.layout) break;
      }
      if (!currentLayout && !this.layout) return { report: { page, width: canvas.width, height: canvas.height, rotation, deskew,
        status: 'rejected', reason: '找不到商品代號、名稱、國際條碼、儲位、庫存量的表頭與排列。此頁無法確認為庫存簡表。', rowCount: 0, skippedZero: 0, storeName: '' }, rows: [] };
      deskew = deskewAngle(canvas);
      if (deskew) {
        const adjusted = rotateCanvas(canvas, deskew); const again = await this.headerReading(adjusted);
        // Keep the un-deskewed page when straightening loses a header that was found.
        if (again.layout || !currentLayout) { if (canvas !== original) canvas.width = canvas.height = 1; canvas = adjusted; ({header,layout:currentLayout}=again); }
        else { adjusted.width = adjusted.height = 1; deskew = 0; }
      }
      const layout = currentLayout ?? { ...this.layout!, bodyTop: .018 };
      const column = (range: [number,number]) => ({ x: Math.round(range[0] * canvas.width), y: Math.round(layout.bodyTop * canvas.height),
        width: Math.round((range[1]-range[0])*canvas.width), height: Math.round((.965-layout.bodyTop)*canvas.height) });
      this.progress('擷取商品代號，進行兩次比對');
      const codesA = await this.recognize(canvas, 'numeric', PSM.SINGLE_BLOCK, column(layout.sku));
      const codesB = await this.recognize(canvas, 'numeric', PSM.SPARSE_TEXT, column(layout.sku));
      this.progress('擷取名稱與儲位');
      const names = await this.recognize(canvas, 'chinese', PSM.SINGLE_BLOCK, column(layout.rawName));
      const locations = await this.recognize(canvas, 'chinese', PSM.SINGLE_BLOCK, column(layout.location));
      this.progress('擷取庫存量，進行兩次比對');
      await this.numeric!.setParameters({tessedit_char_whitelist:'0123456789,.-'});
      const qtyA = await this.recognize(canvas, 'numeric', PSM.SINGLE_BLOCK, column(layout.bookQty));
      await this.numeric!.setParameters({tessedit_char_whitelist:'0123456789,-'});
      const qtyB = await this.recognize(canvas, 'numeric', PSM.SPARSE_TEXT, column(layout.bookQty));
      await this.numeric!.setParameters({tessedit_char_whitelist:'0123456789,.-'});
      const rows = extractRows(page, canvas.width, canvas.height, layout, { codesA, codesB, names, locations, qtyA, qtyB });
      await this.voteNumbers(canvas, rows);
      const valid = continuationValid(rows, header?.text ?? '');
      const title = header?.lines.filter(line => line.y1 < canvas.height * .065 && !/庫存|報表|排序|庫別/.test(line.text.replace(/\s/g,''))).sort((a,b)=>a.y0-b.y0)[0]?.text.replace(/\s+/g,'').trim() ?? '';
      // Validate continuation against every recognised row before safe zeroes are removed.
      const { kept, skipped } = valid ? dropZeroRows(rows) : { kept: [] as InventoryRow[], skipped: [] as InventoryRow[] };
      const report: PageReport = { page, width: canvas.width, height: canvas.height, rotation, deskew, rowCount: kept.length, skippedZero: skipped.length,
        status: valid ? 'accepted' : 'rejected', reason: valid ? '' : '商品列的代號、名稱與庫存量結構不足，請確認是否混入其他文件或掃描品質不佳。', storeName: currentLayout ? title : '', mode: 'ocr' };
      if (valid && currentLayout) { this.layout = currentLayout; this.rotation = rotation; }
      return { report, rows: kept };
    } finally { if (canvas !== original) canvas.width = canvas.height = 1; original.width = original.height = 1; this.busyCanvases--; }
  }
  /**
   * Re-reads every code and quantity cell three ways (grey x2, black/white x2,
   * black/white x3) and votes together with the two column passes. Cells of one
   * column are stacked into a single image with white gaps, so each way is one
   * OCR call per column instead of one per cell.
   * Clear majorities are accepted silently; real disagreements list the candidates.
   */
  async voteNumbers(canvas: HTMLCanvasElement, rows: InventoryRow[]): Promise<void> {
    if (!rows.length) return;
    this.progress('逐格比對代號與庫存量');
    const variants = [{ scale: 2, bw: false }, { scale: 2, bw: true }, { scale: 3, bw: true }];
    const pixels = (box: Box) => ({ x: box.x * canvas.width, y: box.y * canvas.height, width: box.width * canvas.width, height: box.height * canvas.height });
    const normal = { sku: (t: string) => /^\d{6}$/.test(t) ? t : null, bookQty: (t: string) => canonicalQuantity(t) };
    const votes = rows.map(row => ({ sku: [normal.sku(row.ocrReadings?.sku[0] ?? ''), normal.sku(row.ocrReadings?.sku[1] ?? '')], bookQty: [...(row.ocrReadings?.bookQty ?? [null, null])] }));
    const overflowInVote = new Set<number>();
    const worker = this.numeric!;
    // No "." in cells: a thousands comma misread as "." (2.398) was the main quantity error.
    await worker.setParameters({ tessedit_char_whitelist: '0123456789,-', tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    try {
      for (const field of ['sku', 'bookQty'] as const) for (const variant of variants) {
        if (this.terminated) throw new DOMException('已取消', 'AbortError');
        const cells = rows.map(row => { const raw = cropCanvas(canvas, pixels(row.boxes[field])); const scaled = scaleCanvas(raw, variant.scale); raw.width = raw.height = 1; return scaled; });
        const gap = Math.round(Math.max(...cells.map(c => c.height)) * .6); const pad = 24;
        const stack = document.createElement('canvas'); stack.width = Math.max(...cells.map(c => c.width)) + pad * 2;
        stack.height = cells.reduce((h, c) => h + c.height + gap, pad * 2 - gap);
        const ctx = stack.getContext('2d', { willReadFrequently: true })!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, stack.width, stack.height);
        const slots: [number, number][] = []; let y = pad;
        for (const cell of cells) { ctx.drawImage(cell, pad, y); slots.push([y - gap / 2, y + cell.height + gap / 2]); y += cell.height + gap; cell.width = cell.height = 1; }
        if (variant.bw) binarize(stack);
        try {
          const reading = unpack((await worker.recognize(stack, {}, { text: true, blocks: true })).data);
          slots.forEach(([top, bottom], i) => {
            const lines = reading.lines.filter(line => (line.y0 + line.y1) / 2 >= top && (line.y0 + line.y1) / 2 < bottom);
            const words = reading.words.filter(word => (word.y0 + word.y1) / 2 >= top && (word.y0 + word.y1) / 2 < bottom);
            const split = field === 'bookQty' ? splitTrailingQuantity(words) : undefined;
            if (split) overflowInVote.add(i);
            const text = split?.quantity ?? lines.map(line => line.text).join('').replace(/\s+/g, '');
            votes[i][field].push(normal[field](text));
          });
        } finally { stack.width = stack.height = 1; }
      }
    } finally { await worker.setParameters({ tessedit_char_whitelist: '0123456789,.-' }); }
    const replaced = { sku: /^代號(兩次辨識不一致|辨識信心偏低|不是六位數)$/, bookQty: /^庫存量(兩次辨識不一致|格式待確認|辨識信心偏低)$|^小數點或千分位/ };
    const label = { sku: '代號', bookQty: '庫存量' };
    for (const [i, row] of rows.entries()) {
      for (const field of ['sku', 'bookQty'] as const) {
        const decision = decide(votes[i][field], 3);
        row.issues = row.issues.filter(issue => !replaced[field].test(issue));
        if (decision.value) row[field] = decision.value;
        if (!decision.value) row.issues.push(field === 'sku' ? '代號不是六位數' : '庫存量格式待確認');
        else if (!decision.agreed) row.issues.push(`${label[field]}多次辨識不一致（候選 ${decision.candidates.join('、')}），請對照原圖`);
        if (!decision.value || !decision.agreed) (row.numberDoubts ??= {})[field] = { candidates: decision.candidates, image: cellImage(canvas, pixels(row.boxes[field])) };
      }
      if (overflowInVote.has(i) && !row.issues.includes(LOCATION_OVERFLOW)) row.issues.push(LOCATION_OVERFLOW);
      delete row.ocrReadings;
    }
  }
  async terminate(): Promise<void> { this.terminated = true; await Promise.allSettled([this.chinese?.terminate(), this.numeric?.terminate()]); this.chinese = this.numeric = undefined; }
}
