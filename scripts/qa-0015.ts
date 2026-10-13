import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractTextPage, type TextPage } from '../src/textlayer';
import { dropZeroRows, sortRows } from '../src/model';
import { generatePDF, scanTestRows } from '../src/pdf';

const input = process.env.INVENTORY_0015_PDF;
if (!input) throw new Error('Set INVENTORY_0015_PDF to the private 0015-09 PDF.');
const root = process.cwd(); const pdfDir = path.join(root, 'output', 'pdf'); const validationDir = path.join(root, 'output', 'validation');
await fs.mkdir(pdfDir, { recursive: true }); await fs.mkdir(validationDir, { recursive: true });
const before = await fs.readFile(input); const sourceSHA256 = createHash('sha256').update(before).digest('hex');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const images = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
const document = await pdfjs.getDocument({ data: new Uint8Array(before), isEvalSupported: false, verbosity: 0 }).promise;
let previous: Parameters<typeof extractTextPage>[2]; const rows = [];
for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
  const pdfPage = await document.getPage(pageNumber); const viewport = pdfPage.getViewport({ scale: 300 / 72 });
  const [operators, content] = await Promise.all([pdfPage.getOperatorList(), pdfPage.getTextContent()]);
  const page: TextPage = { viewport: viewport.transform, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), hasImages: operators.fnArray.some(operator => images.has(operator)),
    items: content.items.flatMap((item: any) => 'str' in item ? [{ str: item.str, transform: item.transform, width: item.width }] : []) };
  const result = extractTextPage(pageNumber, page, previous); if (!result) throw new Error(`Page ${pageNumber} did not parse as text.`);
  previous = result.layout ?? previous; rows.push(...result.rows);
}
const { kept, skipped } = dropZeroRows(rows);
if (kept.length !== 1388 || skipped.length !== 3561) throw new Error(`Expected 1388 kept / 3561 skipped; got ${kept.length} / ${skipped.length}.`);
const font = new Uint8Array(await fs.readFile(path.join(root, 'public', 'assets', 'fonts', 'NotoSansTC-PDF.ttf')));
const outputs: unknown[] = [];
for (const sortMode of ['sku', 'location'] as const) {
  const stem = `0015-09_${sortMode === 'sku' ? '代號' : '儲位'}`;
  const result = await generatePDF(kept, { storeName: '範本門市（校對示例）', sortMode, rowHeight: 22.6, source: `來源 0015-09全.pdf · 輸出 ${kept.length} 筆 · 略過帳量 0 共 ${skipped.length} 筆 · 驗證輸出` }, font);
  const target = path.join(pdfDir, `${stem}.pdf`); await fs.writeFile(target, result.bytes);
  await fs.writeFile(path.join(pdfDir, `${stem}.expected.json`), JSON.stringify({ codes: sortRows(kept, sortMode).map(row => row.sku) }, null, 2) + '\n');
  outputs.push({ file: path.basename(target), pages: result.pageCount, barcodes: result.barcodeCount, sha256: createHash('sha256').update(result.bytes).digest('hex') });
}
const scan = await generatePDF(scanTestRows(), { storeName: '掃描器實機驗收', sortMode: 'sku', rowHeight: 22.6, title: '相鄰條碼掃讀測試', note: '請以原尺寸 100% 列印，掃描每列，確認六碼與前導零。' }, font);
const scanTarget = path.join(pdfDir, '條碼掃讀測試_22.6mm.pdf'); await fs.writeFile(scanTarget, scan.bytes);
await fs.writeFile(path.join(pdfDir, '條碼掃讀測試_22.6mm.expected.json'), JSON.stringify({ codes: scanTestRows().map(row => row.sku) }, null, 2) + '\n');
outputs.push({ file: path.basename(scanTarget), pages: scan.pageCount, barcodes: scan.barcodeCount, sha256: createHash('sha256').update(scan.bytes).digest('hex') });
const after = createHash('sha256').update(await fs.readFile(input)).digest('hex');
if (after !== sourceSHA256) throw new Error('Private source PDF changed while generating validation outputs.');
await fs.writeFile(path.join(validationDir, 'qa-0015.json'), JSON.stringify({ source: path.basename(input), sourceSHA256, sourceUnchanged: true, pages: document.numPages, kept: kept.length, skippedZero: skipped.length, outputs }, null, 2) + '\n');
console.log(`Generated ${outputs.length} PDFs from ${kept.length} kept rows; source SHA-256 unchanged.`);
