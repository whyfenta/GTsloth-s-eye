// 樹懶的管理: the three A4 lists. No barcodes, so rows are only as tall as their wrapped text.
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { asset } from './model';
import { mm, wrapText } from './pdf';

export type ListColumn = { label: string; width: number; align?: 'left' | 'right' };
/**
 * rows hold the printed cell text; a "\n" in a cell starts a new line (used for the 負庫存異常 mark).
 * alerts marks cells printed in red heavy type, row by row like rows; only plain numbers can be marked.
 */
export type ListSpec = { title: string; columns: ListColumn[]; rows: string[][]; alerts?: boolean[][]; meta: string[]; note: string; empty: string; subject?: string };
export type ListResult = { bytes: Uint8Array; pageCount: number; rowCount: number };
const ALERT = rgb(.78, .07, .07);
export const LIST_PRINT = { size: 10, leading: 13, padding: 1.8, top: 262, bottom: 25, header: 7 };

export async function generateListPDF(spec: ListSpec, notoBytes?: Uint8Array): Promise<ListResult> {
  const total = spec.columns.reduce((sum, column) => sum + column.width, 0);
  if (Math.abs(total - 190) > .01) throw new Error(`欄寬合計須為 190 mm（目前 ${total} mm）`);
  const document = await PDFDocument.create();
  document.registerFontkit({ ...fontkit, create(bytes: Uint8Array) { const font = fontkit.create(bytes) as any; return font.variationAxes?.wght ? font.getVariation({ wght: 400 }) : font; } });
  const bytes = notoBytes ?? new Uint8Array(await (await fetch(asset('fonts/NotoSansTC-PDF.ttf'))).arrayBuffer());
  // Full embedding, as on the inventory sheet: subset CJK glyphs render blank.
  const font = await document.embedFont(bytes, { subset: false, features: { locl: false } });
  // The embedded Noto has one weight; a marked number uses the standard Helvetica-Bold, which needs no embedding.
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  if (spec.alerts?.some((cells, row) => cells.some((alert, column) => alert && !/^[-\d,.]+$/.test(spec.rows[row]?.[column] ?? ''))))
    throw new Error('只有數字欄位可以用紅色粗體標示。');
  document.setTitle(spec.title); document.setAuthor('樹懶的管理'); document.setSubject(spec.subject ?? '在瀏覽器產生的 A4 管理清單');
  const xs = [mm(10)]; for (const column of spec.columns) xs.push(xs.at(-1)! + mm(column.width));
  const { size, leading } = LIST_PRINT; const pad = mm(LIST_PRINT.padding);
  // The footer note holds up to 5 lines above the page number; the table takes the room of the lines it does not use.
  const noteLines = wrapText(spec.note, font, 7, mm(170)).slice(0, 5); const unused = (5 - noteLines.length) * 8.5;
  const top = mm(LIST_PRINT.top); const bottom = mm(LIST_PRINT.bottom) - unused;
  const prepared = spec.rows.map((cells, row) => {
    const alerts = cells.map((_, i) => Boolean(spec.alerts?.[row]?.[i]));
    const lines = cells.map((cell, i) => wrapText(cell, alerts[i] ? bold : font, size, mm(spec.columns[i].width) - pad * 2));
    const height = Math.max(...lines.map(list => list.length)) * leading + pad * 2;
    if (height > top - bottom) throw new Error(`「${cells[0]}」內容過長，無法放入一頁。`);
    return { lines, alerts, height };
  });
  // A whole row always stays on one page.
  const groups: typeof prepared[] = []; let group: typeof prepared = []; let available = top - bottom;
  for (const item of prepared) { if (item.height > available && group.length) { groups.push(group); group = []; available = top - bottom; } group.push(item); available -= item.height; }
  if (group.length || !groups.length) groups.push(group);
  const line = (page: ReturnType<typeof document.addPage>, x0: number, y0: number, x1: number, y1: number) => page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: .45, color: rgb(.6, .65, .62) });
  for (let p = 0; p < groups.length; p++) {
    const page = document.addPage([mm(210), mm(297)]);
    page.drawText(spec.title, { x: mm(10), y: mm(283), size: 16, font, color: rgb(.12, .23, .2) });
    const meta = spec.meta.flatMap(text => wrapText(text, font, 8, mm(190))).slice(0, 3);
    meta.forEach((text, i) => page.drawText(text, { x: mm(10), y: mm(277.5) - i * 10, size: 8, font }));
    const headerTop = top + mm(LIST_PRINT.header);
    page.drawRectangle({ x: xs[0], y: top, width: mm(190), height: mm(LIST_PRINT.header), color: rgb(.84, .9, .86) });
    spec.columns.forEach((column, i) => {
      const width = font.widthOfTextAtSize(column.label, 9);
      page.drawText(column.label, { x: column.align === 'right' ? xs[i + 1] - pad - width : xs[i] + pad, y: top + mm(2.3), size: 9, font });
    });
    let y = top;
    if (!groups[p].length) {
      // The explanation spans the whole table, so no column lines run through it.
      for (const x of xs) line(page, x, headerTop, x, top);
      const message = wrapText(spec.empty, font, 11, mm(176)); const height = mm(12) + message.length * 15;
      message.forEach((text, i) => page.drawText(text, { x: mm(17), y: top - mm(8) - 11 - i * 15, size: 11, font }));
      page.drawRectangle({ x: xs[0], y: top - height, width: mm(190), height, borderColor: rgb(.6, .65, .62), borderWidth: .45 });
      line(page, xs[0], headerTop, xs.at(-1)!, headerTop); y = top;
    }
    for (const [index, item] of groups[p].entries()) {
      const next = y - item.height;
      if (index % 2 === 1) page.drawRectangle({ x: xs[0], y: next, width: mm(190), height: item.height, color: rgb(.92, .95, .93) });
      item.lines.forEach((cellLines, column) => cellLines.forEach((text, i) => {
        const right = spec.columns[column].align === 'right'; const face = item.alerts[column] ? bold : font;
        page.drawText(text, { x: right ? xs[column + 1] - pad - face.widthOfTextAtSize(text, size) : xs[column] + pad, y: y - pad - size * .88 - i * leading, size, font: face, color: item.alerts[column] ? ALERT : undefined });
      }));
      line(page, xs[0], next, xs.at(-1)!, next); y = next;
    }
    if (groups[p].length) { for (const x of xs) line(page, x, headerTop, x, y); line(page, xs[0], headerTop, xs.at(-1)!, headerTop); }
    noteLines.forEach((text, i) => page.drawText(text, { x: mm(10), y: mm(19) - unused - i * 8.5, size: 7, font }));
    const footer = `${p + 1} / ${groups.length}`;
    page.drawText(footer, { x: mm(200) - font.widthOfTextAtSize(footer, 8), y: mm(8), size: 8, font });
  }
  return { bytes: await document.save(), pageCount: groups.length, rowCount: spec.rows.length };
}
