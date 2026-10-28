import { rocDate } from './arithmetic-model';
import { parsePrescriptionLayout, splitFields } from './prescription-qr';

const FAILED = '失敗：';
// Field numbers count from 1, as in the README; arrays count from 0.
/** Kept as scanned: institution, prescription type, visit date, days, ICD-10 codes. Each must be plain ASCII; Chinese there means another layout that could put a name in a kept field. */
const kept = [1, 2, 8, 10, 12];
/** Fields 3, 7 and 11 are of unknown use: a short code is kept, anything longer may identify the patient. */
const shortCode = (value: string) => /^[0-9A-Za-z]{1,4}$/.test(value) ? value : '';

/** A birth date that cannot be read is described by its shape, never its value: digits become 9, letters A, any other character outside printable ASCII X, symbols stay; past 12 characters only the length. */
export function birthShape(value: string): string {
  const chars = [...value];
  if (chars.length > 12) return `AGE?len${chars.length}`;
  return `AGE?${chars.map(char => /[0-9]/.test(char) ? '9' : /[A-Za-z]/.test(char) ? 'A' : /[\x20-\x7E]/.test(char) ? char : 'X').join('')}`;
}
/** Completed years on the visit date in 10-year bands (AGE0-9 … AGE80-89, AGE90+), with 60–69 split at 65 for the rules on older patients.
 *  An unreadable birth date gives its shape; a blank one, an unreadable visit date or a birth after the visit gives a blank. */
export function ageBand(birthRoc: string, visitRoc: string): string {
  let birth: string, visit: string;
  try { birth = rocDate(birthRoc.trim()); } catch { return birthRoc.trim() ? birthShape(birthRoc) : ''; }
  try { visit = rocDate(visitRoc.trim()); } catch { return ''; }
  const age = Number(visit.slice(0, 4)) - Number(birth.slice(0, 4)) - (visit.slice(5) < birth.slice(5) ? 1 : 0);
  if (age < 0) return '';
  if (age >= 90) return 'AGE90+';
  if (age >= 60 && age < 70) return age < 65 ? 'AGE60-64' : 'AGE65-69';
  const low = age - age % 10;
  return `AGE${low}-${low + 9}`;
}
/** One prescription as one line in the same ;-separated layout. Every field is blank unless a rule keeps it, so nothing moves and nothing unlisted leaks. */
export function deidentify(scanned: string, scannedAs?: string): string {
  const { fields } = parsePrescriptionLayout(scanned, scannedAs);
  for (const n of kept) if (/[^\x20-\x7E]/.test(fields[n - 1])) throw new Error(`第 ${n} 欄出現中文或全形字，可能是不同院所的 QR 格式。`);
  const line = fields.map((value, i) => i >= 14 || kept.includes(i + 1) ? value : '');
  for (const n of [3, 7, 11]) line[n - 1] = shortCode(fields[n - 1]);
  line[5] = ageBand(fields[5], fields[7]);
  line[12] = fields[12] === fields[0] ? fields[12] : '';
  // Field 14 joins codes and the free-text allergy history with commas; only the allergy part stays, cut at its first comma.
  line[13] = fields[13].split(',').filter(part => /^\s*過敏史[:：]/.test(part)).join(',');
  if (line.some(value => /[\r\n\u2028\u2029]/.test(value))) throw new Error('保留欄位含換行，無法輸出單行樣本。');
  return line.join(';') + ';';
}
/** A rejected scan is recorded by reason and field count only, never by its text. */
export function failureLine(scanned: string, error: unknown): string {
  const reason = error instanceof Error ? error.message.replace(/。$/, '') : '無法解析';
  return `${FAILED}${reason}，欄位數 ${splitFields(scanned).length}`;
}
/** SHA-256 of the scanned text, so a rescan is matched against the original without keeping it. */
export async function scanKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface Sample { line: string; ok: boolean; key?: string }
export interface Recorded { state: 'added' | 'failed' | 'duplicate'; index: number }
/** The lines collected in this page. Keys stay in memory; only lines are saved, so lines restored after a reload have none. */
export class SampleLog {
  entries: Sample[] = [];
  restore(lines: string[]) { this.entries = lines.map(line => ({ line, ok: !line.startsWith(FAILED) })); }
  record(key: string, scanned: string): Recorded {
    const known = this.entries.findIndex(entry => entry.key === key);
    if (known >= 0) return { state: 'duplicate', index: known };
    let line: string;
    try { line = deidentify(scanned); } catch (error) {
      this.entries.push({ line: failureLine(scanned, error), ok: false, key });
      return { state: 'failed', index: this.entries.length - 1 };
    }
    // A rescan of a prescription collected before a reload can only be matched by its de-identified line.
    const restored = this.entries.findIndex(entry => !entry.key && entry.ok && entry.line === line);
    if (restored >= 0) return { state: 'duplicate', index: restored };
    this.entries.push({ line, ok: true, key });
    return { state: 'added', index: this.entries.length - 1 };
  }
  get collected() { return this.entries.filter(entry => entry.ok).length; }
  get failed() { return this.entries.length - this.collected; }
  lines() { return this.entries.map(entry => entry.line); }
  text() { return this.entries.map(entry => `${entry.line}\n`).join(''); }
  clear() { this.entries = []; }
}
