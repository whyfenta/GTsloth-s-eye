// 樹懶的管理: the review record a user may export and send back, so recurring corrections can become rules and tests.
// It keeps what shows where the parser or a warning was wrong, never the store's quantities: a changed count,
// quantity or stock figure is recorded by field name only. Nothing is uploaded; the user saves the file and decides.
import type { PartnerCover, SafetyStrategy, StockRow, UsageRow } from './management-model';

export const FEEDBACK_FORMAT = 'gtsloth-management-review';
type Report = 'usage' | 'inventory';
type Row = UsageRow | StockRow;
/** Fields whose values are the store's own figures: only the fact that they changed is exported. */
const FIGURES = new Set(['count', 'quantity', 'qty']);
const FIELDS = { usage: ['sku', 'unit', 'count', 'quantity'], inventory: ['sku', 'name', 'location', 'qty'] } as const;
const USER_EXCLUSION = '使用者排除：';

export type FeedbackRecord = {
  format: typeof FEEDBACK_FORMAT; version: 1; app: string; exported: string;
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
  safetyStrategy: SafetyStrategy; partnerClinic: boolean; partnerCover: PartnerCover; app: string; exported: string;
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
  return { format: FEEDBACK_FORMAT, version: 1, app: input.app, exported: input.exported,
    options: { safetyStrategy: input.safetyStrategy, partnerClinic: input.partnerClinic, partnerCover: input.partnerCover },
    summary: { usageRows: input.usageRows.length, stockRows: input.stockRows.length, flagged, edited, confirmedAsIs: confirmedAsIs.length, userExcluded: exclusions.length, autoExcluded },
    names, edits, confirmedAsIs, exclusions };
}
