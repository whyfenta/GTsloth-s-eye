import { canonicalQuantity, cleanProductName, normalizeOCR, type Box, type InventoryRow } from './model';
export type Span = { text: string; confidence: number; x0: number; y0: number; x1: number; y1: number };
export type Reading = { text: string; words: Span[]; lines: Span[]; confidence: number };
export type Layout = { sku: [number, number]; rawName: [number, number]; location: [number, number]; bookQty: [number, number]; bodyTop: number };
const token = (text: string) => text.normalize('NFKC').replace(/[\s:：]/g, '');
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = old; }
  } return row[b.length];
}
export function headerCandidates(words: Span[], expected: string): Span[] {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0); const matches: (Span & { cost: number })[] = [];
  for (const start of sorted) {
    const sameLine = sorted.filter(w => Math.abs((w.y0 + w.y1) / 2 - (start.y0 + start.y1) / 2) < Math.max(8, (start.y1 - start.y0) * .7) && w.x0 >= start.x0).sort((a, b) => a.x0 - b.x0);
    for (let count = 1; count <= Math.min(6, sameLine.length); count++) {
      const selected = sameLine.slice(0, count); const text = token(selected.map(w => w.text).join(''));
      if (text.length > expected.length + 1) break;
      const cost = distance(text, expected); if (cost <= (expected.length >= 3 ? 1 : 0)) matches.push({
        text, confidence: Math.min(...selected.map(w => w.confidence)), x0: selected[0].x0, x1: selected.at(-1)!.x1,
        y0: Math.min(...selected.map(w => w.y0)), y1: Math.max(...selected.map(w => w.y1)), cost,
      });
    }
  }
  return matches.sort((a, b) => a.cost - b.cost || a.y0 - b.y0);
}
export function headerAnchor(words: Span[], expected: string): Span | undefined {
  return headerCandidates(words, expected)[0];
}
export function detectLayout(reading: Reading, width: number, height: number, additional: Reading[] = []): Layout | null {
  // A narrow line can repair one heading while damaging another. Keep each
  // OCR pass separate so duplicate words cannot form a fabricated heading.
  const candidates = (expected: string) => [reading, ...additional]
    .flatMap(r => headerCandidates(r.words, expected));
  const rank = (expected: string, referenceY?: number) => candidates(expected)
    .sort((a, b) => distance(token(a.text), expected) - distance(token(b.text), expected)
      || (referenceY === undefined ? 0 : Math.abs((a.y0 + a.y1) / 2 - referenceY) - Math.abs((b.y0 + b.y1) / 2 - referenceY))
      || b.confidence - a.confidence || a.y0 - b.y0)[0];
  // A report-sort label can repeat a real heading (for example
  // "庫別＋儲位＋商品") above the table. Once the SKU header is found, every
  // other heading must favour its own occurrence on that same header line.
  const sku = rank('商品代號');
  const headerY = sku ? (sku.y0 + sku.y1) / 2 : undefined;
  const name = rank('名稱', headerY);
  const international = rank('國際條碼', headerY);
  const location = rank('儲位', headerY);
  const quantity = rank('庫存量', headerY);
  const consigned = rank('寄庫量', headerY);
  const abbreviation = rank('簡稱', headerY);
  if (!sku || !name || !international || !location || !quantity) return null;
  const cy = (span: Span) => (span.y0 + span.y1) / 2; const cx = (span: Span) => (span.x0 + span.x1) / 2;
  if (!(sku.x0 < name.x0 && name.x0 < international.x0 && international.x0 < location.x0 && location.x0 < quantity.x0)) return null;
  if (Math.max(...[sku, name, international, location, quantity].map(cy)) - Math.min(...[sku, name, international, location, quantity].map(cy)) > height * .035) return null;
  const rightLoc = (cx(location) + cx(quantity)) / 2;
  return {
    sku: [Math.max(0, sku.x0 / width - .012), ((sku.x1 + name.x0) / 2) / width],
    rawName: [Math.max(0, name.x0 / width - .008), (international.x0 - width * .006) / width],
    location: [Math.max(abbreviation ? abbreviation.x1 : international.x1, location.x0 - width * .006) / width, rightLoc / width],
    bookQty: [rightLoc / width, (consigned ? (cx(quantity) + cx(consigned)) / 2 : quantity.x1 + width * .012) / width],
    bodyTop: (Math.max(sku.y1, name.y1, international.y1, location.y1, quantity.y1) + height * .008) / height,
  };
}
export const LOW_QUALITY = { rawName: 60, location: 40 };
export const POOR_NAME = '名稱辨識品質差，請逐字核對原圖'; export const POOR_LOCATION = '儲位辨識品質差，請核對原圖';
export const LOCATION_OVERFLOW = '儲位可能延伸到庫存量欄，已依空白取出帳量，請核對儲位與原圖';
/**
 * OCR may put a location tail and a quantity in the same crop. Only a wide
 * final gap is a safe delimiter; ordinary spaces in a grouped quantity stay invalid.
 */
export function splitTrailingQuantity(words: Span[]): { quantity: string; overflow: Span[]; quantityX0: number } | undefined {
  const ordered = [...words].filter(word => word.text.trim()).sort((a, b) => a.x0 - b.x0);
  for (let index = ordered.length - 2; index >= 0; index--) {
    const left = ordered[index]; const right = ordered[index + 1];
    const height = Math.max(left.y1 - left.y0, right.y1 - right.y0);
    if (right.x0 - left.x1 < height * .6) continue;
    const quantity = canonicalQuantity(ordered.slice(index + 1).map(word => word.text).join(''));
    if (quantity !== null) return { quantity, overflow: ordered.slice(0, index + 1), quantityX0: right.x0 };
    break;
  }
  return undefined;
}
export function extractRows(page: number, width: number, height: number, layout: Layout, readings: Record<'codesA'|'codesB'|'names'|'locations'|'qtyA'|'qtyB', Reading>, exact = false, bodyBottom = .967): InventoryRow[] {
  // exact: text read from the PDF itself, so only a true six-digit code starts a row.
  // bodyBottom: table end as a fraction of height; scans use a fixed margin, text pages the subtotal/footer line.
  const inBody = (l: Span) => l.y0 / height >= layout.bodyTop - .01 && l.y1 / height < bodyBottom;
  const primary = readings.codesA.lines.filter(l => (exact ? /^\d{6}$/ : /\d{4,}/).test(token(l.text)) && inBody(l));
  // A code missed by the first pass would silently merge two products into
  // one row, so codes only the second pass found become anchors too.
  const overlaps = (a: Span, b: Span) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > Math.min(a.y1 - a.y0, b.y1 - b.y0) * .4;
  const recovered = readings.codesB.lines.filter(l => /^\d{6}$/.test(token(l.text)) && inBody(l) && !primary.some(a => overlaps(a, l)));
  const anchors = [...primary, ...recovered].sort((a, b) => a.y0 - b.y0);
  const rows: InventoryRow[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]; const center = (anchor.y0 + anchor.y1) / 2;
    const prev = anchors[i - 1]; const next = anchors[i + 1];
    const top = prev ? ((prev.y0 + prev.y1) / 2 + center) / 2 : Math.max(layout.bodyTop * height, anchor.y0 - (anchor.y1 - anchor.y0) * .5);
    const bottom = next ? (center + (next.y0 + next.y1) / 2) / 2 : Math.min(height * (bodyBottom - .002), anchor.y1 + (prev ? (center - (prev.y0 + prev.y1) / 2) / 2 : 40));
    const near = (r: Reading) => r.lines.filter(l => (l.y0 + l.y1) / 2 >= top && (l.y0 + l.y1) / 2 < bottom).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const text = (r: Reading) => normalizeOCR(near(r).map(l => l.text).join(' '));
    const conf = (r: Reading) => { const lines = near(r); return lines.length ? Math.min(...lines.map(l => l.confidence)) : 0; };
    const sku = token(anchor.text); const secondarySKU = token(text(readings.codesB));
    const nameLines = near(readings.names);
    // The final product has no next SKU to establish its row height. Extend
    // consecutive name lines only; quantity/footer rows keep their own bounds.
    if (!next && nameLines.length) {
      const tail = readings.names.lines.filter(l => (l.y0+l.y1)/2 >= bottom).sort((a,b)=>a.y0-b.y0);
      for (const line of tail) {
        const previous = nameLines.at(-1)!;
        if (/^(?:庫別.*小計|總計|報表|列印|頁次)/.test(token(line.text))) break;
        if (line.y0 - previous.y1 > Math.max(previous.y1-previous.y0, anchor.y1-anchor.y0)*2) break;
        nameLines.push(line);
      }
    }
    const rawName = normalizeOCR(nameLines.map(l=>l.text).join(' ')); const cleaned = cleanProductName(rawName, exact);
    const nearWords = (r: Reading) => r.words.filter(word => (word.y0 + word.y1) / 2 >= top && (word.y0 + word.y1) / 2 < bottom).sort((a, b) => a.x0 - b.x0);
    const splitA = exact ? undefined : splitTrailingQuantity(nearWords(readings.qtyA));
    const splitB = exact ? undefined : splitTrailingQuantity(nearWords(readings.qtyB));
    const rawQty = splitA?.quantity ?? text(readings.qtyA); const qty = canonicalQuantity(rawQty);
    const rawQtyB = splitB?.quantity ?? text(readings.qtyB); const qtyB = canonicalQuantity(rawQtyB);
    // A short number with no name and no quantity is a report line such as "庫別: 0026", not a product;
    // keeping it would create a row with an invalid code that blocks export.
    if (!/^\d{6}$/.test(sku) && !rawName && qty === null && qtyB === null) continue;
    const location = normalizeOCR(text(readings.locations)); const issues: string[] = [];
    if (!/^\d{6}$/.test(sku)) issues.push('代號不是六位數');
    if (recovered.includes(anchor)) issues.push('代號只在第二次辨識讀到，請確認這一列');
    const qtyLines = near(readings.qtyA).filter(l => /\d/.test(l.text));
    const codeLines = near(readings.codesB).filter(l => /^\d{6}$/.test(token(l.text)));
    if (qtyLines.length > 1 || codeLines.length > 1) issues.push('此列範圍內有多個代號或庫存量，可能合併了兩筆商品');
    if (splitA || splitB) issues.push(LOCATION_OVERFLOW);
    if (sku !== secondarySKU) issues.push('代號兩次辨識不一致');
    if (qty === null) issues.push('庫存量格式待確認');
    if (qty !== qtyB || qtyB === null) issues.push('庫存量兩次辨識不一致');
    if (/^\d{1,3}\.\d{3}$/.test(rawQty)) issues.push('小數點或千分位符號待確認');
    if (cleaned.uncertain) issues.push('名稱前綴無法完整解析');
    issues.push(...cleaned.notes);
    const confidence = { sku: anchor.confidence, rawName: nameLines.length ? Math.min(...nameLines.map(l=>l.confidence)) : 0, location: conf(readings.locations), bookQty: conf(readings.qtyA) };
    // Name/location scores only mean something at the low end: on two scans (83 rows) 35 of 36
    // names below 60 were wrong, while above the thresholds right and wrong were mixed, so no note.
    // Code/quantity notes are replaced by the per-cell vote.
    if (!exact) {
      for (const [field, label] of [['sku','代號'],['bookQty','庫存量']] as const) if (confidence[field] < 90) issues.push(label + '辨識信心偏低');
      if (confidence.rawName < LOW_QUALITY.rawName) issues.push(POOR_NAME);
      if (location && confidence.location < LOW_QUALITY.location) issues.push(POOR_LOCATION);
    }
    const box = (range: [number, number]): Box => ({ x: range[0], y: top / height, width: range[1] - range[0], height: (bottom - top) / height });
    const quantityStart = splitA ?? splitB;
    const quantityBox = quantityStart ? (() => { const charHeight = Math.max(...quantityStart.overflow.map(word => word.y1 - word.y0)); const from = Math.max(layout.bookQty[0], (quantityStart.quantityX0 - charHeight * .3) / width); return box([from, layout.bookQty[1]]); })() : box(layout.bookQty);
    rows.push({ id: `${page}-${i}`, page, sku, rawName, name: cleaned.name, location, bookQty: qty ?? rawQty,
      boxes: { sku: box(layout.sku), rawName: { ...box(layout.rawName), height: (Math.max(bottom,...nameLines.map(l=>l.y1))-top)/height }, location: box(layout.location), bookQty: quantityBox }, confidence, issues, reviewed: false, attention: false,
      ...(exact ? {} : { ocrReadings: { sku: [sku, secondarySKU] as [string, string], bookQty: [qty, qtyB] as [string | null, string | null] } }) });
  }
  return rows;
}
export function continuationValid(rows: InventoryRow[], headerText: string): boolean {
  if (!rows.length || !rows.some(r => /^\d{6}$/.test(r.sku))) return false;
  const structured = rows.filter(r => r.rawName.length >= 3 && canonicalQuantity(r.bookQty) !== null).length / rows.length;
  const reportCue = /庫別|庫存|報表|列印|頁次/.test(token(headerText));
  const prefixCue = rows.filter(r => /C\s*[-&]/i.test(r.rawName)).length / rows.length >= .4;
  return structured >= .75 && (reportCue || prefixCue);
}
