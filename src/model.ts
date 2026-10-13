export type Field = 'sku' | 'rawName' | 'location' | 'bookQty';
export type Box = { x: number; y: number; width: number; height: number };
export type InventoryRow = {
  id: string; page: number; sku: string; rawName: string; name: string;
  location: string; bookQty: string; boxes: Record<Field, Box>;
  confidence: Record<Field, number>; issues: string[]; reviewed: boolean;
  /** Once a row needs attention, it remains in the consolidated review queue. */
  attention: boolean;
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

export type CleanResult = { name: string; removed: string[]; uncertain: boolean; notes: string[] };
/**
 * Removes the leading status / marker / package prefix. exact: the name came
 * from the PDF text layer, so the OCR-damage repairs are not applied.
 */
export function cleanProductName(raw: string, exact = false): CleanResult {
  let name = normalizeOCR(raw); const removed: string[] = []; const notes: string[] = [];
  let statusRemoved = false; let afterMarker = false; let afterPackage = false;
  for (let i = 0; i < 20; i++) {
    let found = name.match(statusPattern(exact)); let marker = false; let pack = false;
    if (found?.[0]) statusRemoved = true;
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
  // Only known leading tokens are consumed. A damaged token needs human review.
  const uncertain = !name || /^[&:：]/.test(name) || /^\d+\s*[\p{Script=Han}]+\s*[/／]/u.test(name) || /^\d{3,4}\s*[./-]\s*\d/.test(name) ||
    /^(?:C\s*[-&]|近[\p{Script=Han}]|[\p{Script=Han}]光)/u.test(name) || /^\(?-/.test(name) || /^\(\s*\d/.test(name) || leftoverPrefixPattern.test(name) ||
    /^[^A-Za-z]{0,15}\p{Script=Han}\s*[ABC]\s*-/u.test(name) ||
    // After a removed prefix, "L-XALACOM" is usually an OCR-misread "C-"; exact text has real names like U-CA.
    (!exact && removed.length > 0 && /^[A-Za-z([{|]\s*-/.test(name));
  return { name, removed, uncertain, notes };
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
const individualIssue = /名稱前綴無法完整解析|可能合併|代號不是六位數|代號只在|多次辨識不一致/;
export function needsIndividualReview(row: Pick<InventoryRow, 'issues'>): boolean {
  return row.issues.some(issue => individualIssue.test(issue));
}
export function canExport(rows: InventoryRow[], pages: PageReport[], complete: boolean): boolean {
  return complete && rows.length > 0 && pages.length > 0 && pages.every(p => p.status === 'accepted') &&
    rows.some(r => !isZeroQuantity(r.bookQty)) && rows.every(r => r.reviewed && validationErrors(r).length === 0);
}
export function sortRows(rows: InventoryRow[], mode: SortMode): InventoryRow[] {
  const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
  return [...rows].sort((a, b) => {
    if (mode === 'location') {
      if (!a.location.trim() && b.location.trim()) return 1;
      if (a.location.trim() && !b.location.trim()) return -1;
      const location = collator.compare(a.location, b.location); if (location) return location;
    }
    return a.sku.localeCompare(b.sku) || a.page - b.page || a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}
export const emptyBox: Box = { x: 0, y: 0, width: 1, height: 1 };
