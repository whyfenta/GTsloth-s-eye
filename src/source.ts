import * as pdfjs from 'pdfjs-dist';
import pdfWorkerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { asset, LIMITS } from './model';
import type { TextItem, TextPage } from './textlayer';
import { rotateCanvas } from './geometry';
const A4_SHORT_INCHES = 210 / 25.4;
/** Below this the measured error rate rises clearly (see openFile). */
export const MIN_SCAN_DPI = 300;
// Any drawn image means a scan (possibly with a scanner's hidden OCR text, which is not trusted).
const imageOperators = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintInlineImageXObjectGroup,
  pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageMaskXObjectGroup, pdfjs.OPS.paintImageMaskXObjectRepeat]);
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerURL;
/** Width/height from a PNG IHDR or JPEG SOF header; undefined if not found. */
export function imageSize(bytes: Uint8Array, png: boolean): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (png) return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined;
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    i += 2 + view.getUint16(i + 2);
  }
  return undefined;
}
export class DocumentSource {
  file: File; pages = 1; pdf?: pdfjs.PDFDocumentProxy; bitmap?: ImageBitmap;
  constructor(file: File) { this.file = file; }
  static async open(file: File): Promise<DocumentSource> {
    if (file.size > LIMITS.bytes) throw new Error('檔案超過 200 MB，請先分成較小的檔案。');
    const source = new DocumentSource(file);
    const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const pdf = String.fromCharCode(...signature.slice(0, 5)) === '%PDF-';
    const png = signature[0] === 137 && signature[1] === 80 && signature[2] === 78 && signature[3] === 71;
    const jpg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
    if (pdf) {
      const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false,
        cMapUrl: asset('pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: asset('pdfjs/standard_fonts/') });
      try { source.pdf = await task.promise; source.pages = source.pdf.numPages; }
      catch { await task.destroy(); throw new Error('無法開啟 PDF。請確認檔案完整且未加密。'); }
      if (source.pages > LIMITS.pages) { await source.dispose(); throw new Error('PDF 超過 200 頁，請分檔處理。'); }
    } else if (png || jpg) {
      // Check the header first so an oversized image is refused before decoding fills memory.
      const size = imageSize(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()), png);
      const tooLarge = '圖片尺寸過大，請縮小到六千萬像素以下。';
      if (size && size.width * size.height > 60_000_000) throw new Error(tooLarge);
      source.bitmap = await createImageBitmap(file);
      if (source.bitmap.width * source.bitmap.height > 60_000_000) { await source.dispose(); throw new Error(tooLarge); }
    } else throw new Error('請選擇真正的 PDF、JPG 或 PNG 檔案。');
    return source;
  }
  async render(pageNumber: number, dpi = LIMITS.dpi): Promise<HTMLCanvasElement> {
    const canvas = document.createElement('canvas'); const context = canvas.getContext('2d', { willReadFrequently: true })!;
    if (this.pdf) {
      const page = await this.pdf.getPage(pageNumber);
      const scan = await this.scanImage(page).catch(() => undefined);
      if (scan) { page.cleanup(); return scan; }
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(dpi / 72, LIMITS.longestEdge / Math.max(original.width, original.height));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: context, canvas, viewport, background: 'rgb(255,255,255)' }).promise;
      page.cleanup();
    } else if (this.bitmap) {
      const scale = Math.min(1, LIMITS.longestEdge / Math.max(this.bitmap.width, this.bitmap.height));
      canvas.width = Math.round(this.bitmap.width * scale); canvas.height = Math.round(this.bitmap.height * scale);
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(this.bitmap, 0, 0, canvas.width, canvas.height);
    } else throw new Error('來源檔案已清除。');
    return canvas;
  }
  /**
   * A scanned page is one upright image covering the page. Drawing that image at
   * its own resolution (never upscaled, capped at LIMITS.longestEdge) avoids a
   * second resampling by the PDF renderer. Anything else returns undefined.
   */
  private async scanImage(page: pdfjs.PDFPageProxy): Promise<HTMLCanvasElement | undefined> {
    const ops = await page.getOperatorList(); const view = page.getViewport({ scale: 1, rotation: 0 });
    const paints = ops.fnArray.flatMap((fn, i) => fn === pdfjs.OPS.paintImageXObject ? [i] : []);
    const drawsMore = ops.fnArray.some(fn => fn === pdfjs.OPS.showText || (imageOperators.has(fn) && fn !== pdfjs.OPS.paintImageXObject));
    if (paints.length !== 1 || drawsMore) return undefined;
    // The placement matrix must be an unrotated, unflipped rectangle filling the page.
    // pdf.js may insert a dependency op between the transform and the paint.
    const at = paints[0]; let t = at - 1; while (t >= 0 && ops.fnArray[t] === pdfjs.OPS.dependency) t--;
    const placement = ops.fnArray[t] === pdfjs.OPS.transform ? ops.argsArray[t] as number[] : undefined;
    if (!placement || placement[1] || placement[2] || placement[0] <= 0 || placement[3] <= 0 ||
      placement[0] * placement[3] < view.width * view.height * .9) return undefined;
    const id = ops.argsArray[at][0] as string; const store = id.startsWith('g_') ? page.commonObjs : page.objs;
    const image = await new Promise<any>(resolve => store.get(id, resolve));
    if (!image?.width || !image?.height) return undefined;
    const native = document.createElement('canvas'); native.width = image.width; native.height = image.height;
    const ctx = native.getContext('2d', { willReadFrequently: true })!;
    if (image.bitmap) ctx.drawImage(image.bitmap, 0, 0);
    else if (image.data && (image.kind === 2 || image.kind === 3)) {
      // pdf.js ImageKind: 2 = RGB 24 bpp, 3 = RGBA 32 bpp (1 bpp masks are left to the renderer).
      const pixels = ctx.createImageData(image.width, image.height); const step = image.kind === 2 ? 3 : 4;
      for (let p = 0, q = 0; p < pixels.data.length; p += 4, q += step) { pixels.data[p] = image.data[q]; pixels.data[p + 1] = image.data[q + 1]; pixels.data[p + 2] = image.data[q + 2]; pixels.data[p + 3] = 255; }
      ctx.putImageData(pixels, 0, 0);
    } else { native.width = native.height = 1; return undefined; }
    const scale = Math.min(1, LIMITS.longestEdge / Math.max(image.width, image.height)); let canvas = native;
    if (scale < 1) {
      canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      const small = canvas.getContext('2d', { willReadFrequently: true })!; small.imageSmoothingQuality = 'high'; small.drawImage(native, 0, 0, canvas.width, canvas.height);
      native.width = native.height = 1;
    }
    // Match the page's own /Rotate, as the PDF renderer would.
    if (!page.rotate) return canvas;
    const turned = rotateCanvas(canvas, page.rotate); canvas.width = canvas.height = 1; return turned;
  }
  /**
   * Scan resolution in dpi (lowest of the first pages), or undefined for
   * system-printed PDFs. A PDF knows the page size exactly; a photo or image
   * file does not, so it is assumed to show one A4 sheet (short side 8.27 in).
   */
  async scanDpi(pagesToCheck = 3): Promise<number | undefined> {
    if (this.bitmap) return Math.round(Math.min(this.bitmap.width, this.bitmap.height) / A4_SHORT_INCHES);
    if (!this.pdf) return undefined;
    const found: number[] = [];
    for (let n = 1; n <= Math.min(pagesToCheck, this.pages); n++) {
      const page = await this.pdf.getPage(n);
      try {
        const ops = await page.getOperatorList();
        if (ops.fnArray.includes(pdfjs.OPS.showText)) continue;
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
          let t = i - 1; while (t >= 0 && ops.fnArray[t] === pdfjs.OPS.dependency) t--;
          const placement = ops.fnArray[t] === pdfjs.OPS.transform ? ops.argsArray[t] as number[] : undefined;
          const [, width, height] = ops.argsArray[i] as [string, number, number];
          // Placement is in points (1/72 in); rotated placements use b/c instead of a/d.
          const inchesX = Math.hypot(placement?.[0] ?? 0, placement?.[1] ?? 0) / 72, inchesY = Math.hypot(placement?.[2] ?? 0, placement?.[3] ?? 0) / 72;
          if (inchesX > 1 && inchesY > 1) found.push(Math.min(width / inchesX, height / inchesY));
        }
      } finally { page.cleanup(); }
    }
    return found.length ? Math.round(Math.min(...found)) : undefined;
  }
  /** The page's text layer in render-pixel coordinates; undefined for images. hasImages marks scans. */
  async textPage(pageNumber: number, dpi = LIMITS.dpi): Promise<TextPage | undefined> {
    if (!this.pdf) return undefined;
    const page = await this.pdf.getPage(pageNumber);
    try {
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(dpi / 72, LIMITS.longestEdge / Math.max(original.width, original.height)) });
      const operators = await page.getOperatorList();
      const content = await page.getTextContent();
      const items = content.items.flatMap((item): TextItem[] => 'str' in item ? [{ str: item.str, transform: item.transform, width: item.width }] : []);
      return { items, viewport: viewport.transform, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), hasImages: operators.fnArray.some(fn => imageOperators.has(fn)) };
    } finally { page.cleanup(); }
  }
  async dispose(): Promise<void> { await this.pdf?.destroy(); this.pdf = undefined; this.bitmap?.close(); this.bitmap = undefined; }
}
