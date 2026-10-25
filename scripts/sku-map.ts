import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { licence, match, status, storeName, MATCH_LABEL, type Match, type Nhi, type RocDay } from './nhi-match';
import { csvRows } from './roster';

// 商品代號對照檔 sku-nhi-map.csv, kept in a separate private repository: read, check and write it, look a 庫存簡表 up
// in it (查表), and take a person's decisions back from the review sheet. Format and workflow: docs/reference/sku-nhi-map.md.

/**
 * This repository is public, so the map may sit inside it only where Git ignores it (sku-nhi-map*.csv, output/).
 * Returns why `file` is refused, or undefined. Outside the repository, or without Git, nothing is checked.
 */
export function publicPathProblem(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  try { execFileSync('git', ['check-ignore', '-q', '--', relative.split(path.sep).join('/')], { cwd: root, stdio: 'ignore' }); return undefined; }
  catch (error) {
    if ((error as { status?: number }).status !== 1) return undefined;
    return `對照檔 ${relative} 在公開的 GTsloth-s-eye repo 內，且 Git 沒有排除它，commit 後就會公開；請放在另一個 private repo，例如 ../GTsloth-map/sku-nhi-map.csv。`;
  }
}

export const MAP_COLUMNS = ['六碼', '健保藥品代號', '對接品名', '判定', '判定日期', '來源'] as const;
export const VERDICTS = ['自動明確', '人工確認', '無健保碼'] as const;
export type Verdict = typeof VERDICTS[number];
/** One 六碼. code is empty only for 無健保碼. key: the 庫存簡表 name it was settled for (storeName().key). */
export type MapEntry = { sku: string; code: string; key: string; verdict: Verdict; date: string; source: string };

const SIX = /^\d{6}$/; const CODE = /^[A-Z0-9]{10}$/; const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** A spreadsheet drops leading zeros (000019 → 19) and rewrites dates (2026/10/25); both are put back. */
const sixDigits = (text: string) => /^\d{1,6}$/.test(text) ? text.padStart(6, '0') : text;
const isoDate = (text: string) => { const m = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : text; };

/** Excel saves a CSV as Big5 unless told otherwise; read either. */
export function decodeCsv(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { return new TextDecoder('big5').decode(bytes); }
}
const field = (value: string) => /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
/** UTF-8 with BOM so a spreadsheet shows the Chinese; LF line ends as the repository keeps them. */
export const csvText = (rows: readonly (readonly string[])[]) => '\uFEFF' + rows.map(row => row.map(field).join(',')).join('\n') + '\n';

/** Parses and checks the map; every problem is reported with its line, and any problem rejects the file. */
export function readMap(text: string): Map<string, MapEntry> {
  const [header, ...rows] = csvRows(text.replace(/^\uFEFF/, ''));
  if (!header || MAP_COLUMNS.some((name, i) => header[i]?.trim() !== name)) throw new Error(`對照檔欄位應為：${MAP_COLUMNS.join(',')}`);
  const map = new Map<string, MapEntry>(); const errors: string[] = [];
  rows.forEach((row, i) => {
    const [sku, code, key, verdict, date, source] = MAP_COLUMNS.map((_, j) => (row[j] ?? '').trim());
    const entry = { sku: sixDigits(sku), code: code.toUpperCase(), key, verdict: verdict as Verdict, date: isoDate(date), source };
    const line = `第 ${i + 2} 列（${sku || '無六碼'}）`;
    if (!SIX.test(entry.sku)) errors.push(`${line}：六碼應為 6 位數字`);
    else if (map.has(entry.sku)) errors.push(`${line}：六碼重複`);
    if (!VERDICTS.includes(entry.verdict)) errors.push(`${line}：判定應為 ${VERDICTS.join('／')}`);
    if (entry.verdict === '無健保碼' ? entry.code !== '' : !CODE.test(entry.code)) errors.push(`${line}：${entry.verdict === '無健保碼' ? '無健保碼不應填健保藥品代號' : '健保藥品代號應為 10 碼'}`);
    if (!key) errors.push(`${line}：缺少對接品名`);
    if (!ISO.test(entry.date)) errors.push(`${line}：判定日期應為 YYYY-MM-DD`);
    map.set(entry.sku, entry);
  });
  if (errors.length) throw new Error(`對照檔有 ${errors.length} 個問題：\n  ${errors.join('\n  ')}`);
  return map;
}
export const mapText = (map: Map<string, MapEntry>) => csvText([MAP_COLUMNS,
  ...[...map.values()].sort((a, b) => a.sku.localeCompare(b.sku)).map(e => [e.sku, e.code, e.key, e.verdict, e.date, e.source])]);

/** One 六碼 of a 庫存簡表: the first name printed for it, and where it came from (store and print date). */
export type StoreItem = { sku: string; rawName: string; qty: string; source: string };
/**
 * mapped: in the map under the same name. renamed: the name changed but matching again gives the same answer, so only
 * key / date / source are refreshed. matched: a new 自動明確, possibly replacing an older 自動明確 for a changed name.
 * review: needs a person, with the key to settle and, for a changed name, the map entry it had.
 */
export type Outcome =
  | { kind: 'mapped'; entry: MapEntry }
  | { kind: 'renamed' | 'matched'; entry: MapEntry; previous?: MapEntry }
  | { kind: 'review'; reason: string; key: string; match: Match; previous?: MapEntry };

/** 查表 first; only a 六碼 that is new or whose name changed is name-matched. A person's verdict is never overwritten. */
export function lookup(item: StoreItem, map: Map<string, MapEntry>, nhi: Nhi, day: RocDay, date: string): Outcome {
  const key = storeName(item.rawName).key; const previous = map.get(item.sku);
  if (previous?.key === key) return { kind: 'mapped', entry: previous };
  const found = match(nhi, item.rawName, day);
  const fresh = (code: string, verdict: Verdict): MapEntry => ({ sku: item.sku, code, key, verdict, date, source: item.source });
  if (!previous) return found.kind === 'clear' ? { kind: 'matched', entry: fresh(found.code, '自動明確') } : { kind: 'review', reason: MATCH_LABEL[found.kind], key, match: found };
  const same = found.kind === 'clear' ? found.code === previous.code : found.kind === 'none' && previous.verdict === '無健保碼';
  if (same) return { kind: 'renamed', entry: fresh(previous.code, previous.verdict), previous };
  if (found.kind === 'clear' && previous.verdict === '自動明確') return { kind: 'matched', entry: fresh(found.code, '自動明確'), previous };
  return { kind: 'review', reason: '品名已變更', key, match: found, previous };
}

/** Paid codes of the same 藥證 for a mapped code that is no longer paid: the NHI file often moves a drug to a new code. */
export const paidSiblings = (nhi: Nhi, code: string, day: RocDay) =>
  (nhi.byLicence.get(licence(code)) ?? []).filter(e => e.code !== code && status(e, day).paid).map(e => e.code);

/** Status words the review sheet shows so a person can skip 自費, 停供 and similar items first. */
const MARKS = /自費|公費|不售|停供|停產|停售|禁售|禁請|註銷|到期|不再進口|食品|跨境|贈藥|客訂|專案進口|專案製造/g;
export const marksOf = (raw: string) => [...new Set(raw.normalize('NFKC').match(MARKS) ?? [])].join('、');

export const REVIEW_COLUMNS = ['六碼', '簡表品名', '對接品名', '待確認原因', '品名標記', '庫存量', '目前對照', '候選1', '候選2', '候選3', '候選4', '候選5', '來源', '採用'] as const;
/** 採用: the 健保藥品代號 chosen, or 無 (無健保碼) when the product has none. */
const NONE = new Set(['無', '無健保碼']);
/**
 * Applies the filled-in 採用 column of a review sheet: a 健保碼 becomes 人工確認, 無 becomes 無健保碼. Rows left
 * blank are skipped. Any bad row rejects the whole sheet, so a half-applied review never reaches the map.
 */
export function applyReview(text: string, map: Map<string, MapEntry>, nhi: Nhi, date: string): { applied: MapEntry[]; skipped: number } {
  const [header, ...rows] = csvRows(text.replace(/^\uFEFF/, ''));
  const at = (name: typeof REVIEW_COLUMNS[number]) => { const i = header?.indexOf(name) ?? -1; if (i < 0) throw new Error(`待確認表缺少欄位：${name}`); return i; };
  const [sku, key, source, chosen] = [at('六碼'), at('對接品名'), at('來源'), at('採用')];
  const applied: MapEntry[] = []; const errors: string[] = []; let skipped = 0;
  rows.forEach((row, i) => {
    const pick = (row[chosen] ?? '').trim().toUpperCase(); if (!pick) { skipped++; return; }
    const none = NONE.has(pick);
    const entry: MapEntry = { sku: sixDigits((row[sku] ?? '').trim()), code: none ? '' : pick, key: (row[key] ?? '').trim(),
      verdict: none ? '無健保碼' : '人工確認', date, source: (row[source] ?? '').trim() };
    const line = `第 ${i + 2} 列（${entry.sku}）`;
    if (!SIX.test(entry.sku)) errors.push(`${line}：六碼應為 6 位數字`);
    else if (entry.code && !nhi.codes.has(entry.code)) errors.push(`${line}：健保檔沒有 ${entry.code}`);
    else if (!entry.key) errors.push(`${line}：缺少對接品名`);
    else applied.push(entry);
  });
  if (errors.length) throw new Error(`待確認表有 ${errors.length} 個問題，未寫入對照檔：\n  ${errors.join('\n  ')}`);
  for (const entry of applied) map.set(entry.sku, entry);
  return { applied, skipped };
}
