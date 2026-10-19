// 樹懶的管理: pure rules for the safety-stock, dead-stock and empty-slot lists.
// Nothing here touches the DOM, PDF.js or pdf-lib, so every rule is unit-tested on its own.
import { canonicalQuantity, cleanProductName } from './model';
/** Management keeps 缺貨 in front of the cleaned name; every other prefix is cleaned as on the inventory sheet. */
export const KEEP_STATUS = ['缺貨'] as const;
export const managementName = (raw: string) => cleanProductName(raw, true, KEEP_STATUS);

/** Exact fraction. Counts and quantities are decimals in the report; floats would turn 3754 into 3755 at a boundary. */
export type Frac = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
export function frac(n: bigint, d = 1n): Frac {
  if (d === 0n) throw new Error('除數為 0');
  if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g };
}
export const ZERO = frac(0n);
export const add = (a: Frac, b: Frac) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Frac, b: Frac) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Frac, b: Frac) => frac(a.n * b.n, a.d * b.d);
export const div = (a: Frac, b: Frac) => frac(a.n * b.d, a.d * b.n);
export const cmp = (a: Frac, b: Frac) => { const x = a.n * b.d, y = b.n * a.d; return x < y ? -1 : x > y ? 1 : 0; };
export function floor(a: Frac): bigint { const q = a.n / a.d; return a.n < 0n && q * a.d !== a.n ? q - 1n : q; }
export function ceil(a: Frac): bigint { return -floor(frac(-a.n, a.d)); }
/** Half away from zero is half up here: every value rounded is non-negative. */
export const roundHalfUp = (a: Frac) => floor(add(a, frac(1n, 2n)));
/** A decimal string such as "1,240" or "-2.5"; null when it is not a number. */
export function parseDecimal(text: string): Frac | null {
  const value = canonicalQuantity(text); if (value === null) return null;
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const result = frac(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
  return value.startsWith('-') ? frac(-result.n, result.d) : result;
}
/** At most `digits` decimals, half up, trailing zeros removed: 41.25, 1072.5, 3. */
export function formatFrac(a: Frac, digits = 2): string {
  const scale = 10n ** BigInt(digits); const negative = a.n < 0n;
  const scaled = roundHalfUp(mul(frac(negative ? -a.n : a.n, a.d), frac(scale)));
  const whole = scaled / scale; const fraction = (scaled % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  const text = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
  return negative && scaled ? '-' + text : text;
}
export const fracNumber = (a: Frac) => Number(a.n) / Number(a.d);

// ---- Calendar months -------------------------------------------------------
export type Day = { y: number; m: number; d: number };
export function parseDay(text: string): Day | null {
  const match = text.match(/^(\d{4})[/-]?(\d{2})[/-]?(\d{2})$/); if (!match) return null;
  const day = { y: +match[1], m: +match[2], d: +match[3] };
  return day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= daysInMonth(day.y, day.m) ? day : null;
}
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const serial = (day: Day) => Date.UTC(day.y, day.m - 1, day.d) / 86_400_000;
const fromSerial = (n: number): Day => { const date = new Date(n * 86_400_000); return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }; };
/** The k-th monthly anchor of a period: the start's own day number, cut to the end of shorter months (1/31 → 2/28 → 3/31). */
function anchor(start: Day, k: number): Day {
  const index = start.m - 1 + k; const y = start.y + Math.floor(index / 12); const m = index % 12 + 1;
  return { y, m, d: Math.min(start.d, daysInMonth(y, m)) };
}
export const formatDay = (day: Day) => `${day.y}/${String(day.m).padStart(2, '0')}/${String(day.d).padStart(2, '0')}`;
/**
 * Calendar months of an inclusive period, as the interval [start, end + 1 day). Whole months are counted from the
 * start's monthly anchors; the remaining days are divided by the length of that anchor's month segment.
 * 2026/06/16 – 2026/10/15 is exactly 4. Never a fixed 30-day month.
 */
export function statMonths(start: Day, end: Day): Frac | null {
  const stop = serial(end) + 1; if (stop <= serial(start)) return null;
  let whole = 0; while (serial(anchor(start, whole + 1)) <= stop) whole++;
  const from = serial(anchor(start, whole)); const segment = serial(anchor(start, whole + 1)) - from;
  return add(frac(BigInt(whole)), frac(BigInt(stop - from), BigInt(segment)));
}
/** Dead-stock and empty-slot lists need a period strictly longer than 2.5 months. */
export const LONG_PERIOD = frac(5n, 2n);
export const longPeriod = (months: Frac) => cmp(months, LONG_PERIOD) > 0;
export const nextDay = (day: Day) => fromSerial(serial(day) + 1);
export const dayBefore = (a: Day, b: Day) => serial(a) < serial(b);

// ---- Stores ----------------------------------------------------------------
export type StoreId = { number?: number; core: string; label: string };
/** The leading store number of a title such as "26永和福和店" or "26北-永和福和店", and the name without number and region. */
export function storeId(label: string, code?: string): StoreId {
  const text = label.normalize('NFKC').replace(/\s+/g, '');
  const lead = text.match(/^(\d{1,4})(?!\d)/)?.[1]; const fromCode = code && /^\d{1,6}$/.test(code) ? Number(code) : undefined;
  const fromName = lead ? Number(lead) : undefined;
  // Conflicting evidence inside one title is never resolved silently.
  const number = fromCode !== undefined && fromName !== undefined && fromCode !== fromName ? NaN : fromCode ?? fromName;
  const core = text.replace(/^\d+/, '').replace(/^\p{Script=Han}{1,2}-/u, '');
  return { number, core, label: label.trim() };
}
export type StoreMatch = 'same' | 'different' | 'unsure';
/**
 * Two printed store titles are the same store when both carry the same store number and the same name.
 * Different numbers are different stores, which no confirmation can override; anything else needs a person.
 */
export function matchStores(a: StoreId, b: StoreId): StoreMatch {
  if (Number.isNaN(a.number) || Number.isNaN(b.number)) return 'different';
  if (a.number !== undefined && b.number !== undefined) {
    if (a.number !== b.number) return 'different';
    if (a.core && a.core === b.core) return 'same';
  }
  return 'unsure';
}

// ---- Source pages ----------------------------------------------------------
/** One page of one imported report. reportPage / reportTotal are the report's own "page n of total". */
export type ReportPage = { key: string; file: number; filePage: number; reportPage: number; reportTotal: number; signature: string; meta: string };
export type Assembly<P extends ReportPage> = { pages: P[]; duplicates: P[]; conflicts: [P, P][]; missing: number[]; totals: number[]; metas: string[] };
/**
 * Puts the pages of one report in order. A page read twice with exactly the same content is a duplicate import and
 * is used once; the same page number with different content blocks the calculation. Missing numbers are reported.
 */
export function assemble<P extends ReportPage>(input: P[]): Assembly<P> {
  const byNumber = new Map<number, P>(); const duplicates: P[] = []; const conflicts: [P, P][] = [];
  for (const page of [...input].sort((a, b) => a.file - b.file || a.filePage - b.filePage)) {
    const seen = byNumber.get(page.reportPage);
    if (!seen) byNumber.set(page.reportPage, page);
    else if (seen.signature === page.signature) duplicates.push(page);
    else conflicts.push([seen, page]);
  }
  const totals = [...new Set(input.map(page => page.reportTotal))]; const metas = [...new Set(input.map(page => page.meta))];
  const total = Math.max(0, ...totals); const missing: number[] = [];
  for (let n = 1; n <= total; n++) if (!byNumber.has(n)) missing.push(n);
  return { pages: [...byNumber.values()].sort((a, b) => a.reportPage - b.reportPage), duplicates, conflicts, missing, totals, metas };
}
export const assemblyComplete = (a: Assembly<ReportPage>) => a.pages.length > 0 && !a.conflicts.length && !a.missing.length && a.totals.length === 1 && a.metas.length === 1;

// ---- Rows ------------------------------------------------------------------
/** Where a row was printed: file index, page inside the file, report page number and its band on the upright page (0..1). */
export type Origin = { file: number; filePage: number; reportPage: number; top: number; bottom: number };
export type UsageRow = { id: string; origin: Origin; sku: string; rawName: string; unit: string; count: string; quantity: string;
  /** Parser notes, such as two values in one column. */
  notes: string[]; reviewed: boolean; excluded?: string };
export type StockRow = { id: string; origin: Origin; sku: string; rawName: string; name: string; location: string; qty: string;
  notes: string[]; reviewed: boolean; excluded?: string };
export const SIX = /^\d{6}$/;
const count = (text: string) => /^\d+$/.test(text.normalize('NFKC').replace(/,/g, '').trim());
/** Problems that keep a usage row out of the calculation until it is corrected or excluded with a reason. */
export function usageErrors(row: UsageRow): string[] {
  const errors: string[] = []; const c = parseDecimal(row.count); const q = parseDecimal(row.quantity);
  if (!SIX.test(row.sku)) errors.push(row.sku ? '醫品編號不是六碼' : '缺少醫品編號');
  if (c === null) errors.push(row.count ? '次數格式不正確' : '缺少次數');
  else if (c.n < 0n) errors.push('次數為負數'); else if (!count(row.count)) errors.push('次數必須是整數');
  if (q === null) errors.push(row.quantity ? '數量格式不正確' : '缺少數量'); else if (q.n < 0n) errors.push('數量為負數');
  if (!row.unit.trim()) errors.push('缺少單位');
  if (!row.rawName.trim()) errors.push('缺少醫品名稱');
  return errors;
}
export function stockErrors(row: StockRow): string[] {
  const errors: string[] = [];
  if (!SIX.test(row.sku)) errors.push('商品代號不是六碼');
  if (parseDecimal(row.qty) === null) errors.push('庫存量格式不正確');
  if (!row.name.trim()) errors.push('清理後名稱空白');
  return errors;
}
/** Rows with non-six-digit codes such as R001 are not products: they are kept as excluded records and never counted in N. */
export function autoExclusion(sku: string): string | undefined {
  const code = sku.normalize('NFKC').trim(); return code && !SIX.test(code) ? `非六碼編號「${code}」，不列入品項數 N` : undefined;
}
export const active = <R extends { excluded?: string }>(rows: R[]) => rows.filter(row => !row.excluded);

export type UsageItem = { sku: string; name: string; unit: string; count: Frac; quantity: Frac; rows: UsageRow[] };
export type UsageSummary = { items: UsageItem[]; unitConflicts: { sku: string; units: string[]; rows: UsageRow[] }[]; invalid: UsageRow[] };
/** Same-code lines are added up, counts and quantities separately. Units that differ for one code block the total. */
export function aggregateUsage(rows: UsageRow[]): UsageSummary {
  const groups = new Map<string, UsageRow[]>(); const invalid: UsageRow[] = [];
  for (const row of active(rows)) { if (usageErrors(row).length) { invalid.push(row); continue; } const list = groups.get(row.sku); if (list) list.push(row); else groups.set(row.sku, [row]); }
  const items: UsageItem[] = []; const unitConflicts: UsageSummary['unitConflicts'] = [];
  for (const [sku, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const units = [...new Set(list.map(row => row.unit.normalize('NFKC').trim()))];
    if (units.length > 1) unitConflicts.push({ sku, units, rows: list });
    // The report may cut a name short; it is only printed when the stock sheet has no line for the code.
    items.push({ sku, name: managementName(list[0].rawName).name || list[0].rawName, unit: units[0], count: list.reduce((sum, row) => add(sum, parseDecimal(row.count)!), ZERO), quantity: list.reduce((sum, row) => add(sum, parseDecimal(row.quantity)!), ZERO), rows: list });
  }
  return { items, unitConflicts, invalid };
}
/** Six-digit codes present in the usage report, including codes whose count or quantity is 0. */
export const usageCodes = (rows: UsageRow[]) => new Set(active(rows).map(row => row.sku).filter(sku => SIX.test(sku)));

export type StockItem = { sku: string; name: string; qty: Frac; rows: StockRow[] };
/** Stock of one code over all its locations; the name is the first printed one. */
export function aggregateStock(rows: StockRow[]): Map<string, StockItem> {
  const items = new Map<string, StockItem>();
  for (const row of active(rows)) {
    const qty = parseDecimal(row.qty); if (!SIX.test(row.sku) || qty === null) continue;
    const item = items.get(row.sku); if (item) { item.qty = add(item.qty, qty); item.rows.push(row); } else items.set(row.sku, { sku: row.sku, name: row.name, qty, rows: [row] });
  }
  return items;
}
const locationKey = (location: string) => location.normalize('NFKC').replace(/\s+/g, '');
/** The same code at the same location twice cannot be told apart from a repeated report, so it is never added up silently. */
export function stockDuplicates(rows: StockRow[]): StockRow[][] {
  const lines = new Map<string, StockRow[]>();
  for (const row of active(rows)) { if (!SIX.test(row.sku)) continue; const key = row.sku + '\u0000' + locationKey(row.location); const list = lines.get(key); if (list) list.push(row); else lines.set(key, [row]); }
  return [...lines.values()].filter(list => list.length > 1);
}

// ---- Safety stock ----------------------------------------------------------
export const THRESHOLD = frac(8n);
export const DEFAULT_SAFETY_STRATEGY = 'hamster';
export const SAFETY_STRATEGIES = {
  hamster: { name: '倉鼠派', symbol: '🐹', maximum: frac(7n, 2n), minimum: frac(6n, 5n),
    focus: '充足備貨，應對供貨波動', advantage: '供貨不穩定時，保有較充足的貨源。', need: '需要較大的調劑與儲存空間。' },
  balanced: { name: '平衡派', symbol: '⚖️', maximum: frac(5n, 2n), minimum: frac(4n, 5n),
    focus: '高頻多備，低頻省空間', advantage: '較寬的係數梯度保留高頻用藥，並從較低頻用藥節省儲存空間。', need: '需要兼顧備貨餘裕與儲存空間。' },
  antelope: { name: '羚羊派', symbol: '🦌', maximum: frac(6n, 5n), minimum: frac(3n, 5n),
    focus: '精控庫存，配合空間限制', advantage: '精確控制備貨量，配合固定的倉儲空間。', need: '需要更密切、頻繁地關注貨源。' },
} as const;
export type SafetyStrategy = keyof typeof SAFETY_STRATEGIES;
/** A code whose printed name keeps the 缺貨 prefix is short at the supplier: one more month of use on top of its rank coefficient. */
export const SHORTAGE_BONUS = frac(1n);
export const shortage = (name: string) => name.startsWith(KEEP_STATUS[0]);
export const safetyStrategyRange = (strategy: SafetyStrategy) => {
  const { maximum, minimum } = SAFETY_STRATEGIES[strategy];
  return `${formatFrac(maximum)}～${formatFrac(minimum)}`;
};
/**
 * Months of cover by rank on the store's own list, so a busy store does not give every code the maximum.
 * p = 1 − i / (K − 1) for the i-th row (0 = highest A; equal A share the first rank).
 * The top third (p ≥ 2/3) gets the strategy's maximum; below it the coefficient falls linearly to its minimum.
 * The default hamster strategy preserves the original 3.5–1.2 curve exactly.
 */
const TOP = frac(2n, 3n);
export function coefficient(i: number, k: number, strategy: SafetyStrategy = DEFAULT_SAFETY_STRATEGY): Frac {
  const p = k > 1 ? frac(BigInt(k - 1 - i), BigInt(k - 1)) : frac(1n);
  const { maximum, minimum } = SAFETY_STRATEGIES[strategy];
  return cmp(p, TOP) >= 0 ? maximum : add(minimum, mul(div(p, TOP), sub(maximum, minimum)));
}
/** One code's use; `all` holds every code with a count, the list only the selected ones. */
export type UsageRate = { sku: string; name: string; unit: string; count: Frac; quantity: Frac; a: Frac; b: bigint; ab: Frac; stock?: Frac; stockName?: string };
export type SafetyRow = UsageRate & { coefficient: Frac; shortage: boolean; safety: bigint };
export type SafetyResult = { strategy: SafetyStrategy; n: number; limit: number; eligible: number; k: number; rows: SafetyRow[]; all: UsageRate[];
  /** Partner-clinic stores only: A > 8 codes left out because the store holds no stock or under LOW_COVER of it, and how many later codes moved up. */
  outside?: { none: number; low: number; filled: number } };
/**
 * A = count / months, B = round(quantity / count), monthly use A × B, safety = ceil(A × B × coefficient by rank),
 * the coefficient raised by SHORTAGE_BONUS for a 缺貨 name; the bonus never changes which codes are listed or their rank.
 * Only A > 8 qualifies; K = min(floor(N × 10%), qualifying items), highest A first, ties by code. N counts every code.
 * With a partner clinic, codes the store holds no stock of, or less than LOW_COVER of their monthly use, are mostly
 * supplied by the clinic: they are skipped and the next qualifying code moves up, so K still aims at floor(N × 10%).
 */
export function safetyList(items: UsageItem[], months: Frac, stock: Map<string, StockItem>, partner = false, strategy: SafetyStrategy = DEFAULT_SAFETY_STRATEGY): SafetyResult {
  const all: UsageRate[] = [];
  for (const item of items) {
    if (item.count.n === 0n) continue; // no division by a zero count; such an item can never have A > 8
    const a = div(item.count, months); const b = roundHalfUp(div(item.quantity, item.count)); const inStock = stock.get(item.sku);
    all.push({ sku: item.sku, name: inStock?.name ?? item.name, unit: item.unit, count: item.count, quantity: item.quantity, a, b, ab: mul(a, frac(b)), stock: inStock?.qty, stockName: inStock?.name });
  }
  all.sort((x, y) => cmp(y.a, x.a) || x.sku.localeCompare(y.sku));
  const qualifying = all.filter(row => cmp(row.a, THRESHOLD) > 0); const n = items.length; const limit = Math.floor(n / 10);
  const eligible = partner ? qualifying.filter(row => held(row) && !lowCover(row)) : qualifying;
  const k = Math.min(limit, eligible.length); const picked = eligible.slice(0, k);
  const rows = picked.map((row, i) => {
    const rank = picked.findIndex(other => cmp(other.a, row.a) === 0); const short = shortage(row.name);
    const c = add(coefficient(rank < 0 ? i : rank, k, strategy), short ? SHORTAGE_BONUS : ZERO);
    return { ...row, coefficient: c, shortage: short, safety: ceil(mul(row.ab, c)) };
  });
  const none = qualifying.filter(row => !held(row)).length;
  const outside = partner ? { none, low: qualifying.length - eligible.length - none, filled: picked.filter(row => qualifying.indexOf(row) >= limit).length } : undefined;
  return { strategy, n, limit, eligible: eligible.length, k, rows, all, outside };
}
/**
 * The store holds stock of a code when the stock sheet prints it with a total other than 0. A 0 total means the same as
 * no line: a sheet printed with zero stock lists the whole product file (0015: 96 of 171 listed codes at 0).
 */
export const held = (row: UsageRate) => row.stock !== undefined && row.stock.n !== 0n;
/**
 * Partner-clinic stores: stock under 0.1 month (about 3 days) of the code's monthly use, negative stock included, means
 * the clinic supplies most of it (0015: 45 such codes, 40% of the list's use; 26永和: none).
 */
export const LOW_COVER = frac(1n, 10n);
export const lowCover = (row: UsageRate) => row.stock !== undefined && row.ab.n !== 0n && cmp(div(row.stock, row.ab), LOW_COVER) < 0;
/**
 * A store that also dispenses drugs supplied by a partner clinic: more than PARTNER_LIMIT codes of the ordinary safety
 * list are not held. A few such codes are a stock-sheet scope question (26永和: 2); many are not ours.
 */
export const PARTNER_LIMIT = 10;
export const unheldOnList = (result: SafetyResult) => result.rows.filter(row => !held(row)).length;
export const partnerSupplied = (missing: number) => missing > PARTNER_LIMIT;

// ---- Dead stock and empty slots -------------------------------------------
const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
/** The inventory sheet's location order: natural Chinese order, blank last, then code. */
export function byLocation(a: StockRow, b: StockRow): number {
  if (!a.location.trim() && b.location.trim()) return 1;
  if (a.location.trim() && !b.location.trim()) return -1;
  return collator.compare(a.location, b.location) || a.sku.localeCompare(b.sku);
}
export type SlotRow = StockRow & { negative: boolean };
/** Stock lines whose code is not in the usage report: non-zero stock is dead stock (negative kept and marked), zero is an empty slot. */
export function slotLists(stock: StockRow[], used: Set<string>): { dead: SlotRow[]; empty: SlotRow[] } {
  const dead: SlotRow[] = []; const empty: SlotRow[] = [];
  for (const row of active(stock)) {
    const qty = parseDecimal(row.qty); if (!SIX.test(row.sku) || qty === null || used.has(row.sku)) continue;
    (qty.n === 0n ? empty : dead).push({ ...row, negative: qty.n < 0n });
  }
  return { dead: dead.sort(byLocation), empty: empty.sort(byLocation) };
}
