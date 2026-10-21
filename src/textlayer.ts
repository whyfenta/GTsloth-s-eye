import type { InventoryRow, PageReport } from './model';
import { continuationValid, detectLayout, extractRows, type Layout, type Reading, type Span } from './parser';
import { printedDay } from './report-date';

// A PDF printed straight from the store system carries the report as real
// text. Reading it gives exact codes and quantities, so OCR is not needed.

export type TextItem = { str: string; transform: number[]; width: number };
export type TextPage = { items: TextItem[]; viewport: number[]; width: number; height: number; hasImages: boolean };
type TextSpan = Span & { run: number };
export type TextLayer = { chars: TextSpan[]; reading: Reading; rotation: number; width: number; height: number };

const multiply = (a: number[], b: number[]) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
// Report fonts (MingLiU etc.) print CJK at full width and ASCII at half width.
const advanceWeight = (char: string) => char.codePointAt(0)! >= 0x2e80 ? 2 : 1;

/** Groups character spans into lines, restoring word spaces from the gaps between them. */
export function linesOf(chars: Span[]): Span[] {
  const sorted = [...chars].sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0); const groups: Span[][] = [];
  for (const char of sorted) {
    const size = char.y1 - char.y0; const group = groups.find(g => Math.abs(g[0].y1 - char.y1) < size * .4);
    if (group) group.push(char); else groups.push([char]);
  }
  return groups.map(group => {
    group.sort((a, b) => a.x0 - b.x0); let text = '';
    group.forEach((char, i) => { if (i && char.x0 - group[i - 1].x1 > (char.y1 - char.y0) * .3) text += ' '; text += char.text; });
    return { text, confidence: 100, x0: Math.min(...group.map(c => c.x0)), x1: Math.max(...group.map(c => c.x1)), y0: Math.min(...group.map(c => c.y0)), y1: Math.max(...group.map(c => c.y1)) };
  }).sort((a, b) => a.y0 - b.y0);
}

/**
 * Converts pdf.js text items to per-character spans in upright page pixels.
 * If the text runs sideways on the page, the page is turned (rotation, using
 * rotateCanvas semantics) so the trace view and the OCR path see the same frame.
 */
export function textLayer(page: TextPage): TextLayer {
  const placed = page.items.map((item, run) => ({ item, run })).filter(({ item }) => item.str.trim()).map(({ item, run }) => {
    const m = multiply(page.viewport, item.transform); const length = Math.hypot(m[0], m[1]) || 1;
    return { item, run, dx: m[0] / length, dy: m[1] / length, size: Math.hypot(m[2], m[3]), x: m[4], y: m[5], advance: item.width * Math.hypot(page.viewport[0], page.viewport[1]) };
  });
  const votes = new Map<number, number>();
  for (const p of placed) { const turn = ((Math.round(-Math.atan2(p.dy, p.dx) / (Math.PI / 2)) * 90) % 360 + 360) % 360; votes.set(turn, (votes.get(turn) ?? 0) + p.item.str.length); }
  const rotation = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const radians = rotation * Math.PI / 180; const cos = Math.round(Math.cos(radians)); const sin = Math.round(Math.sin(radians));
  const width = rotation % 180 ? page.height : page.width; const height = rotation % 180 ? page.width : page.height;
  const turn = (x: number, y: number) => { const cx = x - page.width / 2, cy = y - page.height / 2; return [width / 2 + cx * cos - cy * sin, height / 2 + cx * sin + cy * cos]; };
  const chars: TextSpan[] = [];
  for (const p of placed) {
    const glyphs = Array.from(p.item.str); const total = glyphs.reduce((sum, g) => sum + advanceWeight(g), 0); let offset = 0;
    for (const glyph of glyphs) {
      const step = p.advance * advanceWeight(glyph) / total;
      if (glyph.trim()) {
        const [x0, base] = turn(p.x + p.dx * offset, p.y + p.dy * offset);
        chars.push({ text: glyph, confidence: 100, x0, x1: x0 + step, y0: base - p.size * .8, y1: base + p.size * .2, run: p.run });
      }
      offset += step;
    }
  }
  const lines = linesOf(chars);
  return { chars, rotation, width, height, reading: { text: lines.map(l => l.text).join('\n'), words: chars, lines, confidence: 100 } };
}

/** Text runs whose first non-space glyph starts inside [from, to). Runs are never split across columns. */
export function columnReading(layer: TextLayer, from: number, to: number, top: number, bottom: number): Reading {
  const starts = new Map<number, number>();
  for (const char of layer.chars) if (!starts.has(char.run)) starts.set(char.run, char.x0);
  const accepted = new Set([...starts].filter(([, x]) => x >= from && x < to).map(([run]) => run));
  const lines = linesOf(layer.chars.filter(c => accepted.has(c.run) && c.y0 >= top && c.y1 <= bottom));
  return { text: lines.map(l => l.text).join('\n'), words: [], lines, confidence: 100 };
}

/**
 * Extracts one text-layer page with the same header, row and prefix rules as
 * the OCR path. Returns undefined when the text is not a recognisable
 * inventory table, so the caller can fall back to OCR.
 */
export function extractTextPage(page: number, text: TextPage, previous?: Layout): { report: PageReport; rows: InventoryRow[]; layout?: Layout } | undefined {
  if (text.hasImages || !text.items.some(item => item.str.trim())) return undefined;
  const layer = textLayer(text); const { width, height } = layer;
  const found = detectLayout(layer.reading, width, height); const layout = found ?? (previous && { ...previous, bodyTop: .018 });
  if (!layout) return undefined;
  const top = layout.bodyTop * height;
  // The table ends at the subtotal or page footer, which the text layer locates exactly.
  const footer = layer.reading.lines.find(line => line.y0 > top && /庫別小計|總計|報表編號|列印時間|列印人員|頁次/.test(line.text.replace(/\s/g, '')));
  const bottom = footer ? footer.y0 : height;
  const column = (range: [number, number]) => columnReading(layer, range[0] * width, range[1] * width, top, bottom);
  const codes = column(layout.sku); const quantities = column(layout.bookQty);
  const rows = extractRows(page, width, height, layout, { codesA: codes, codesB: codes, names: column(layout.rawName), locations: column(layout.location), qtyA: quantities, qtyB: quantities }, true, bottom / height + .002);
  if (!continuationValid(rows, layer.reading.text)) return undefined;
  const title = layer.reading.lines.filter(line => line.y1 < height * .065 && !/庫存|報表|排序|庫別/.test(line.text.replace(/\s/g, ''))).sort((a, b) => a.y0 - b.y0)[0]?.text.replace(/\s+/g, '').trim() ?? '';
  return { rows, layout: found ?? undefined, report: { page, width, height, rotation: layer.rotation, deskew: 0, status: 'accepted', reason: '', rowCount: rows.length, skippedZero: 0, storeName: found ? title : '', mode: 'text', printed: printedDay(layer.reading.text) } };
}
