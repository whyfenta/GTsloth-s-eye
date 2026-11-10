import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleTable } from '../src/rx-check';
import { citation, dueSources, readSources } from './rx-source-list';

// Usage: npm run rx-sources [-- --date YYYY-MM-DD]
// Prints docs/reference/rx-sources.csv as the monthly source check reads it: which sources are due for a look (never checked, or
// checked longer ago than their cycle), how many 注意事項 rest on each, and the rules whose 依據 names no listed source or an
// older version. It reads the repo only; looking for newer versions is the reader's job (docs/rx-sources-review.md).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = args.indexOf('--date');
const today = at < 0 ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()) : args[at + 1];
const table = (file: string) => ruleTable(readFileSync(path.join(root, 'docs', 'reference', file), 'utf8'));
const { sources, problems } = readSources(table('rx-sources.csv'));
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

const cautions = table('rx-rules/cautions.csv');
const using = new Map<string, string[]>(), unlisted: string[] = [], behind: string[] = [];
for (const row of cautions) {
  const cited = citation(row['依據'], sources);
  for (const id of cited.sources) using.set(id, [...using.get(id) ?? [], row['編號']]);
  if (!cited.sources.length) unlisted.push(`${row['編號']}（${row['依據']}）`);
  if (cited.outdated.length) behind.push(`${row['編號']}（${row['依據']}；清單上是 ${cited.outdated.join('、')}）`);
}
const due = new Set(dueSources(sources, today).map(source => source.id));
console.log(`處方警示的依據來源（${today}）：${sources.length} 個，其中 ${due.size} 個到了確認的時間。\n`);
for (const source of sources) {
  const rules = using.get(source.id) ?? [];
  console.log(`${due.has(source.id) ? '● 該確認' : '　'} ${source.id} ${source.name}｜${source.state}｜版本 ${source.version || '—'}｜上次確認 ${source.checked || '從未'}`
    + `${source.cycle ? `（每 ${source.cycle} 個月）` : ''}｜注意事項引用 ${rules.length} 條${rules.length ? `：${rules.join(' ')}` : ''}`);
}
console.log(`\n依據沒有對到清單上任何來源的注意事項：${unlisted.length ? unlisted.join('、') : '無'}`);
console.log(`依據寫的版本和清單不同的注意事項：${behind.length ? behind.join('、') : '無'}`);
