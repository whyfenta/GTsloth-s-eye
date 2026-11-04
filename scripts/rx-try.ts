import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules, ruleTable, RULE_FILES, type RuleTables } from '../src/rx-check';
import { readRxData, rulesVersion, type RxData } from '../src/rx-data';
import { describeSample, ruleCoverage } from '../src/rx-review';
import { isFailure, sampleCheck, type SampleCheck } from '../src/rx-sample';

// Usage: npm run rx-try -- 樣本1.txt [樣本2.txt …] [--lines] [--detail] [--coverage]
//        npm run rx-try -- --version   (the published rules' version, as the sample sheet's 規則版本 column records it)
// Runs de-identified sample lines (the collector's .txt, or the weekly export in 驗證用) through the published rules
// (public/assets/rx/rules.json) and through the tables as they are now in docs/reference/rx-rules/, so an edit can be tried
// before `npm run rx-assets`. Prints counts, then each prescription whose check changed by file and line number; --lines adds
// the lines themselves. With the tables as they are now, --detail writes out every prescription (diagnoses with names, drugs
// with ATC, ingredients and daily count, and what the rules say), for looking for problems no rule catches; --coverage counts,
// for each caution, the prescriptions it fired on, those with its drug and with each condition, and those it would catch if
// combination products counted their ingredients. Samples stay on this computer: never run it in CI or paste its --lines or
// --detail output outside the team.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const showLines = args.includes('--lines'), showDetail = args.includes('--detail'), showCoverage = args.includes('--coverage');
const files = args.filter(arg => !arg.startsWith('--'));
const json = (name: string) => JSON.parse(readFileSync(path.join(root, 'public', 'assets', 'rx', `${name}.json`), 'utf8'));
if (args.includes('--version')) { console.log(rulesVersion(json('rules'))); process.exit(0); }
if (!files.length) { console.error('用法：npm run rx-try -- 樣本1.txt [樣本2.txt …] [--lines] [--detail] [--coverage]，或 npm run rx-try -- --version'); process.exit(2); }

const [published, drugs, icd] = ['rules', 'drugs', 'icd10cm'].map(json);
const before = readRxData(published, drugs, icd);
const tables = Object.fromEntries(RULE_FILES.map(file => [file, ruleTable(readFileSync(path.join(root, 'docs', 'reference', 'rx-rules', `${file}.csv`), 'utf8'))])) as RuleTables;
const after: RxData = { ...before, rules: compileRules(tables) };

type Line = { file: string; number: number; line: string };
const lines: Line[] = [];
let failed = 0;
for (const file of files) {
  readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach((line, i) => {
    if (!line.trim()) return;
    if (isFailure(line)) { failed++; return; }
    lines.push({ file: path.basename(file), number: i + 1, line });
  });
}
const levels = ['紅', '黃', '灰', ''] as const;
const tally = (checks: SampleCheck[]) => Object.fromEntries(levels.map(level => [level, checks.filter(check => check.top === level).length]));
const checks = lines.map(({ line }) => [sampleCheck(line, before), sampleCheck(line, after)] as const);
const counts = [tally(checks.map(([a]) => a)), tally(checks.map(([, b]) => b))];
const percent = (n: number) => lines.length ? `${(100 * n / lines.length).toFixed(1)}%` : '—';
/** Pads to a column, counting a Chinese character as two. */
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(1, width - [...text].reduce((n, char) => n + (char > '\x7F' ? 2 : 1), 0)));

console.log(`樣本 ${lines.length} 張（${files.length} 個檔案），略過失敗行 ${failed} 行`);
console.log(`${pad('', 12)}${pad('發布的規則', 16)}目前的規則表`);
for (const level of levels) console.log(`${pad(level || '無提示', 12)}${pad(`${counts[0][level]}（${percent(counts[0][level])}）`, 16)}${counts[1][level]}（${percent(counts[1][level])}）`);
console.log(`${pad('黃紅比例', 12)}${pad(percent(counts[0].紅 + counts[0].黃), 16)}${percent(counts[1].紅 + counts[1].黃)}`);

const view = (check: SampleCheck) => JSON.stringify([check.top, check.alerts, check.cautions, check.unexplained]);
const changed = lines.map((line, i) => ({ ...line, a: checks[i][0], b: checks[i][1] })).filter(({ a, b }) => view(a) !== view(b));
console.log(`\n判定改變 ${changed.length} 張${changed.length ? '：' : ''}`);
for (const { file, number, line, a, b } of changed) {
  console.log(`${file}:${number}  ${a.top || '無提示'} → ${b.top || '無提示'}`);
  for (const item of a.alerts.filter(item => !b.alerts.includes(item))) console.log(`  - ${item}`);
  for (const item of b.alerts.filter(item => !a.alerts.includes(item))) console.log(`  + ${item}`);
  for (const item of a.unexplained.filter(item => !b.unexplained.includes(item))) console.log(`  - 未解釋 ${item}`);
  for (const item of b.unexplained.filter(item => !a.unexplained.includes(item))) console.log(`  + 未解釋 ${item}`);
  if (showLines) console.log(`  行：${line}`);
}

const unexplained = new Map<string, number>();
for (const [, b] of checks) for (const item of b.unexplained) { const atc = item.split(' ')[1]; unexplained.set(atc, (unexplained.get(atc) ?? 0) + 1); }
const top = [...unexplained].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 20);
console.log(`\n目前的規則表下，未解釋最多的 ATC：${top.map(([atc, n]) => `${atc} ×${n}`).join('、') || '無'}`);

if (showCoverage) {
  const coverage = ruleCoverage(lines.map(({ line }) => line), after);
  const where = (indices: number[]) => indices.map(i => `${lines[i].file}:${lines[i].number}`).join(' ');
  console.log(`\n規則覆蓋度（目前的規則表，樣本 ${lines.length} 張；數字都是張數，「複方」指只在複方成分裡出現）`);
  for (const row of coverage) {
    const conditions = row.conditions.map(c => `${c.label} ${c.holds}${c.combo ? `（另複方 ${c.combo}）` : ''}`).join('；');
    console.log(`${row.id} ${row.level}｜命中 ${row.fired}｜藥品端 ${row.drug}${row.drugCombo ? `（另複方 ${row.drugCombo}）` : ''}｜${conditions}`
      + (row.comboMisses.length ? `｜複方可能漏掉 ${row.comboMisses.length}：${where(row.comboMisses)}` : ''));
    if (showLines) for (const i of row.comboMisses) console.log(`  行：${lines[i].line}`);
  }
  const silent = coverage.filter(row => !row.fired);
  const group = (title: string, rows: typeof coverage) => { if (rows.length) console.log(`  ${title}：${rows.map(row => row.id).join('、')}`); };
  console.log(`\n沒有命中的 ${silent.length} 條：`);
  group('樣本裡沒有這類藥', silent.filter(row => !row.drug && !row.drugCombo));
  group('這類藥只在複方裡', silent.filter(row => !row.drug && row.drugCombo));
  group('有這類藥，但有條件從沒成立', silent.filter(row => row.drug && row.conditions.some(c => !c.holds && !c.combo)));
  group('藥和條件都出現過，但不在同一張', silent.filter(row => row.drug && row.conditions.every(c => c.holds || c.combo) && !row.comboMisses.length));
  const misses = coverage.filter(row => row.comboMisses.length);
  console.log(`複方可能漏掉的：${misses.map(row => `${row.id}（${row.comboMisses.length} 張）`).join('、') || '無'}`);
}
if (showDetail) {
  console.log('\n逐張明細（目前的規則表）：');
  for (const { file, number, line } of lines) {
    console.log(`\n${file}:${number}`);
    for (const text of describeSample(line, after)) console.log(text);
  }
}
