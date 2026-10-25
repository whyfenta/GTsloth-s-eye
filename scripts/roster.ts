import { csvRows } from '../src/csv';
export { csvRows };

/**
 * Hospitals and clinics (醫事機構種類 A) of 健保特約醫療院所名冊 by 10-character code. Closed institutions stay listed
 * because their continuous prescriptions can still be valid. Spreadsheet edits drop leading zeros (restored here) and
 * turn some codes into scientific notation, which cannot be restored and is skipped.
 */
export function rosterNames(text: string): { names: Record<string, string>; skipped: string[] } {
  const [header, ...rows] = csvRows(text.replace(/^﻿/, ''));
  const column = (name: string) => { const i = header.indexOf(name); if (i < 0) throw new Error(`名冊缺少欄位：${name}`); return i; };
  const code = column('醫事機構代碼'), name = column('醫事機構名稱'), kind = column('醫事機構種類');
  const names: Record<string, string> = {}; const skipped: string[] = [];
  for (const row of rows) {
    if (row[kind]?.trim() !== 'A') continue;
    const raw = row[code].trim();
    const value = /^\d{7,9}$/.test(raw) ? raw.padStart(10, '0') : raw.toUpperCase();
    if (!/^[0-9A-Z]{10}$/.test(value)) { skipped.push(`${raw} ${row[name].trim()}`); continue; }
    names[value] = row[name].trim();
  }
  return { names: Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b))), skipped };
}
