import { readFileSync, writeFileSync } from 'node:fs';
import { csvRows } from '../src/csv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleTable } from '../src/rx-check';
import { proposalProblems, proposalsCsv, proposalsOfRows, PROPOSALS_FORMAT, type Proposal } from '../src/rx-proposals';

// Usage: npm run rx-proposals -- 提案.json [--out 提案.csv]
//        npm run rx-proposals -- --publish 提案表1.csv [提案表2.csv …]
// The weekly review of samples (docs/rx-samples-weekly-review.md) writes its proposals as JSON: [{ id, kind, title, file, row,
// evidence, basis, trial, note }]. This checks each one (ids, kinds, a rule row's columns, no sample content) and writes the CSV
// to upload as the week's proposal sheet, which the pharmacists' review page reads. Nothing is uploaded from here.
// --publish takes the proposal sheets as exported from Drive (CSV) and writes public/assets/rx/proposals.json: the copy of the
// open proposals that goes out with the site, so the review page shows them even when the team's script cannot read Drive.
// It replaces the file: give every sheet that still has open proposals.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args[0] === '--publish') {
  const sheets = args.slice(1);
  if (!sheets.length) { console.error('用法：npm run rx-proposals -- --publish 提案表1.csv [提案表2.csv …]'); process.exit(1); }
  const all: Proposal[] = [];
  for (const sheet of sheets) {
    const read = proposalsOfRows(csvRows(readFileSync(sheet, 'utf8').replace(/^\uFEFF/, '')));
    if (read.skipped) { console.error(`${sheet}：有 ${read.skipped} 列不能發布（先用 JSON 模式檢查原因）。`); process.exit(1); }
    all.push(...read.proposals);
  }
  const ids = all.map(proposal => proposal.id);
  if (new Set(ids).size !== ids.length) { console.error('提案編號重複。'); process.exit(1); }
  // The newest sheet first, in its own order.
  const week = (proposal: Proposal) => proposal.id.slice(1, 9);
  all.sort((a, b) => week(b).localeCompare(week(a)) || a.id.localeCompare(b.id));
  const target = path.join(root, 'public', 'assets', 'rx', 'proposals.json');
  writeFileSync(target, JSON.stringify({ format: PROPOSALS_FORMAT, proposals: all }) + '\n');
  console.log(`${all.length} 項提案（${sheets.length} 份提案表）寫入 ${path.relative(root, target)}。`);
  process.exit(0);
}
const at = args.indexOf('--out');
const out = at < 0 ? undefined : args.splice(at, 2)[1];
const [file] = args;
if (!file) { console.error('用法：npm run rx-proposals -- 提案.json [--out 提案.csv]'); process.exit(1); }

const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
if (!Array.isArray(parsed)) { console.error('提案檔要是一個陣列：[{ id, kind, title, … }]'); process.exit(1); }
const proposals = parsed.map(item => ({ file: '', row: '', evidence: '', basis: '', trial: '', note: '', ...(item as Partial<Proposal>) }) as Proposal);

/** One CSV row's cells, quotes handled. */
function cells(row: string): string[] {
  const values: string[] = [];
  let value = '', quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (quoted) { if (char === '"' && row[i + 1] === '"') { value += '"'; i++; } else if (char === '"') quoted = false; else value += char; }
    else if (char === '"') quoted = true;
    else if (char === ',') { values.push(value); value = ''; }
    else value += char;
  }
  return [...values, value];
}
let failed = 0;
const seen = new Set<string>();
for (const proposal of proposals) {
  const problems = proposalProblems(proposal);
  if (seen.has(proposal.id)) problems.push('編號重複');
  seen.add(proposal.id);
  if (proposal.file && proposal.row) {
    const header = Object.keys(ruleTable(readFileSync(path.join(root, 'docs', 'reference', 'rx-rules', `${proposal.file}.csv`), 'utf8'))[0] ?? {});
    const count = cells(proposal.row).length;
    if (header.length && count !== header.length) problems.push(`整列內容有 ${count} 欄，${proposal.file}.csv 是 ${header.length} 欄（${header.join('、')}）`);
  }
  if (problems.length) { failed++; console.error(`${proposal.id || '（沒有編號）'}：${problems.join('；')}`); }
}
if (failed) { console.error(`${failed} 項提案不能發布，請修正後再執行。`); process.exit(1); }
const csv = proposalsCsv(proposals);
if (out) writeFileSync(out, csv);
console.log(`${proposals.length} 項提案通過檢查${out ? `，已寫入 ${out}` : ''}。`);
if (!out) console.log(csv);
