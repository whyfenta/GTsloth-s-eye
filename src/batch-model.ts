// 批次蒐集 (樹懶的算數): the collector's de-identified lines, scanned in one go at the end of a shift and sent to the sample sheet
// on 確認匯入 instead of saved as a .txt. Each prescription's patient (ID number, name, birth date as scanned) stays in page memory
// only, so one patient's prescriptions are listed and checked together and the sheet gets what only the combined check finds
// (合併多出), as a printed 憑單 sends it. Nothing that links the lines leaves the page.
import { parseDrugsLayout, parsePrescriptionLayout, splitFields } from './prescription-qr';
import { failureLine, SampleLog, type Recorded, type Sample } from './prescription-sample';
import { MAX_BATCH, MAX_FAILED, mergedCheck, sampleRecords, type SampleInput, type SampleRecord } from './rx-sample';
import type { RxData } from './rx-data';
import { patientGroups, type Person } from './slip-model';

/** The patient fields of a first QR as the 憑單 reads them (fields 4, 5, 6); undefined when the scan is not one. */
export function personOf(scanned: string): Person | undefined {
  try {
    const { fields } = parsePrescriptionLayout(scanned);
    const idNumber = fields[4].trim().toUpperCase();
    return { idNumber: /^[A-Z][0-9A-D*][0-9*]{8}$/.test(idNumber) ? idNumber : '', name: fields[3].trim(), birth: fields[5].trim() };
  } catch { return undefined; }
}
const isDrugsOnly = (scanned: string) => { try { return !!parseDrugsLayout(scanned); } catch { return false; } };
/** A name on screen with its middle hidden (王○明, 王○), enough to tell two patients apart while checking the list. */
export function maskedName(name: string): string {
  const chars = [...name.replace(/\s+/g, '')];
  if (!chars.length) return '';
  if (chars.length <= 2) return `${chars[0]}○`;
  return `${chars[0]}${'○'.repeat(chars.length - 2)}${chars.at(-1)}`;
}

/** The browser's copy: lines and QR counts as on the collector, each line's patient as a number (-1: alone), and what was sent. */
export interface SavedBatch { version: 1; lines: string[]; qrs: number[]; patients: number[]; sent: boolean[] }
/** One request, and the prescriptions and failure lines it carries, so a request that goes out is not sent again. */
export interface BatchRequest { record: SampleRecord; entries: Sample[] }

export class BatchLog extends SampleLog {
  private people = new WeakMap<Sample, Person>();
  /** Lines restored from the browser keep their patient by number; there is no person left to match a new scan to them. */
  private tags = new WeakMap<Sample, number>();
  private sentEntries = new WeakSet<Sample>();

  /** A scan, as the collector records it; codes: how many linked QR codes (Structured Append) the text was joined from. */
  scan(key: string, scanned: string, codes = 1): Recorded {
    // A drugs-only second QR joins the line before it, which must not change once sent.
    const last = this.entries.at(-1);
    if (last && this.sentEntries.has(last) && !this.entries.some(entry => entry.key === key) && isDrugsOnly(scanned)) {
      this.entries.push({ line: failureLine(scanned, new Error('只有藥品的第 2 個 QR，但前一張處方已經匯入')), ok: false, key, qrs: 1 });
      return { state: 'failed', index: this.entries.length - 1 };
    }
    const result = this.record(key, scanned);
    if (result.state === 'added') {
      const entry = this.entries[result.index];
      entry.qrs = codes;
      const person = personOf(scanned);
      if (person) this.people.set(entry, person);
    }
    return result;
  }
  person(entry: Sample): Person | undefined { return this.people.get(entry); }
  /** Restored from the browser: no person, so the line keeps the patient number it was saved with. */
  restored(entry: Sample): boolean { return !this.people.has(entry); }
  isSent(entry: Sample): boolean { return this.sentEntries.has(entry); }
  /**
   * The prescriptions by patient, as entry indices in scan order, the groups in the order of their first prescription. Scans of
   * this page load are grouped as the 憑單 groups its cards (samePerson); restored lines by their saved number; failures are left out.
   */
  groups(): number[][] {
    const ok = this.entries.flatMap((entry, i) => entry.ok ? [i] : []);
    const known = ok.filter(i => this.people.has(this.entries[i]));
    const groups = patientGroups(known.map(i => this.people.get(this.entries[i])!)).map(group => group.map(j => known[j]));
    const tagged = new Map<number, number[]>();
    for (const i of ok) {
      if (this.people.has(this.entries[i])) continue;
      const tag = this.tags.get(this.entries[i]);
      if (tag === undefined) groups.push([i]);
      else tagged.set(tag, [...(tagged.get(tag) ?? []), i]);
    }
    return [...groups, ...tagged.values()].sort((a, b) => a[0] - b[0]);
  }
  /** The lines of the same patient as entry i, itself included, when there are several. */
  private patientLines(groups: number[][], i: number): string[] | undefined {
    const group = groups.find(members => members.includes(i));
    return group && group.length > 1 ? group.map(j => this.entries[j].line) : undefined;
  }
  /** What checking with the patient's other prescriptions adds to entry i (rule numbers only), as the 憑單 sends it. */
  merged(i: number, data: RxData, groups = this.groups()): string[] {
    const patient = this.patientLines(groups, i);
    return patient ? mergedCheck(this.entries[i].line, patient, data) : [];
  }
  remove(index: number) { this.entries.splice(index, 1); }
  /** The prescriptions and failure lines not sent yet. */
  get unsent(): Sample[] { return this.entries.filter(entry => !this.sentEntries.has(entry)); }
  /**
   * The requests for what is not sent yet: MAX_BATCH prescriptions and MAX_FAILED failure lines each, as the sheet takes them.
   * A prescription goes with the lines of the patient's other prescriptions, sent or not, for the combined check; catalog, once
   * loaded, gives the 健保碼 without a 六碼 (對照檔查無).
   */
  requests(data: RxData | undefined, catalog: Map<string, unknown[]> | undefined, app: string, sent: string): BatchRequest[] {
    const groups = this.groups();
    const unsent = this.unsent;
    const lines = unsent.filter(entry => entry.ok), failures = unsent.filter(entry => !entry.ok);
    const input = (entry: Sample): SampleInput => {
      const patient = this.patientLines(groups, this.entries.indexOf(entry));
      const codes = splitFields(entry.line).filter((_, i) => i >= 14 && (i - 14) % 5 === 0);
      return { line: entry.line, qrs: entry.qrs, ...(catalog ? { unmapped: codes.filter(code => !catalog.get(code.trim().toUpperCase())?.length) } : {}),
        ...(patient ? { patient } : {}) };
    };
    const requests: BatchRequest[] = [];
    for (let i = 0, j = 0; i < lines.length || j < failures.length; i += MAX_BATCH, j += MAX_FAILED) {
      const someLines = lines.slice(i, i + MAX_BATCH), someFailures = failures.slice(j, j + MAX_FAILED);
      const [record] = sampleRecords(someLines.map(input), someFailures.map(entry => entry.line), data, app, sent);
      requests.push({ record, entries: [...someLines, ...someFailures] });
    }
    return requests;
  }
  markSent(entries: Sample[]) { for (const entry of entries) this.sentEntries.add(entry); }

  save(): SavedBatch {
    const groups = this.groups().filter(group => group.length > 1);
    return { version: 1, lines: this.lines(), qrs: this.qrs(), sent: this.entries.map(entry => this.sentEntries.has(entry)),
      patients: this.entries.map((_, i) => groups.findIndex(group => group.includes(i))) };
  }
  /** A saved batch as save() wrote it; anything else leaves the log empty. */
  load(saved: unknown): boolean {
    const value = saved as Partial<SavedBatch> | null;
    const lines = value?.lines, n = lines?.length ?? 0;
    const valid = value?.version === 1 && Array.isArray(lines) && lines.every(line => typeof line === 'string')
      && [value.qrs, value.patients, value.sent].every(list => Array.isArray(list) && list.length === n)
      && value.qrs!.every(q => Number.isInteger(q) && q >= 1) && value.patients!.every(p => Number.isInteger(p) && p >= -1)
      && value.sent!.every(s => typeof s === 'boolean');
    if (!valid) return false;
    this.restore(lines!, value.qrs);
    this.entries.forEach((entry, i) => {
      if (value.patients![i] >= 0) this.tags.set(entry, value.patients![i]);
      if (value.sent![i]) this.sentEntries.add(entry);
    });
    return true;
  }
}
