// 樹懶的管理: the review record sent to the feedback sheet when lists are generated, so recurring corrections can become
// rules and tests. It keeps what shows where the parser or a warning was wrong, never the store's quantities: a changed
// count, quantity, 健保價 or stock figure is recorded by field name only. The report files themselves are never sent.
import type { PartnerCover, SafetyStrategy, StockRow, UsageRow } from './management-model';

export const FEEDBACK_FORMAT = 'gtsloth-management-review';
type Report = 'usage' | 'inventory';
type Row = UsageRow | StockRow;
/** Fields whose values are the store's own figures: only the fact that they changed is sent. */
const FIGURES = new Set(['count', 'quantity', 'price', 'qty']);
const FIELDS = { usage: ['sku', 'unit', 'count', 'quantity', 'price'], inventory: ['sku', 'name', 'location', 'qty'] } as const;
const USER_EXCLUSION = '使用者排除：';

export type FeedbackRecord = {
  format: typeof FEEDBACK_FORMAT; version: 2; app: string; sent: string;
  /** The store number printed on the reports (26 for 26永和福和店); no store name, period or file. */
  store?: number;
  options: { safetyStrategy: SafetyStrategy; partnerClinic: boolean; partnerCover: PartnerCover };
  summary: { usageRows: number; stockRows: number; flagged: number; edited: number; confirmedAsIs: number; userExcluded: number; autoExcluded: number };
  /** Stock-sheet names the reviewer corrected: the printed name, the automatic cleaning and the correction. */
  names: { sku: string; rawName: string; cleaned: string; corrected: string; notes: string[] }[];
  /** Other edited fields. Figures carry no before / after. */
  edits: { report: Report; sku: string; rawName: string; field: string; before?: string; after?: string }[];
  /** Rows flagged for review that the reviewer confirmed without any change: likely false alarms. */
  confirmedAsIs: { report: Report; sku: string; rawName: string; name?: string; notes: string[] }[];
  exclusions: { report: Report; sku: string; rawName: string; reason: string }[];
};
export type FeedbackInput = {
  /** Each row as parsed, before any edit. A row the parser left unconfirmed (reviewed: false) was flagged for review. */
  originals: Map<string, Row>; usageRows: UsageRow[]; stockRows: StockRow[];
  safetyStrategy: SafetyStrategy; partnerClinic: boolean; partnerCover: PartnerCover; app: string; sent: string; store?: number;
};
const reportOf = (row: Row): Report => 'unit' in row ? 'usage' : 'inventory';
const field = (row: Row, name: string) => (row as Record<string, unknown>)[name] as string;

export function feedbackRecord(input: FeedbackInput): FeedbackRecord {
  const names: FeedbackRecord['names'] = []; const edits: FeedbackRecord['edits'] = []; const confirmedAsIs: FeedbackRecord['confirmedAsIs'] = []; const exclusions: FeedbackRecord['exclusions'] = [];
  let flagged = 0; let edited = 0; let autoExcluded = 0;
  for (const row of [...input.stockRows, ...input.usageRows]) {
    const report = reportOf(row); const before = input.originals.get(row.id) ?? row;
    const wasFlagged = !before.reviewed && !before.excluded; if (wasFlagged) flagged++;
    const changed = FIELDS[report].filter(name => field(row, name) !== field(before, name));
    if (changed.length) edited++;
    for (const name of changed) {
      if (name === 'name') names.push({ sku: row.sku, rawName: row.rawName, cleaned: field(before, name), corrected: field(row, name), notes: before.notes });
      else edits.push({ report, sku: before.sku, rawName: row.rawName, field: name, ...(FIGURES.has(name) ? {} : { before: field(before, name), after: field(row, name) }) });
    }
    if (row.excluded?.startsWith(USER_EXCLUSION)) exclusions.push({ report, sku: row.sku, rawName: row.rawName, reason: row.excluded.slice(USER_EXCLUSION.length) });
    else if (row.excluded) autoExcluded++;
    else if (!changed.length && row.reviewed && wasFlagged)
      confirmedAsIs.push({ report, sku: row.sku, rawName: row.rawName, ...(report === 'inventory' ? { name: (row as StockRow).name } : {}), notes: row.notes });
  }
  const store = input.store !== undefined && Number.isInteger(input.store) ? input.store : undefined;
  return { format: FEEDBACK_FORMAT, version: 2, app: input.app, sent: input.sent, ...(store !== undefined ? { store } : {}),
    options: { safetyStrategy: input.safetyStrategy, partnerClinic: input.partnerClinic, partnerCover: input.partnerCover },
    summary: { usageRows: input.usageRows.length, stockRows: input.stockRows.length, flagged, edited, confirmedAsIs: confirmedAsIs.length, userExcluded: exclusions.length, autoExcluded },
    names, edits, confirmedAsIs, exclusions };
}

/** Only a review with something to learn from is sent: a correction, a false alarm or a user exclusion. */
export const worthSending = (record: FeedbackRecord) => record.names.length + record.edits.length + record.confirmedAsIs.length + record.exclusions.length > 0;
/** The same review is sent once, whenever lists are generated again; the send time does not make it new. */
export const feedbackKey = (record: FeedbackRecord) => JSON.stringify({ ...record, sent: '' });
/**
 * Posts the record to the Apps Script web app. text/plain keeps it a simple request (Apps Script answers no CORS
 * preflight), so the response is opaque: success cannot be read, only a network failure.
 */
export async function sendFeedback(record: FeedbackRecord, endpoint: string, post: typeof fetch = fetch): Promise<void> {
  const body = JSON.stringify(record);
  await post(endpoint, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, keepalive: body.length < 60_000 });
}
