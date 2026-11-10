import { createHash } from 'node:crypto';
import { RULE_FILES, type RuleFile, type RuleTables } from '../src/rx-check';

// docs/reference/rx-rules-review.json remembers, for the pharmacists' review page (review/), which rule has which id, when its
// content last changed, why it was proposed and how its review ended. A decision made before a rule's `changed` no longer counts,
// so an edited rule comes back for review. Votes in progress stay in the team's sheet (docs/rx-review-apps-script.gs); what is
// written here is the close of a review: `approved` (the reviewers agreed, nothing changed) or `outcome` (an opinion carried out).
// No sample content and no reviewer's name goes in here: the repository is public.
export interface ReviewLink { t: string; u: string }
/** A review closed as it stands: the day it was closed and how many reviewers agreed (nobody objected). */
export interface Approval { at: string; n: number }
export interface ReviewNotes { why?: string; ref?: string; links?: ReviewLink[]; flags?: string[]; outcome?: string; approved?: Approval }
/** A weekly-review proposal (P + the week's date + a number) once the team has dealt with it; open ones live in the team's Drive folder. */
export interface ClosedProposal { id: string; title: string; status: '已採用' | '不採用' | '需更多樣本'; decided: string; note?: string; rules?: string[] }
export interface LedgerRule extends ReviewNotes { id: string; table: RuleFile; key: string; fp: string; text: string; batch: string; changed: string; prev?: string }
export interface LedgerQuestion extends ReviewNotes { id: string; title: string; desc: string; batch: string; changed: string }
export interface RetiredRule { id: string; table: RuleFile; text: string; batch: string; retired: string; outcome?: string }
export interface Batch { id: string; title: string; note?: string }
export interface Ledger { batches: Batch[]; rules: LedgerRule[]; questions: LedgerQuestion[]; retired: RetiredRule[]; atcZh: Record<string, string>; proposals?: ClosedProposal[] }
export interface LedgerRow { table: RuleFile; row: Record<string, string>; rule: LedgerRule }

type Row = Record<string, string>;
/** key: what stays the same when a row is edited. content: the columns that change what the rule does; 備註 and 說明 do not. */
const DESCRIBE: Record<RuleFile, (r: Row) => { key: string; content: string[]; text: string }> = {
  indications: r => ({ key: r['ATC'], content: [r['ATC'], r['可解釋的ICD-10'], r['依據']], text: `${r['ATC']} ${r['藥理類別']}：${r['可解釋的ICD-10']}（${r['依據']}）` }),
  'co-drugs': r => ({ key: r['ATC'], content: [r['ATC'], r['可由同處方的ATC解釋'], r['依據']], text: `${r['ATC']} 可由同處方 ${r['可由同處方的ATC解釋']} 解釋（${r['依據']}）` }),
  cautions: r => ({ key: r['編號'], content: [r['ATC'], r['成分關鍵字'], r['條件類型'], r['條件'], r['等級'], r['提示']],
    text: `${r['編號']} ${r['ATC'] || r['成分關鍵字']} ${r['條件類型']} ${r['條件']} → ${r['等級']}：${r['提示']}` }),
  specialty: r => ({ key: r['科別代碼'], content: [r['該科常開的ATC']], text: `${r['科別代碼']} ${r['科別']}：${r['該科常開的ATC']}` }),
  'drug-classes': r => ({ key: `${r['ATC']}|${r['類型']}`, content: [r['ATC'], r['類型']], text: `${r['ATC']} ${r['類型']}：${r['說明']}` }),
  settings: r => ({ key: r['設定'], content: [r['值']], text: `${r['設定']}＝${r['值']}（可選：${r['可選的值']}）` }),
};
const fingerprint = (content: string[]) => createHash('sha256').update(JSON.stringify(content.map(cell => cell.split(/\s+/).filter(Boolean).join(' ')))).digest('hex').slice(0, 12);
const PREFIX: Partial<Record<RuleFile, [string, number]>> = { indications: ['I', 2], 'co-drugs': ['D', 2], 'drug-classes': ['K', 2], settings: ['X', 1] };
function newId(table: RuleFile, key: string, used: Set<string>): string {
  if (table === 'cautions') return key;
  if (table === 'specialty') return `S${key}`;
  const [prefix, width] = PREFIX[table]!;
  let n = 1;
  for (const id of used) if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) n = Math.max(n, Number(id.slice(prefix.length)) + 1);
  return `${prefix}${String(n).padStart(width, '0')}`;
}

/**
 * The ledger after the tables as they are now. A row keeps its id when its content is unchanged (wherever it moved in the file) or
 * when it shares the ledger row's key. A changed row comes back for review (its outcome and approval are dropped), unless `applied`
 * names it: then the change is the pharmacists' own decision, recorded as its outcome. A rule no longer in the tables is retired.
 */
export function reconcile(tables: RuleTables, ledger: Ledger, options: { batch: string; now: string; applied?: Record<string, string> }) {
  const { batch, now, applied = {} } = options;
  const used = new Set([...ledger.rules.map(rule => rule.id), ...ledger.retired.map(rule => rule.id)]);
  const rows: LedgerRow[] = [], added: string[] = [], changed: string[] = [], retiring: LedgerRule[] = [];
  for (const table of RULE_FILES) {
    const free = new Set(ledger.rules.filter(rule => rule.table === table));
    const described = tables[table].map(row => { const d = DESCRIBE[table](row); return { row, ...d, fp: fingerprint(d.content), known: undefined as LedgerRule | undefined }; });
    const claim = (test: (rule: LedgerRule, d: typeof described[number]) => boolean) => {
      for (const d of described) {
        if (d.known) continue;
        d.known = [...free].find(rule => test(rule, d));
        if (d.known) free.delete(d.known);
      }
    };
    claim((rule, d) => rule.key === d.key && rule.fp === d.fp);
    claim((rule, d) => rule.key === d.key);
    for (const d of described) {
      let rule: LedgerRule;
      if (!d.known) {
        const id = newId(table, d.key, used);
        used.add(id); added.push(id);
        rule = { id, table, key: d.key, fp: d.fp, text: d.text, batch, changed: now };
      } else if (d.known.fp === d.fp) rule = { ...d.known, text: d.text };
      else {
        changed.push(d.known.id);
        const { outcome: _old, approved: _closed, ...kept } = d.known;
        rule = applied[d.known.id] ? { ...d.known, fp: d.fp, text: d.text, prev: d.known.text, outcome: applied[d.known.id] }
          : { ...kept, fp: d.fp, text: d.text, prev: d.known.text, changed: now };
      }
      rows.push({ table, row: d.row, rule });
    }
    retiring.push(...free);
  }
  const retired = [...ledger.retired, ...retiring.map(({ id, table, text, batch: from, outcome }): RetiredRule => ({ id, table, text, batch: from, retired: now, ...(outcome ? { outcome } : {}) }))];
  return { ledger: { ...ledger, rules: rows.map(row => row.rule), retired }, rows, added, changed, retired: retiring.map(rule => rule.id) };
}
/** What `npm test` asks: does the ledger already know the tables as they are? */
export function unsynced(tables: RuleTables, ledger: Ledger): string[] {
  const result = reconcile(tables, ledger, { batch: '', now: '' });
  return [...result.added, ...result.changed, ...result.retired];
}
