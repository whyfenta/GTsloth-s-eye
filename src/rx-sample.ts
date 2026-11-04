// 憑單 samples: each printed prescription as the collector's de-identified line (src/prescription-sample.ts), sent to the
// sample sheet (docs/rx-samples-apps-script.gs) so the rules keep learning from every store. A line carries what the
// collector keeps and nothing else; the check summary is worked out again from that line, never from the scan.
import { postAppsScript } from './apps-script';
import { markedSex, rxFacts, splitFields } from './prescription-qr';
import { deidentify, deidentifyDrugs, failureLine, scanKey } from './prescription-sample';
import { checkPrescription, dxLabel, type Level } from './rx-check';
import type { RxData } from './rx-data';

export const SAMPLE_FORMAT = 'gtsloth-rx-samples';
/** Prescriptions per request; a larger slip is sent in several. */
export const MAX_BATCH = 20;
/** Failure lines kept until the next print: enough to see a new layout, not a log of every stray scan. */
export const MAX_FAILED = 50;
const FAILED = '失敗：';

/** One prescription as the collector writes it, and how many QRs it was scanned from. */
export interface PendingSample { line: string; qrs: number }
/**
 * What the rules made of a line: the highest level, each red or yellow drug and note, the cautions that fired (any level),
 * the drugs no diagnosis or department explains, and the codes the NHI drug list or ICD-10-CM table does not know.
 */
export interface SampleCheck { top: Level | ''; alerts: string[]; cautions: string[]; unexplained: string[]; unknownDrugs: string[]; unknownDx: string[] }
export interface SampleRecord {
  format: typeof SAMPLE_FORMAT; version: 1; app: string; sent: string;
  /** rules.json's version, blank when the rules could not be loaded and no line was checked. */
  rules: string;
  prescriptions: { line: string; qrs: number; check?: SampleCheck }[];
  failed: string[];
}

export const isFailure = (line: string) => line.startsWith(FAILED);
/** The first QR of a prescription as its sample line, or the failure line the collector would write. */
export function sampleOf(scanned: string): PendingSample {
  try { return { line: deidentify(scanned), qrs: 1 }; } catch (error) { return { line: failureLine(scanned, error), qrs: 1 }; }
}
/** A drugs-only second QR joins its prescription's line, as on the collector; a failed line stays as it is. */
export function withDrugs(sample: PendingSample, scanned: string): { sample: PendingSample; failed?: string } {
  if (isFailure(sample.line)) return { sample };
  try {
    const drugs = deidentifyDrugs(scanned);
    return drugs ? { sample: { line: sample.line + drugs, qrs: sample.qrs + 1 } } : { sample };
  } catch (error) { return { sample, failed: failureLine(scanned, error) }; }
}

const RANK: Record<Level, number> = { 紅: 0, 黃: 1, 灰: 2 };
const higher = (a: Level | '', b: Level): Level | '' => !a || RANK[b] < RANK[a] ? b : a;
const urgent = (level: string): level is '紅' | '黃' => level === '紅' || level === '黃';
/** The check as a pharmacist re-running the line would get it: plain codes, no names. */
export function sampleCheck(line: string, data: RxData): SampleCheck {
  const fields = splitFields(line);
  const rx = rxFacts(fields, fields[5].trim().toUpperCase(), markedSex(fields[4]));
  const result = checkPrescription(rx, data.drugs, data.rules);
  const check: SampleCheck = { top: '', alerts: [], cautions: [], unexplained: [], unknownDrugs: [], unknownDx: [] };
  for (const note of result.notes) {
    check.top = higher(check.top, note.level);
    if (urgent(note.level)) check.alerts.push(`${note.level} ${note.text}`);
  }
  for (const drug of result.drugs) {
    const atc = drug.info?.atc ?? '';
    if (!drug.info) check.unknownDrugs.push(drug.code);
    if (urgent(drug.verdict)) check.alerts.push(`${drug.verdict} ${drug.code} ${atc} ${drug.reason}`);
    if (drug.verdict === '灰' && rx.dx.length) check.unexplained.push(`${drug.code} ${atc}`);
    if (drug.verdict === '紅' || drug.verdict === '黃' || drug.verdict === '灰') check.top = higher(check.top, drug.verdict);
    for (const note of drug.notes) {
      check.top = higher(check.top, note.level);
      if (urgent(note.level)) check.alerts.push(`${note.level} ${drug.code} ${atc} ${note.text}`);
      // A drug's notes are its cautions, each starting with the caution's 編號.
      check.cautions.push(`${note.text.split(' ')[0]}${note.level}`);
    }
  }
  for (const code of rx.dx) {
    const label = dxLabel(code, data.icd);
    const kind = label.endsWith('（查無此碼）') ? '查無' : label.includes('2014 版已刪除') ? '舊碼' : label.includes(`（查無 ${code}，此為類別）`) ? '類別' : '';
    if (kind) check.unknownDx.push(`${code} ${kind}`);
  }
  return check;
}

/** The requests for a printed slip: at most MAX_BATCH prescriptions each, failures with the first. */
export function sampleRecords(samples: PendingSample[], failed: string[], data: RxData | undefined, app: string, sent: string): SampleRecord[] {
  const lines = samples.filter(sample => !isFailure(sample.line));
  const failures = [...samples.filter(sample => isFailure(sample.line)).map(sample => sample.line), ...failed].slice(0, MAX_FAILED);
  const records: SampleRecord[] = [];
  for (let i = 0; i < lines.length || (i === 0 && failures.length); i += MAX_BATCH) {
    records.push({ format: SAMPLE_FORMAT, version: 1, app, sent, rules: data?.rulesVersion ?? '',
      prescriptions: lines.slice(i, i + MAX_BATCH).map(({ line, qrs }) => ({ line, qrs, ...(data ? { check: sampleCheck(line, data) } : {}) })),
      failed: i === 0 ? failures : [] });
  }
  return records;
}
export async function sendSamples(records: SampleRecord[], endpoint: string, post: typeof fetch = fetch): Promise<void> {
  for (const record of records) await postAppsScript(endpoint, record, post);
}

/** How long a failure waits before it is sent, so a QR rescanned at once and the scans around it go in one request. */
export const FAILURE_DELAY = 5_000;
/**
 * Failure lines of scans the 憑單 turned down. A QR the slip cannot read is usually written by hand and never printed, so its
 * line is sent shortly after the scan rather than waiting for a print; a print still takes the lines not yet sent. The same QR
 * turned down again is kept once, matched by the SHA-256 of its text in page memory. A send that fails keeps its lines for the
 * next failure or print.
 */
export class FailureLog {
  private lines: string[] = [];
  private keys = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly send: (failed: string[]) => Promise<void>, private readonly delay = FAILURE_DELAY) {}
  /** Keeps the failure line of a scan unless the same text was turned down before, and sends it after the delay. */
  async add(scanned: string, line: string): Promise<void> {
    // Without a secure context there is no digest: the line is kept, only not matched against earlier ones.
    const key = await scanKey(scanned).catch(() => undefined);
    if (key && this.keys.has(key)) return;
    if (key) this.keys.add(key);
    this.lines = [...this.lines, line].slice(0, MAX_FAILED);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }
  /** The lines not yet sent, for a printed slip's request. */
  take(): string[] {
    clearTimeout(this.timer);
    this.timer = undefined;
    const lines = this.lines;
    this.lines = [];
    return lines;
  }
  /** Lines a request could not send, kept ahead of newer ones for the next failure or print. */
  restore(lines: string[]) { this.lines = [...lines, ...this.lines].slice(0, MAX_FAILED); }
  /** Sends the waiting lines now: the delay is up, or the page is closing. */
  async flush(): Promise<void> {
    const lines = this.take();
    if (!lines.length) return;
    try { await this.send(lines); } catch { this.restore(lines); }
  }
}
