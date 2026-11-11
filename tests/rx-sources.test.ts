import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ruleTable } from '../src/rx-check';
import { citation, dueSources, readSources, type Source } from '../scripts/rx-source-list';

// docs/reference/rx-sources.csv: every 注意事項 rests on a listed source, in the version the list has.
const source = (changes: Partial<Source> = {}): Source => ({ id: 'S01', name: 'Beers', publisher: 'AGS', version: '2023', versionDate: '2023-05', frequency: '', cycle: 3, checked: '2026-11-10',
  state: '使用中', use: '注意事項', cites: ['Beers 2023'], url: '', note: '', ...changes });
const label = source({ id: 'S05', cites: ['仿單'], cycle: 12, checked: '' });
assert.deepEqual(citation('仿單警語；Beers 2023 表 2', [source(), label]), { sources: ['S01', 'S05'], outdated: [] });
assert.deepEqual(citation('Beers 2019 建議避免', [source(), label]), { sources: [], outdated: ['S01'] }, 'an older version of a listed source is behind');
assert.deepEqual(citation('Beers 2023 表 5', [source({ version: '2026', cites: ['Beers 2026'] })]), { sources: [], outdated: ['S01'] }, 'so is every rule once the list moves to a new version');
assert.deepEqual(citation('某學會共識', [source(), label]), { sources: [], outdated: [] });
assert.deepEqual(citation('STOPP v2', [source({ id: 'S03', cites: ['STOPP v3'] })]), { sources: [], outdated: ['S03'] });

// Due: never checked, or a whole cycle ago; a source with no cycle or not adopted is never due.
const due = (list: Source[], day: string) => dueSources(list, day).map(item => item.id);
assert.deepEqual(due([source(), label], '2026-11-10'), ['S05']);
assert.deepEqual(due([source()], '2027-02-09'), []);
assert.deepEqual(due([source()], '2027-02-10'), ['S01']);
assert.deepEqual(due([source({ cycle: 0, checked: '' }), source({ id: 'S02', state: '不採用', checked: '' })], '2030-01-01'), []);

const bad = readSources([{ 編號: 'X1', 名稱: '', 發布單位: 'A', 目前版本: '', 版本日期: '', 更新頻率: '', 確認週期月: '每季', 上次確認: '115/11/10', 狀態: '採用', 用途: '', 引用寫法: '', 網址: 'http://example.test', 備註: '' }]);
for (const text of ['編號要寫成', '不可空白', '狀態只能是', '確認週期月要是數字', '上次確認要寫成', '網址要以 https']) assert.ok(bad.problems.some(problem => problem.includes(text)), text);

const table = (file: string) => ruleTable(readFileSync(`docs/reference/${file}`, 'utf8'));
const { sources, problems } = readSources(table('rx-sources.csv'));
assert.deepEqual(problems, []);
assert.ok(sources.length >= 10);
for (const row of table('rx-rules/cautions.csv')) {
  const cited = citation(row['依據'], sources);
  assert.ok(cited.sources.length, `${row['編號']} 的依據「${row['依據']}」沒有對到 docs/reference/rx-sources.csv 的任何來源：請用清單上的引用寫法，或把來源加進清單`);
  assert.deepEqual(cited.outdated, [], `${row['編號']} 的依據「${row['依據']}」寫的版本和 rx-sources.csv 不同：來源換版後要重新核對這條，再改依據欄`);
}
// A source the rules cite is one the list says is in use.
const cited = new Set(table('rx-rules/cautions.csv').flatMap(row => citation(row['依據'], sources).sources));
for (const item of sources) if (cited.has(item.id)) assert.equal(item.state, '使用中', `${item.id} ${item.name} 已有注意事項引用，狀態要是使用中`);
console.log(`rule sources: ${sources.length} listed, every 注意事項 cites one in its listed version`);
