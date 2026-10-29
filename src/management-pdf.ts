// 樹懶的管理: the three A4 lists. No barcodes, so rows are only as tall as their wrapped text.
import { PDFDocument, rgb, StandardFonts, pushGraphicsState, popGraphicsState, setLineWidth, setStrokingColor, setTextRenderingMode, TextRenderingMode } from 'pdf-lib';
import { embedNoto, mm, wrapText } from './pdf-common';

export type ListColumn = { label: string; width: number; align?: 'left' | 'right' };
/**
 * rows hold the printed cell text; a "\n" in a cell starts a new line (used for the 負庫存異常 mark).
 * alerts marks cells printed in red, row by row like rows: a plain number in heavy type, a name only at its leading 缺貨 (regular font).
 */
export type ListSpec = { title: string; columns: ListColumn[]; rows: string[][]; alerts?: boolean[][]; meta: string[]; warning?: string; note: string; empty: string; subject?: string;
  /** Rows printed after the list in grey, under a heading that spans the table (the self-pay lines after the dead stock). */
  tail?: { heading: string; rows: string[][] } };
export type ListResult = { bytes: Uint8Array; pageCount: number; rowCount: number };
const ALERT = rgb(.78, .07, .07);
/** The part of a marked name printed in red. */
export const ALERT_WORD = '缺貨';
/** One step lighter than the black body text: set apart, still easy to read. */
const MUTED = rgb(.45, .45, .45);
export const LIST_PRINT = { size: 10, leading: 13, padding: 1.8, top: 262, bottom: 25, header: 7 };

export async function generateListPDF(spec: ListSpec, notoBytes?: Uint8Array): Promise<ListResult> {
  const total = spec.columns.reduce((sum, column) => sum + column.width, 0);
  if (Math.abs(total - 190) > .01) throw new Error(`欄寬合計須為 190 mm（目前 ${total} mm）`);
  const document = await PDFDocument.create();
  const font = await embedNoto(document, notoBytes);
  // The embedded Noto has one weight; a marked number uses the standard Helvetica-Bold, which needs no embedding. In a marked name only the leading ALERT_WORD is coloured.
  const heavy = (cell: string, alert: boolean) => alert && /^[-\d,.]+$/.test(cell);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  document.setTitle(spec.title); document.setAuthor('樹懶的管理'); document.setSubject(spec.subject ?? '在瀏覽器產生的 A4 管理清單');
  const xs = [mm(10)]; for (const column of spec.columns) xs.push(xs.at(-1)! + mm(column.width));
  const { size, leading } = LIST_PRINT; const pad = mm(LIST_PRINT.padding);
  // The footer note holds up to 5 lines above the page number; the table takes the room of the lines it does not use.
  const noteLines = wrapText(spec.note, font, 7, mm(170)).slice(0, 5); const unused = (5 - noteLines.length) * 8.5;
  const warningLines = spec.warning ? wrapText(spec.warning,font,11.5,mm(190)) : [];
  const warningHeight = warningLines.length ? warningLines.length*15+mm(3) : 0;
  const pageTop = (index:number) => mm(LIST_PRINT.top)-(index===0?warningHeight:0);
  const top = pageTop(0); const bottom = mm(LIST_PRINT.bottom) - unused;
  type Item = { lines: string[][]; alerts: boolean[]; height: number; muted: boolean; heading?: string[]; stripe: boolean };
  const prepare = (cells: string[], alerts: boolean[], muted: boolean, stripe: boolean): Item => {
    const lines = cells.map((cell, i) => wrapText(cell, heavy(cell, alerts[i]) ? bold : font, size, mm(spec.columns[i].width) - pad * 2));
    const height = Math.max(...lines.map(list => list.length)) * leading + pad * 2;
    if (height > top - bottom) throw new Error(`「${cells[0]}」內容過長，無法放入一頁。`);
    return { lines, alerts, height, muted, stripe };
  };
  const prepared: Item[] = spec.rows.map((cells, row) => prepare(cells, cells.map((_, i) => Boolean(spec.alerts?.[row]?.[i])), false, row % 2 === 1));
  if (spec.tail?.rows.length) {
    const heading = wrapText(spec.tail.heading, font, size, mm(190) - pad * 2);
    prepared.push({ lines: [], alerts: [], height: heading.length * leading + pad * 4, muted: true, heading, stripe: false });
    prepared.push(...spec.tail.rows.map((cells, row) => prepare(cells, cells.map(() => false), true, row % 2 === 1)));
  }
  // A whole row always stays on one page, and the tail heading stays with its first row.
  const groups: Item[][] = []; let group: Item[] = []; let available = top - bottom;
  for (const [index, item] of prepared.entries()) {
    const need = item.heading ? item.height + (prepared[index + 1]?.height ?? 0) : item.height;
    if (need > available && group.length) { groups.push(group); group = []; available = pageTop(groups.length) - bottom; }
    group.push(item); available -= item.height;
  }
  if (group.length || !groups.length) groups.push(group);
  const line = (page: ReturnType<typeof document.addPage>, x0: number, y0: number, x1: number, y1: number) => page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: .45, color: rgb(.6, .65, .62) });
  for (let p = 0; p < groups.length; p++) {
    const page = document.addPage([mm(210), mm(297)]);
    page.drawText(spec.title, { x: mm(10), y: mm(283), size: 16, font, color: rgb(.12, .23, .2) });
    const top = pageTop(p);
    const meta = p===0 ? spec.meta.flatMap(text => wrapText(text, font, 8, mm(190))).slice(0, 3) : [];
    meta.forEach((text, i) => page.drawText(text, { x: mm(10), y: mm(277.5) - i * 10, size: 8, font }));
    if(p===0&&warningLines.length){
      page.pushOperators(pushGraphicsState(),setLineWidth(.3),setStrokingColor(rgb(.7,.12,.08)),setTextRenderingMode(TextRenderingMode.FillAndOutline));
      warningLines.forEach((text,i)=>page.drawText(text,{x:mm(10),y:mm(266)-11.5-i*15,size:11.5,font,color:rgb(.7,.12,.08)}));
      page.pushOperators(popGraphicsState());
    }
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
    if (groups[p].length) line(page, xs[0], headerTop, xs.at(-1)!, headerTop);
    for (const x of xs) if (groups[p].length) line(page, x, headerTop, x, top);
    for (const item of groups[p]) {
      const next = y - item.height;
      if (item.heading) {
        // The heading spans the whole table, so only the outer lines run beside it.
        item.heading.forEach((text, i) => page.drawText(text, { x: xs[0] + pad, y: y - pad * 2 - size * .88 - i * leading, size, font, color: MUTED }));
        line(page, xs[0], y, xs[0], next); line(page, xs.at(-1)!, y, xs.at(-1)!, next);
      } else {
        if (item.stripe) page.drawRectangle({ x: xs[0], y: next, width: mm(190), height: item.height, color: rgb(.92, .95, .93) });
        item.lines.forEach((cellLines, column) => cellLines.forEach((text, i) => {
          const right = spec.columns[column].align === 'right'; const face = heavy(text, item.alerts[column]) ? bold : font;
          const x = right ? xs[column + 1] - pad - face.widthOfTextAtSize(text, size) : xs[column] + pad; const base = y - pad - size * .88 - i * leading;
          if (item.alerts[column] && face === font) {
            const word = i === 0 && text.startsWith(ALERT_WORD) ? ALERT_WORD : '';
            if (word) page.drawText(word, { x, y: base, size, font, color: ALERT });
            page.drawText(text.slice(word.length), { x: x + font.widthOfTextAtSize(word, size), y: base, size, font, color: item.muted ? MUTED : undefined });
          } else page.drawText(text, { x, y: base, size, font: face, color: item.alerts[column] ? ALERT : item.muted ? MUTED : undefined });
        }));
        for (const x of xs) line(page, x, y, x, next);
      }
      line(page, xs[0], next, xs.at(-1)!, next); y = next;
    }
    noteLines.forEach((text, i) => page.drawText(text, { x: mm(10), y: mm(19) - unused - i * 8.5, size: 7, font }));
    const footer = `${p + 1} / ${groups.length}`;
    page.drawText(footer, { x: mm(200) - font.widthOfTextAtSize(footer, 8), y: mm(8), size: 8, font });
  }
  return { bytes: await document.save(), pageCount: groups.length, rowCount: spec.rows.length };
}
