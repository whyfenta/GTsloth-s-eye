import { csvRows } from './csv';

// 商品代號對照檔 sku-nhi-map.csv, kept in a separate private repository. Reading it is shared by the scripts that keep it
// (scripts/sku-map.ts) and the one that publishes its 健保碼 → 六碼 part for the pickup slip (scripts/slip-assets.ts).
// Format: docs/reference/sku-nhi-map.md.
export const MAP_COLUMNS = ['六碼', '健保藥品代號', '對接品名', '判定', '判定日期', '來源'] as const;
export const VERDICTS = ['自動明確', '人工確認', '無健保碼'] as const;
export type Verdict = typeof VERDICTS[number];
/** One 六碼. code is empty only for 無健保碼. key: the 庫存簡表 name it was settled for (storeName().key). */
export type MapEntry = { sku: string; code: string; key: string; verdict: Verdict; date: string; source: string };

const SIX = /^\d{6}$/; const CODE = /^[A-Z0-9]{10}$/; const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** A spreadsheet drops leading zeros (000019 → 19) and rewrites dates (2026/10/25); both are put back. */
export const sixDigits = (text: string) => /^\d{1,6}$/.test(text) ? text.padStart(6, '0') : text;
const isoDate = (text: string) => { const m = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : text; };

/** Parses and checks the map; every problem is reported with its line, and any problem rejects the file. */
export function readMap(text: string): Map<string, MapEntry> {
  const [header, ...rows] = csvRows(text.replace(/^﻿/, ''));
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
