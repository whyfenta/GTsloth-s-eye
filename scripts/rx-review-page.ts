import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markedSex, rxFacts, splitFields } from '../src/prescription-qr';
import { atcHit, BASIS_RANK, checkPrescription, compileRules, icdHits, ingredientBases, normCode, ruleTable, RULE_FILES, type RuleTables } from '../src/rx-check';
import { readRxData, rulesVersion } from '../src/rx-data';
import { isFailure } from '../src/rx-sample';
import { reconcile, type Batch, type ClosedProposal, type Ledger, type LedgerQuestion, type LedgerRow, type ReviewNotes } from './rx-review-ledger';

// Usage: npm run rx-review-page -- 樣本1.txt [樣本2.txt …] [--notes 說明.json] [--batch YYYY-MM-DD] [--out 檔案]
// Brings docs/reference/rx-rules-review.json up to date with docs/reference/rx-rules/*.csv and writes what the pharmacists' review
// page (review/) shows, public/assets/rx/review.json: every rule with its Chinese drug and diagnosis names, how often the samples
// used it (counts only, no sample content), and whether its review is closed. The page reads that file, so a rule change reaches
// the reviewers when it is published; npm test fails while the file is behind. Without samples the counts of the last run are
// kept for the rules that did not change, and a new or changed rule shows none.
// --notes adds what the tables cannot say, keyed by rule id: { batch: {title, note}, rules: {C42: {why, ref, links, flags, outcome,
// applied, approved: {at, n}}}, questions: [{id, title, desc, why, links, outcome}], proposals: [{id, title, status, decided, note,
// rules}], atcZh: {N05AX: "…"} }. `applied` marks an edit as the pharmacists' own decision; `approved` closes a review the team
// agreed on (the day and how many agreed); `proposals` records what became of a weekly-review proposal.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const notesFile = flag('--notes'), batchFlag = flag('--batch'), out = flag('--out') ?? path.join(root, 'public', 'assets', 'rx', 'review.json');
const sampleFiles = args;
const LEDGER = path.join(root, 'docs', 'reference', 'rx-rules-review.json');

interface Notes { batch?: Omit<Batch, 'id'>; rules?: Record<string, ReviewNotes & { applied?: string }>; questions?: (ReviewNotes & { id: string; title?: string; desc?: string })[]; proposals?: ClosedProposal[]; atcZh?: Record<string, string> }
const notes: Notes = notesFile ? JSON.parse(readFileSync(notesFile, 'utf8')) : {};
const now = new Date().toISOString();
const batch = batchFlag ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

const csvBytes = Object.fromEntries(RULE_FILES.map(file => [file, readFileSync(path.join(root, 'docs', 'reference', 'rx-rules', `${file}.csv`))]));
const tables = Object.fromEntries(RULE_FILES.map(file => [file, ruleTable(csvBytes[file].toString('utf8'))])) as RuleTables;
const previous: Ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
const applied = Object.fromEntries(Object.entries(notes.rules ?? {}).filter(([, note]) => note.applied).map(([id, note]) => [id, note.applied!]));
const result = reconcile(tables, previous, { batch, now, applied });
const ledger: Ledger = { ...result.ledger, atcZh: { ...result.ledger.atcZh, ...notes.atcZh } };

// Notes for a rule, and questions: a question is new, or an update to the one with its id.
for (const row of result.rows) {
  const { applied: _done, ...note } = notes.rules?.[row.rule.id] ?? {};
  Object.assign(row.rule, note);
}
ledger.rules = result.rows.map(row => row.rule);
const questions: LedgerQuestion[] = [...ledger.questions];
for (const { id, ...rest } of notes.questions ?? []) {
  const at = questions.findIndex(question => question.id === id);
  if (at >= 0) questions[at] = { ...questions[at], ...rest };
  else if (rest.title && rest.desc) questions.push({ id, ...rest, title: rest.title, desc: rest.desc, batch, changed: now });
  else throw new Error(`--notes 的問題 ${id} 不在紀錄裡，新問題要有 title 與 desc。`);
}
ledger.questions = questions;
// What became of the weekly review's proposals: a later note for the same id replaces the earlier one.
const closedProposals = new Map((ledger.proposals ?? []).map(item => [item.id, item]));
for (const item of notes.proposals ?? []) closedProposals.set(item.id, item);
if (closedProposals.size) ledger.proposals = [...closedProposals.values()].sort((a, b) => a.id.localeCompare(b.id));
const batches = [...ledger.batches];
const usedBatches = new Set([...ledger.rules.map(rule => rule.batch), ...questions.map(question => question.batch)]);
if (usedBatches.has(batch) && !batches.some(item => item.id === batch)) batches.push({ id: batch, title: notes.batch?.title ?? `${batch} 新增` });
if (notes.batch) { const item = batches.find(entry => entry.id === batch); if (item) Object.assign(item, notes.batch); }
ledger.batches = batches;

const json = (name: string) => JSON.parse(readFileSync(path.join(root, 'public', 'assets', 'rx', `${name}.json`), 'utf8'));
const rules = compileRules(tables);
const data = { ...readRxData(json('rules'), json('drugs'), json('icd10cm')), rules };

// What the samples did with each rule.
const hits = new Map<string, number>(), seenCodes = new Map<string, number>();
const bump = <K>(map: Map<K, number>, key: K | undefined, n = 1) => { if (key !== undefined) map.set(key, (map.get(key) ?? 0) + n); };
const rowsOf = (table: string) => result.rows.filter(row => row.table === table);
const settingId = (name: string) => result.rows.find(row => row.table === 'settings' && row.row['設定'] === name)?.rule.id;
const byBasis = [...rowsOf('indications')].sort((a, b) => (BASIS_RANK[a.row['依據']] ?? 9) - (BASIS_RANK[b.row['依據']] ?? 9));
const tokens = (value: string) => value.split(/\s+/).filter(Boolean);
let sampleCount = 0, drugCount = 0;
for (const file of sampleFiles) {
  for (const line of readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    if (!line.trim() || isFailure(line)) continue;
    const fields = splitFields(line);
    const rx = rxFacts(fields, fields[5].trim().toUpperCase(), markedSex(fields[4]));
    const check = checkPrescription(rx, data.drugs, rules);
    sampleCount++;
    for (const note of check.notes) if (note.text.startsWith('同成分重複')) bump(hits, settingId('同成分重複'));
    for (const drug of check.drugs) {
      if (!drug.info) continue;
      drugCount++;
      bump(seenCodes, drug.code);
      const { atc } = drug.info;
      if (drug.verdict === '適應症') bump(hits, byBasis.find(({ row }) => atcHit(atc, tokens(row['ATC'])) && icdHits(rx.dx, tokens(row['可解釋的ICD-10'])).length)?.rule.id);
      else if (drug.verdict === '同處方') {
        const others = rx.drugs.filter(other => other.code !== drug.code).map(other => data.drugs.get(other.code)?.atc).filter((value): value is string => !!value);
        bump(hits, rowsOf('co-drugs').find(({ row }) => atcHit(atc, tokens(row['ATC'])) && others.some(other => atcHit(other, tokens(row['可由同處方的ATC解釋']))))?.rule.id);
      } else if (drug.verdict === '科別常用') {
        bump(hits, rowsOf('specialty').find(({ row }) => row['科別代碼'] === rx.dept)?.rule.id);
        bump(hits, settingId('科別常用'));
      } else if (drug.verdict === '低風險') bump(hits, rowsOf('drug-classes').find(({ row }) => row['類型'] === '低風險' && atcHit(atc, tokens(row['ATC'])))?.rule.id);
      else if (drug.verdict === '黃') bump(hits, rowsOf('drug-classes').find(({ row }) => row['類型'] === '高警訊' && atcHit(atc, tokens(row['ATC'])))?.rule.id);
      for (const note of drug.notes) bump(hits, note.text.split(' ')[0]);
    }
  }
}
// Without samples: the counts the last catalog had, for the rules that have not changed since.
interface Earlier { samples: unknown; items: { id: string; changed: string; hits: number | null }[]; atc?: Record<string, { zh: string; ex: string[]; n: number; seen: number }> }
const earlier: Earlier | undefined = !sampleFiles.length && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
const earlierHits = new Map((earlier?.items ?? []).map(item => [item.id, item]));
const hitCount = (id: string, changed: string) => sampleFiles.length ? hits.get(id) ?? 0
  : earlierHits.get(id)?.changed === changed ? earlierHits.get(id)!.hits : null;

// Chinese names for diagnoses: a code or a range, as the rules write them.
const icd: { codes: Record<string, string>; deleted: Record<string, string> } = json('icd10cm');
const icdName = (code: string) => icd.codes[normCode(code)] ?? icd.deleted[normCode(code)] ?? '';
const chip = (token: string) => {
  const ends = token.split('-');
  return { t: token, zh: ends.length === 2 ? ends.map(icdName).filter(Boolean).join(' … ') : icdName(token) };
};
const chips = (value: string) => tokens(value).map(chip);

// Each ATC prefix the rules use: its Chinese class name and the ingredients under it, those seen in the samples first.
const nhi = new Map<string, { atc: string; label: string; en: string }>();
for (const row of ruleTable(readFileSync(path.join(root, 'docs', 'reference', 'nhi-drug-codes.csv'), 'utf8'))) {
  const label = ingredientBases(row['成分'] ?? '').join(' + ').toLowerCase();
  if (row['ATC代碼'] && label && !nhi.has(row['藥品代號'])) nhi.set(row['藥品代號'], { atc: row['ATC代碼'], label, en: row['藥品英文名稱'] ?? '' });
}
const FORM = /^(?:tablets?|tab\.?|capsules?|cap\.?|f\.?c\.?|film|sugar|enteric|e\.c\.|solution|inj\w*|cream|ointment|gel|eye|ophthalmic|nasal|oral|extended|sustained|prolonged|controlled|modified|orodispersible|granules?|powder|suspension|syrup|spray|drops?|inhal\w*|pen|\d.*)$/i;
function brandOf(english: string): string {
  const words: string[] = [];
  for (const word of english.replace(/"[^"]*"|“[^”]*”/g, ' ').split(/\s+/).filter(Boolean)) { if (FORM.test(word)) break; words.push(word); }
  return words.join(' ').toLowerCase().replace(/(^|\s)\S/g, char => char.toUpperCase());
}
function atcInfo(prefix: string) {
  const groups = new Map<string, { codes: number; seen: number; brand: string; top: number }>();
  for (const [code, drug] of nhi) {
    if (!drug.atc.startsWith(prefix)) continue;
    const group = groups.get(drug.label) ?? { codes: 0, seen: 0, brand: '', top: 0 };
    const seen = seenCodes.get(code) ?? 0;
    group.codes++; group.seen += seen;
    if (seen > group.top) { group.top = seen; group.brand = brandOf(drug.en); }
    groups.set(drug.label, group);
  }
  const ordered = [...groups].sort(([a, x], [b, y]) => y.seen - x.seen || y.codes - x.codes || a.localeCompare(b));
  return { zh: ledger.atcZh[prefix] ?? '', ex: ordered.slice(0, 6).map(([label, group]) => group.brand ? `${label}（${group.brand}）` : label), n: groups.size, seen: ordered.filter(([, group]) => group.seen).length };
}

const common = ({ rule }: LedgerRow) => ({ id: rule.id, batch: rule.batch, changed: rule.changed, flags: rule.flags ?? [], ...(rule.why ? { why: rule.why } : {}), ...(rule.ref ? { ref: rule.ref } : {}),
  ...(rule.links?.length ? { links: rule.links } : {}), ...(rule.outcome ? { outcome: rule.outcome } : {}), ...(rule.approved ? { approved: rule.approved } : {}),
  ...(rule.prev ? { prev: rule.prev } : {}), hits: hitCount(rule.id, rule.changed) });
const items = [
  ...rowsOf('indications').map(entry => ({ ...common(entry), table: 'indications', atc: entry.row['ATC'], cls: entry.row['藥理類別'], icd: chips(entry.row['可解釋的ICD-10']), basis: entry.row['依據'], note: entry.row['備註'] })),
  ...rowsOf('co-drugs').map(entry => ({ ...common(entry), table: 'co', atc: entry.row['ATC'], partners: entry.row['可由同處方的ATC解釋'], basis: entry.row['依據'], note: entry.row['備註'] })),
  ...rowsOf('cautions').map(entry => {
    const parts = entry.row['條件'].split(';').map(part => part.trim());
    const conds = entry.row['條件類型'].split('+').map((kind, i) => kind.trim() === '診斷' ? { kind: '診斷', dx: chips(parts[i]) } : kind.trim() === '同處方' ? { kind: '同處方', atc: parts[i] } : { kind: kind.trim(), text: parts[i] });
    return { ...common(entry), table: 'cautions', atc: entry.row['ATC'], keyword: entry.row['成分關鍵字'], conds, level: entry.row['等級'], msg: entry.row['提示'], basis: entry.row['依據'] };
  }),
  ...rowsOf('specialty').map(entry => ({ ...common(entry), table: 'specialty', dept: entry.row['科別代碼'], name: entry.row['科別'], atc: entry.row['該科常開的ATC'], basis: '起草者判斷' })),
  ...rowsOf('drug-classes').map(entry => ({ ...common(entry), table: 'classes', atc: entry.row['ATC'], kind: entry.row['類型'], desc: entry.row['說明'], basis: entry.row['類型'] === '低風險' ? '起草者判斷' : 'ISMP 高警訊藥品概念' })),
  ...rowsOf('settings').map(entry => ({ ...common(entry), table: 'settings', name: entry.row['設定'], value: entry.row['值'], options: entry.row['可選的值'], desc: entry.row['說明'], basis: '設計選擇' })),
  ...questions.map(({ id, title, desc, batch: from, changed, why, links, outcome, approved, flags }) => ({ id, table: 'questions', title, desc, batch: from, changed, basis: '待決定', flags: flags ?? [], hits: null, ...(why ? { why } : {}), ...(links?.length ? { links } : {}), ...(outcome ? { outcome } : {}), ...(approved ? { approved } : {}) })),
];
const prefixes = new Set<string>();
for (const item of items) {
  const conds = 'conds' in item ? item.conds : [];
  for (const spec of [(item as { atc?: string }).atc ?? '', (item as { partners?: string }).partners ?? '', ...conds.map(cond => ('atc' in cond ? cond.atc : '') ?? '')]) {
    for (const token of tokens(spec)) prefixes.add(token.split('@')[0]);
  }
}
// Which ingredients come first, and the brand in brackets, come from the samples: without samples the last catalog's stand.
const atc = Object.fromEntries([...prefixes].sort().map(prefix => {
  const before = earlier?.atc?.[prefix];
  return [prefix, before?.n ? { ...before, zh: ledger.atcZh[prefix] ?? before.zh } : atcInfo(prefix)];
}));
const missing = Object.entries(atc).filter(([, info]) => !info.zh).map(([prefix]) => prefix);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const version = rulesVersion({ sourceSha256: Object.fromEntries(RULE_FILES.map(file => [`${file}.csv`, sha256(csvBytes[file])])) } as Parameters<typeof rulesVersion>[0]);
const catalog = { format: 'gtsloth-rx-review', generatedAt: now, rulesVersion: version, batches, samples: sampleFiles.length ? { rx: sampleCount, drugs: drugCount, files: sampleFiles.length } : earlier?.samples ?? null,
  items, retired: ledger.retired, proposals: ledger.proposals ?? [], atc };
const text = JSON.stringify(catalog) + '\n';
writeFileSync(LEDGER, JSON.stringify(ledger, null, 1) + '\n');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, text);

console.log(`審核頁資料：${path.relative(root, out)}（${Math.round(Buffer.byteLength(text) / 1024)} KB），${items.length} 條，規則版本 ${version}`);
console.log(`新增 ${result.added.length} 條${result.added.length ? `：${result.added.join(' ')}` : ''}`);
console.log(`內容改變 ${result.changed.length} 條${result.changed.length ? `：${result.changed.join(' ')}` : ''}`);
console.log(`移除 ${result.retired.length} 條${result.retired.length ? `：${result.retired.join(' ')}` : ''}`);
console.log(sampleFiles.length ? `樣本：${sampleCount} 張、${drugCount} 個藥（${sampleFiles.length} 個檔案）` : earlier ? '沒有指定樣本：沒改過的規則沿用上次的命中次數，新增或改過的規則沒有次數。' : '沒有指定樣本：這次不含命中次數。');
if (missing.length) console.log(`缺中文類別名（請在 --notes 的 atcZh 補上）：${missing.join(' ')}`);
console.log('審核頁（review/）讀這個檔：和規則表一起 commit、發布後，審核者就看得到。');
