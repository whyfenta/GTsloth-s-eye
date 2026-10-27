import { csvRows } from './csv';

// 商品代號對照檔 sku-nhi-map.csv, kept in a separate private repository. Reading it is shared by the scripts that keep it
// (scripts/sku-map.ts) and the one that publishes its 健保碼 → 六碼 part for the pickup slip (scripts/slip-assets.ts).
// Format: docs/reference/sku-nhi-map.md.
export const MAP_COLUMNS = ['六碼', '健保藥品代號', '對接品名', '判定', '判定日期', '來源', '改用六碼'] as const;
/** Maps written before 改用六碼 existed have only these six columns; they still read. */
const REQUIRED_COLUMNS = 6;
export const VERDICTS = ['自動明確', '人工確認', '無健保碼', '健保檔外代號'] as const;
export type Verdict = typeof VERDICTS[number];
/**
 * One 六碼. code is empty only for 無健保碼; for 健保檔外代號 it is a code the NHI file does not list (戒菸、公費 drugs on a
 * prescription QR), so nothing checks it against that file. key: the 庫存簡表 name it was settled for (storeName().key).
 * replacedBy (改用六碼): the 六碼 now dispensed instead. The entry keeps its own, older 健保碼 because some prescribers still
 * use it during the changeover; a scan of that code shows the replacement 六碼 and its 健保碼.
 */
export type MapEntry = { sku: string; code: string; key: string; verdict: Verdict; date: string; source: string; replacedBy?: string };

const SIX = /^\d{6}$/; const CODE = /^[A-Z0-9]{10}$/; const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** A spreadsheet drops leading zeros (000019 → 19) and rewrites dates (2026/10/25); both are put back. */
export const sixDigits = (text: string) => /^\d{1,6}$/.test(text) ? text.padStart(6, '0') : text;
const isoDate = (text: string) => { const m = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : text; };

/** Parses and checks the map; every problem is reported with its line, and any problem rejects the file. */
export function readMap(text: string): Map<string, MapEntry> {
  const [header, ...rows] = csvRows(text.replace(/^﻿/, ''));
  if (!header || MAP_COLUMNS.some((name, i) => (i < REQUIRED_COLUMNS || header[i] !== undefined) && header[i]?.trim() !== name)) throw new Error(`對照檔欄位應為：${MAP_COLUMNS.join(',')}`);
  const map = new Map<string, MapEntry>(); const errors: string[] = [];
  rows.forEach((row, i) => {
    const [sku, code, key, verdict, date, source, replacedBy] = MAP_COLUMNS.map((_, j) => (row[j] ?? '').trim());
    const entry: MapEntry = { sku: sixDigits(sku), code: code.toUpperCase(), key, verdict: verdict as Verdict, date: isoDate(date), source };
    if (replacedBy) entry.replacedBy = sixDigits(replacedBy);
    const line = `第 ${i + 2} 列（${sku || '無六碼'}）`;
    if (!SIX.test(entry.sku)) errors.push(`${line}：六碼應為 6 位數字`);
    else if (map.has(entry.sku)) errors.push(`${line}：六碼重複`);
    if (!VERDICTS.includes(entry.verdict)) errors.push(`${line}：判定應為 ${VERDICTS.join('／')}`);
    if (entry.verdict === '無健保碼' ? entry.code !== '' : !CODE.test(entry.code)) errors.push(`${line}：${entry.verdict === '無健保碼' ? '無健保碼不應填健保藥品代號' : '健保藥品代號應為 10 碼'}`);
    if (!key) errors.push(`${line}：缺少對接品名`);
    if (!ISO.test(entry.date)) errors.push(`${line}：判定日期應為 YYYY-MM-DD`);
    map.set(entry.sku, entry);
  });
  errors.push(...replacementProblems(map));
  if (errors.length) throw new Error(`對照檔有 ${errors.length} 個問題：\n  ${errors.join('\n  ')}`);
  return map;
}

/** 改用六碼 must name another 六碼 in the map that has a 健保碼 and is not replaced itself, so one hop always ends. */
export function replacementProblems(map: Map<string, MapEntry>): string[] {
  const problems: string[] = [];
  for (const entry of map.values()) {
    if (!entry.replacedBy) continue;
    const target = map.get(entry.replacedBy); const line = `六碼 ${entry.sku} 的改用六碼 ${entry.replacedBy}`;
    if (!entry.code) problems.push(`${line}：本身須有健保碼（原處方用的碼）`);
    else if (entry.replacedBy === entry.sku) problems.push(`${line}：不能改用自己`);
    else if (!target) problems.push(`${line}：不在對照檔`);
    else if (!target.code) problems.push(`${line}：該六碼沒有健保碼`);
    else if (target.replacedBy) problems.push(`${line}：該六碼本身也已改用 ${target.replacedBy}，請直接填最後的六碼`);
  }
  return problems;
}
