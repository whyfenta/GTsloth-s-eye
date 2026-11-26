import { ageBand, parseDrugsLayout, parsePrescriptionLayout, sexMark, sexOf, splitFields } from './prescription-qr';

export { ageBand, birthShape } from './prescription-qr';

const FAILED = '失敗：';
// Field numbers count from 1, as in the README; arrays count from 0.
/** Kept as scanned: institution, prescription type, visit date, days, ICD-10 codes. Each must be plain ASCII; Chinese there means another layout that could put a name in a kept field. */
const kept = [1, 2, 8, 10, 12];
/** Fields 3, 7 and 11 are of unknown use: a short code is kept, anything longer may identify the patient. */
const shortCode = (value: string) => /^[0-9A-Za-z]{1,4}$/.test(value) ? value : '';

/**
 * Letters in one case. A keyboard scanner typing with Caps Lock on inverts every letter (BID → bid, Tab → tAB), so the
 * same QR scanned with it, without it or by the camera gives the same line. Nothing in a line tells by case: codes, frequencies,
 * routes and diagnoses are read upper-cased (rxFacts), field 14 keeps only the 過敏史 text. Only a-z: no other character, and so
 * no field's length, changes.
 */
export const sameCase = (text: string) => text.replace(/[a-z]+/g, letters => letters.toUpperCase());
/**
 * One prescription as one line in the same ;-separated layout, the fields kept from the scan upper-cased (sameCase; fields 5 and 6
 * are the page's own, SEXM and AGE?len13 as they are). Every field is blank unless a rule keeps it, so nothing moves and nothing
 * unlisted leaks.
 */
export function deidentify(scanned: string, scannedAs?: string): string {
  const { fields } = parsePrescriptionLayout(scanned, scannedAs);
  for (const n of kept) if (/[^\x20-\x7E]/.test(fields[n - 1])) throw new Error(`第 ${n} 欄出現中文或全形字，可能是不同院所的 QR 格式。`);
  const line = fields.map((value, i) => i >= 14 || kept.includes(i + 1) ? value : '');
  for (const n of [3, 7, 11]) line[n - 1] = shortCode(fields[n - 1]);
  // Field 5, the ID number, leaves only the sex its second digit gives (SEXM, SEXF, or blank); field 6, the birth date, its age band.
  line[4] = sexMark(sexOf(fields[4]));
  line[5] = ageBand(fields[5], fields[7]);
  line[12] = fields[12] === fields[0] ? fields[12] : '';
  // Field 14 joins codes and the free-text allergy history with commas, or for one hospital lists allergies with ; (see alignFields);
  // only the allergy part stays, cut at its first comma or ;, so the line keeps its fields.
  line[13] = fields[13].split(/[,;]/).filter(part => /^\s*過敏史[:：]/.test(part)).join(',');
  if (line.some(value => /[\r\n\u2028\u2029]/.test(value))) throw new Error('保留欄位含換行，無法輸出單行樣本。');
  return line.map((value, i) => i === 4 || i === 5 ? value : sameCase(value)).join(';') + ';';
}
/** A prescription's drugs-only second QR, as the drug fields to append to its line; undefined for any other scan. Drug fields are kept as scanned and upper-cased, as in deidentify. */
export function deidentifyDrugs(scanned: string, scannedAs?: string): string | undefined {
  const fields = parseDrugsLayout(scanned, scannedAs)?.fields;
  if (!fields) return undefined;
  if (fields.some(value => /[\r\n\u2028\u2029]/.test(value))) throw new Error('保留欄位含換行，無法輸出單行樣本。');
  return sameCase(fields.join(';') + ';');
}
/** A rejected scan is recorded by reason and field count only, never by its text. */
export function failureLine(scanned: string, error: unknown): string {
  const reason = error instanceof Error ? error.message.replace(/。$/, '') : '無法解析';
  return `${FAILED}${reason}，欄位數 ${splitFields(scanned).length}`;
}
/** SHA-256 of the scanned text with its letters in one case (sameCase), so a rescan, Caps Lock on or off, is matched against the original without keeping it. */
export async function scanKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sameCase(text)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** qrs: how many QRs the line was scanned from; parts: the keys of the drugs-only QRs appended, in memory like key. */
export interface Sample { line: string; ok: boolean; key?: string; qrs: number; parts?: string[] }
export interface Recorded { state: 'added' | 'appended' | 'failed' | 'duplicate'; index: number; drugs?: number }
/** Per 醫事機構代碼: prescriptions collected, and how many came with a drugs-only second QR. */
export interface InstitutionCount { institution: string; prescriptions: number; multi: number }
/** The lines collected in this page. Keys stay in memory; only lines are saved, so lines restored after a reload have none. */
export class SampleLog {
  entries: Sample[] = [];
  restore(lines: string[], qrs: number[] = []) { this.entries = lines.map((line, i) => ({ line, ok: !line.startsWith(FAILED), qrs: qrs[i] ?? 1 })); }
  private fail(key: string, scanned: string, error: unknown): Recorded {
    this.entries.push({ line: failureLine(scanned, error), ok: false, key, qrs: 1 });
    return { state: 'failed', index: this.entries.length - 1 };
  }
  record(key: string, scanned: string): Recorded {
    const known = this.entries.findIndex(entry => entry.key === key);
    if (known >= 0) return { state: 'duplicate', index: known };
    let line: string, drugs: string | undefined;
    try {
      drugs = deidentifyDrugs(scanned);
      line = drugs ?? deidentify(scanned);
    } catch (error) { return this.fail(key, scanned, error); }
    if (drugs) return this.append(key, scanned, drugs);
    // A rescan of a prescription collected before a reload can only be matched by its de-identified line, which a second QR has made
    // longer; a line saved before lines were upper-cased is compared in one case.
    const restored = this.entries.findIndex(entry => !entry.key && entry.ok && (sameCase(entry.line) === sameCase(line) || entry.qrs > 1 && sameCase(entry.line).startsWith(sameCase(line))));
    if (restored >= 0) return { state: 'duplicate', index: restored };
    this.entries.push({ line, ok: true, key, qrs: 1 });
    return { state: 'added', index: this.entries.length - 1 };
  }
  /** A drugs-only QR has no patient or date: it joins the line scanned just before it, as nothing in the first QR says one follows. */
  private append(key: string, scanned: string, drugs: string): Recorded {
    const index = this.entries.length - 1;
    const last = this.entries[index];
    if (!last?.ok) return this.fail(key, scanned, new Error('只有藥品的第 2 個 QR，但前一張不是成功收下的處方'));
    if (last.parts?.includes(key) || last.qrs > 1 && sameCase(last.line).endsWith(`;${drugs}`)) return { state: 'duplicate', index };
    last.line += drugs;
    last.qrs++;
    (last.parts ??= []).push(key);
    return { state: 'appended', index, drugs: splitFields(drugs).length / 5 };
  }
  /** Institutions whose prescriptions came with a second QR, most such prescriptions first. */
  institutions(): InstitutionCount[] {
    const counts = new Map<string, InstitutionCount>();
    for (const entry of this.entries.filter(entry => entry.ok)) {
      const institution = splitFields(entry.line)[0];
      const count = counts.get(institution) ?? { institution, prescriptions: 0, multi: 0 };
      count.prescriptions++;
      if (entry.qrs > 1) count.multi++;
      counts.set(institution, count);
    }
    return [...counts.values()].filter(count => count.multi).sort((a, b) => b.multi - a.multi || a.institution.localeCompare(b.institution));
  }
  get multi() { return this.entries.filter(entry => entry.ok && entry.qrs > 1).length; }
  qrs() { return this.entries.map(entry => entry.qrs); }
  get collected() { return this.entries.filter(entry => entry.ok).length; }
  get failed() { return this.entries.length - this.collected; }
  lines() { return this.entries.map(entry => entry.line); }
  text() { return this.entries.map(entry => `${entry.line}\n`).join(''); }
  clear() { this.entries = []; }
}
