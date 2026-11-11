import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleTable } from '../src/rx-check';
import { proposalProblems, proposalsCsv, type Proposal } from '../src/rx-proposals';

// Usage: npm run rx-proposals -- 提案.json [--out 提案.csv]
// The weekly review of samples (docs/rx-samples-weekly-review.md) writes its proposals as JSON: [{ id, kind, title, file, row,
// evidence, basis, trial, note }]. This checks each one (ids, kinds, a rule row's columns, no sample content) and writes the CSV
// to upload as the week's proposal sheet, which the pharmacists' review page reads. Nothing is uploaded from here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
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
