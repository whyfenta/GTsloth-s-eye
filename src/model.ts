export type Field = 'sku' | 'rawName' | 'location' | 'bookQty';
export type Box = { x: number; y: number; width: number; height: number };
export type InventoryRow = {
  id: string; page: number; sku: string; rawName: string; name: string;
  location: string; bookQty: string; boxes: Record<Field, Box>;
  confidence: Record<Field, number>; issues: string[]; reviewed: boolean;
  /** Once a row needs attention, it remains in the consolidated review queue. */
  attention: boolean;
  /** Files represented by this occurrence after cross-file deduplication. */
  sourceFiles?: number[];
  /** OCR only: the two column-pass readings, later joined by per-cell readings in a vote. */
  ocrReadings?: { sku: [string, string]; bookQty: [string | null, string | null] };
  /** OCR only: fields the vote could not settle, with the candidates and an image of the cell for the reviewer. */
  numberDoubts?: Partial<Record<'sku' | 'bookQty', { candidates: string[]; image: string }>>;
};
export type PageReport = {
  page: number; width: number; height: number; rotation: number; deskew: number;
  status: 'accepted' | 'rejected'; reason: string; rowCount: number; skippedZero: number; storeName: string;
  /** text: read from the PDF text layer (exact); ocr: recognised from the image. */
  mode?: 'text' | 'ocr';
  /** Rows of this page already read from another file (same code, location and quantity), so not kept twice. */
  duplicates?: number;
};
export type JobState = 'idle' | 'loading' | 'running' | 'paused' | 'cancelled' | 'complete' | 'error';
export type SortMode = 'sku' | 'location';
// Public assets resolve against Vite's base, so the site also works under a sub-path.
export const asset = (path: string) => (import.meta.env?.BASE_URL ?? '/') + 'assets/' + path;
export const LIMITS = { pages: 200, bytes: 200 * 1024 * 1024, dpi: 300, longestEdge: 4000 };

export function normalizeOCR(text: string): string {
  // The report prints no spaces next to Chinese text; OCR adds them. Spaces
  // between Latin words or numbers (XANAX XR, 40MG 0.4ML) are real and kept.
  return text.normalize('NFKC').replace(/\r/g, '').replace(/\s*\n\s*/g, ' ')
    .replace(/\s+(?=\p{Script=Han})|(?<=\p{Script=Han})\s+/gu, '')
    .replace(/\s*([/()&:[\]])\s*/g, '$1').replace(/[ \t]+/g, ' ').trim();
}

const unit = '(?:粒|錠|顆|片|丸|包|支|管|瓶|盒|箱|袋|罐|排|板|組|套|卷|貼|枚|個|封|捆|聯|徘|公克|毫升|g|ml|mL)'; // 徘 is the report's source typo for 排.
const packageCore = '\\d+(?:\\.\\d+)?\\s*' + unit + '\\s*[/／]{1,2}\\s*' + unit;
// Inner groups may omit the first unit: "980粒/盒(14/排)".
const packagePattern = new RegExp('^' + packageCore + '(?:\\s*\\(\\s*\\d+(?:\\.\\d+)?\\s*' + unit + '?\\s*[/／]{1,2}\\s*' + unit + '\\s*\\))*\\s*[:：]?', 'i');
const dateCore = '\\d{4}\\s*[.\\-/年]\\s*(?:0?[1-9]|1[0-2])(?:\\s*[.\\-/月]\\s*(?:0?[1-9]|[12]\\d|3[01]))?\\s*(?:月|日)?';
const datePattern = '(?:\\(\\s*'+dateCore+'\\s*\\)|'+dateCore+'(?!\\d))';
const statusWords = '(?:停供|停售|不售|追追|追禁售|禁售|禁請|換包|冷藏|避光|近效|缺貨|自費|公費|限店|客訂|客處|[!！])';
// OCR leaves "-" for damaged markers such as 冷藏-(紅); exact text can consume it.
const statusPattern = (exact: boolean) => new RegExp('^' + statusWords + '\\s*(?:' + datePattern + ')?\\s*' +
  (exact ? '[:：,，-]?' : '(?:[:：,，]|-(?=\\s*[ABC]\\s*-))?') + '\\s*');
// Short tag right after the marker, e.g. C-(紅) / C-(贈藥) / C-(停產-不得製造) / C-(藥證已註銷).
const tag = '\\(\\s*\\p{Script=Han}[\\p{Script=Han}-]{0,8}\\s*\\)';
const markerTail = '\\s*-\\s*[&:：,，、]*\\s*(?:' + datePattern + ')?\\s*[-&:：,，、]*\\s*(?:' + tag + ')?\\s*[&:：,，、]*\\s*';
// The report prints its C- class marker before every name (C-&100粒/盒, C-SERETIDE...).
const markerPattern = new RegExp('^C' + markerTail, 'iu');
// A- / B- are the same marker for other classes; only accepted after a status (自費B-, !避光A-).
const letterMarkerPattern = new RegExp('^[AB]' + markerTail, 'u');
// OCR often reads the C of "C-" as ( [ l or drops it. Only accept that damaged
// form when a tag or a package spec follows, so a real "X-NAME" is never eaten.
const damagedMarkerPattern = new RegExp('^(?:[([{|lLI1]\\s*)?-+\\s*(?:' + tag + '\\s*|(?=' + packageCore + '))', 'iu');
// Unrecognised status text directly before the marker (e.g. OCR-damaged 追禁售).
const unknownStatusPattern = /^\p{Script=Han}{1,6}(?=\s*[ABC]\s*-)/u;
// Right after the C- marker the report always prints the package spec, so an
// OCR-damaged unit there ("1000粒/會", "100層/瓶") is still that spec.
// The container after "/" is one character, so the name's first character is never eaten.
const fuzzyPackage = '\\d+(?:\\.\\d+)?\\s*\\p{Script=Han}{1,2}\\s*[/／]{1,2}\\s*\\p{Script=Han}';
const fuzzyPackagePattern = new RegExp('^' + fuzzyPackage + '(?:\\s*\\(\\s*' + fuzzyPackage + '\\s*\\))*\\s*[:：]?', 'u');
// The inner "(10粒/排)" group right after a package spec, possibly OCR-damaged.
const innerPackagePattern = new RegExp('^(?:\\(\\s*' + fuzzyPackage + '\\s*\\)\\s*)+[:：]?', 'u');
// A tag + package left at the start means the marker before it was not recognised.
const leftoverPrefixPattern = new RegExp('^' + tag + '\\s*' + packageCore, 'iu');
// Trailing price / reimbursement tags are not part of the name. Only a whole tag is removed, also inside
// a tag chain: "(管4)-高價藥-診所用" keeps "-診所用"; "-高價藥組" is not a tag.
const tagSuffixPattern = /\s*-\s*(?:高健保|高價藥)(?=\s*(?:-|$))/gu;

export type CleanResult = { name: string; removed: string[]; uncertain: boolean; notes: string[]; kept?: string[] };
/**
 * Removes the leading status / marker / package prefix and the trailing -高健保 / -高價藥 tags. exact: the name came
 * from the PDF text layer, so the OCR-damage repairs are not applied. keep: status words that are taken out of the
 * prefix like any other but printed again before the name (management keeps 缺貨); the inventory sheet keeps none.
 */
export function cleanProductName(raw: string, exact = false, keep: readonly string[] = []): CleanResult {
  let name = normalizeOCR(raw); const removed: string[] = []; const notes: string[] = []; const kept: string[] = [];
  let statusRemoved = false; let afterMarker = false; let afterPackage = false;
  for (let i = 0; i < 20; i++) {
    let found = name.match(statusPattern(exact)); let marker = false; let pack = false;
    if (found?.[0]) { statusRemoved = true; const word = keep.find(w => found![0].startsWith(w)); if (word && !kept.includes(word)) kept.push(word); }
    else if ((found = name.match(markerPattern))?.[0] || (statusRemoved && (found = name.match(letterMarkerPattern))?.[0])) marker = true;
    else if (!exact && (found = name.match(damagedMarkerPattern))?.[0]) { marker = true; notes.push(`前綴標記疑似誤辨「${found[0].trim()}」，已依格式移除，請確認`); }
    else if ((found = name.match(unknownStatusPattern))?.[0]) notes.push(`前綴含未知狀態文字「${found[0]}」，已移除，請確認`);
    else if ((found = name.match(packagePattern))?.[0]) pack = true;
    else if (!exact && ((afterMarker && (found = name.match(fuzzyPackagePattern))?.[0]) || (afterPackage && (found = name.match(innerPackagePattern))?.[0]))) {
      pack = true; notes.push(`包裝規格疑似誤辨「${found![0].trim()}」，已依格式移除，請確認`);
    }
    if (!found?.[0]) break;
    removed.push(found[0]); name = name.slice(found[0].length).trim(); afterMarker = marker; afterPackage = pack;
  }
  const suffixes = (name.match(tagSuffixPattern) ?? []).map(suffix => suffix.trim()); name = name.replace(tagSuffixPattern, '').trim();
  // Only known leading tokens are consumed. A damaged token needs human review.
  const uncertain = !name || /^[&:：]/.test(name) || /^\d+\s*[\p{Script=Han}]+\s*[/／]/u.test(name) || /^\d{3,4}\s*[./-]\s*\d/.test(name) ||
    /^(?:C\s*[-&]|近[\p{Script=Han}]|[\p{Script=Han}]光)/u.test(name) || /^\(?-/.test(name) || /^\(\s*\d/.test(name) || leftoverPrefixPattern.test(name) ||
    /^[^A-Za-z]{0,15}\p{Script=Han}\s*[ABC]\s*-/u.test(name) ||
    // After a removed prefix, "L-XALACOM" is usually an OCR-misread "C-"; exact text has real names like U-CA.
    (!exact && removed.length > 0 && /^[A-Za-z([{|]\s*-/.test(name));
  if (kept.length) return { name: name ? `${kept.join('')} ${name}` : kept.join(''), removed: [...removed, ...suffixes], uncertain, notes, kept };
  return { name, removed: [...removed, ...suffixes], uncertain, notes };
}

export function canonicalQuantity(text: string): string | null {
  // Inner whitespace is never removed: "12 34" may be two merged rows.
  const value = text.normalize('NFKC').trim();
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return null;
  return value.replace(/,/g, '').replace(/^(-?)0+(?=\d)/, '$1');
}
export function formatQuantity(value: string): string {
  const canonical = canonicalQuantity(value); if (canonical === null) return value;
  const [whole, fraction] = canonical.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : '.' + fraction);
}
/** True only for a syntactically valid numeric quantity below zero. */
export function isNegativeQuantity(value: string): boolean {
  const canonical = canonicalQuantity(value);
  return canonical !== null && Number(canonical) < 0;
}
/** True only for a syntactically valid numeric quantity whose value is zero. */
export function isZeroQuantity(value: string): boolean {
  const canonical = canonicalQuantity(value);
  return canonical !== null && Number(canonical) === 0;
}
/** Recognition-time zeroes with no quantity uncertainty never need review or output. */
export function dropZeroRows(rows: InventoryRow[]): { kept: InventoryRow[]; skipped: InventoryRow[] } {
  const kept: InventoryRow[] = []; const skipped: InventoryRow[] = [];
  for (const row of rows) {
    const uncertainQuantity = Boolean(row.numberDoubts?.bookQty) || row.issues.some(issue => /庫存量|可能合併/.test(issue));
    (isZeroQuantity(row.bookQty) && !uncertainQuantity ? skipped : kept).push(row);
  }
  return { kept, skipped };
}
export function validationErrors(row: Pick<InventoryRow, 'sku' | 'name' | 'bookQty'>): string[] {
  const issues: string[] = [];
  if (!/^\d{6}$/.test(row.sku)) issues.push('商品代號必須是六位數，不可省略前導零');
  if (!row.name.trim()) issues.push('名稱不可空白');
  if (canonicalQuantity(row.bookQty) === null) issues.push('帳量格式不正確，請對照庫存量欄');
  return issues;
}
// Notes about a prefix already removed by its format do not require human review.
const infoOnly = /已依格式移除|已移除，請確認/;
/** A row that belongs in the consolidated doubt view. */
export function hasDoubt(row: Pick<InventoryRow, 'issues' | 'numberDoubts' | 'sku' | 'name' | 'bookQty'>): boolean {
  return row.issues.some(issue => !infoOnly.test(issue)) || Boolean(row.numberDoubts?.sku || row.numberDoubts?.bookQty) || validationErrors(row).length > 0;
}
/** Admit a newly recognised row once; later edits set attention but never clear it. */
export function admit(rows: InventoryRow[]): InventoryRow[] {
  for (const row of rows) { if (hasDoubt(row)) row.attention = true; row.reviewed = !row.attention; }
  return rows;
}
// Rows with these issues must be confirmed one by one; "confirm page" skips them.
const individualIssue = /名稱前綴無法完整解析|可能合併|代號不是六位數|代號只在|多次辨識不一致|同代號同儲位/;
export function needsIndividualReview(row: Pick<InventoryRow, 'issues'>): boolean {
  return row.issues.some(issue => individualIssue.test(issue));
}
export function canExport(rows: InventoryRow[], pages: PageReport[], complete: boolean): boolean {
  return complete && rows.length > 0 && pages.length > 0 && pages.every(p => p.status === 'accepted') &&
    rows.some(r => !isZeroQuantity(r.bookQty)) && rows.every(r => r.reviewed && validationErrors(r).length === 0);
}
/** Negative book quantities come first under either order, so they are checked before everything else. */
export function sortRows(rows: InventoryRow[], mode: SortMode): InventoryRow[] {
  const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
  const negative = new Set(rows.filter(row => isNegativeQuantity(row.bookQty)));
  return [...rows].sort((a, b) => {
    const sign = Number(negative.has(b)) - Number(negative.has(a)); if (sign) return sign;
    if (mode === 'location') {
      if (!a.location.trim() && b.location.trim()) return 1;
      if (a.location.trim() && !b.location.trim()) return -1;
      const location = collator.compare(a.location, b.location); if (location) return location;
    }
    return a.sku.localeCompare(b.sku) || a.page - b.page || a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}
export const emptyBox: Box = { x: 0, y: 0, width: 1, height: 1 };
const locationKey = (location: string) => location.normalize('NFKC').replace(/\s+/g, '');
/** One stock line: a complete code at one location. Rows without a valid code are never merged. */
const lineKey = (row: InventoryRow) => /^\d{6}$/.test(row.sku) ? row.sku + '\u0000' + locationKey(row.location) : undefined;
const sameQuantity = (a: InventoryRow, b: InventoryRow) => {
  const x = canonicalQuantity(a.bookQty), y = canonicalQuantity(b.bookQty);
  return x !== null && y !== null && Number(x) === Number(y);
};
export type MergeResult = { rows: InventoryRow[]; duplicates: number; conflicts: [InventoryRow, InventoryRow][] };
/**
 * Adds newly read rows to the kept rows. The same code at the same location read
 * from another file is the same stock line: with an equal quantity it is a
 * duplicate and only one reading is kept (the clearer one, unless the kept one
 * was already confirmed); with a different quantity both stay and are returned
 * as conflicts for review. Rows of one file are never merged with each other,
 * because every printed line of one report is its own record.
 */
export function mergeRows(kept: InventoryRow[], incoming: InventoryRow[], fileOf: (row: InventoryRow) => number): MergeResult {
  const rows = [...kept]; const conflicts: [InventoryRow, InventoryRow][] = []; let duplicates = 0;
  const lines = new Map<string, InventoryRow[]>();
  const add = (row: InventoryRow) => { const key = lineKey(row); if (key) { const list = lines.get(key); if (list) list.push(row); else lines.set(key, [row]); } };
  rows.forEach(add);
  for (const row of incoming) {
    const key = lineKey(row); const others = key ? (lines.get(key) ?? []).filter(other => fileOf(other) !== fileOf(row)) : [];
    const sources = row.sourceFiles ?? [fileOf(row)];
    const match = others.find(other => sameQuantity(row, other) &&
      sources.every(file => !(other.sourceFiles ?? [fileOf(other)]).includes(file)));
    if (match) {
      duplicates++;
      // One occurrence can represent at most one printed line from each file.
      // Keep provenance even when choosing a clearer reading or cloning for PDF output.
      const clearer = hasDoubt(match) && !hasDoubt(row) && !match.reviewed ? row : match;
      const merged = { ...clearer, sourceFiles: [...(match.sourceFiles ?? [fileOf(match)]), ...sources] };
      rows[rows.indexOf(match)] = merged; const list = lines.get(key!)!; list[list.indexOf(match)] = merged;
      continue;
    }
    for (const other of others) conflicts.push([row, other]);
    rows.push(row); add(row);
  }
  return { rows, duplicates, conflicts };
}
/** A store title for comparison: no spacing, width variants or printed date/time. */
export function storeKey(name: string): string {
  return name.normalize('NFKC').replace(/\d{3,4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?/g, '').replace(/\s+/g, '');
}
export type StoreCheck = { result: 'same'; name: string } | { result: 'different' } | { result: 'unsure' };
/**
 * Whether several files are reports of one store, from the store title on each
 * file's first page. Titles from PDF text are exact, so two different exact
 * titles are different stores. A missing title, or a difference that involves
 * an OCR reading, needs a person to confirm.
 */
export function compareStores(files: { storeName: string; exact: boolean }[]): StoreCheck {
  const keys = files.map(file => storeKey(file.storeName));
  if (keys.length && keys.every(key => key && key === keys[0])) return { result: 'same', name: files[0].storeName };
  const exact = new Set(keys.filter((key, i) => key && files[i].exact));
  return exact.size > 1 ? { result: 'different' } : { result: 'unsure' };
}
