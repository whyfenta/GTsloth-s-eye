// Offline tests of what the AI pre-review may take up (tools/prereview/queue.ts) and the rule as the model reads it.
import assert from 'node:assert/strict';
import { pickQueue, ruleData } from '../tools/prereview/queue';
import type { Item, Vote } from '../src/review-model';
import type { Proposal } from '../src/rx-proposals';

const rule = (id: string, batch: string, extra: Partial<Item> = {}): Item => ({ id, table: 'indications', batch, changed: `${batch}T00:00:00.000Z`, basis: '指引', flags: [], hits: 3, atc: 'C10', cls: '調血脂藥', icd: [{ t: 'E11', zh: '第二型糖尿病' }], ...extra });
const vote = (d: Vote['d'], t: string, c = ''): Vote => ({ d, c, t });
const proposal = (id: string): Proposal => ({ id, kind: '新增規則', title: id, file: 'indications', row: 'r', evidence: 'e', basis: 'b', trial: '', note: '' });
const items = [
  rule('I100', '2026-10-31'), rule('I21', '2026-10-31'), rule('I07', '2026-10-31'),
  rule('I08', '2026-10-31', { approved: { at: '2026-11-01', n: 2 } }),
  rule('C24', '2026-11-03', { table: 'cautions', changed: '2026-11-05T07:32:07.508Z' }),
  rule('Q1', '2026-10-31', { table: 'questions' }), rule('S1', '2026-10-31', { table: 'settings' }),
];
const catalog = { items, proposals: [{ id: 'P20261111-06', title: '', status: '採用', decided: '115/11/12' }] };
const reviewers = { me: 'Agy-H2預審', sol: 'Codex-Sol預審', a: '藥師甲', b: '藥師乙' };
const ids = (votes: Record<string, Record<string, Vote>>, options: Partial<Parameters<typeof pickQueue>[3]> = {}) =>
  pickQueue([proposal('P20261109-01'), proposal('P20261111-06')], catalog, { reviewers, votes, quorum: 2 }, { reviewer: 'me', ...options }).map(task => task.id);

// Questions, settings and closed items never; oldest batch first, a proposal before the rules of its week, numbers in order.
assert.deepEqual(ids({}), ['I07', 'I21', 'I100', 'C24', 'P20261109-01']);
// Agreed by the team (達門檻) is left out; a split is not agreement. AI pre-reviews do not count toward agreement.
const agreed = { I07: { a: vote('同意', '2026-11-01'), b: vote('同意', '2026-11-01') }, I21: { a: vote('同意', '2026-11-01'), b: vote('其他意見', '2026-11-01') }, I100: { me: vote('同意', '2026-11-01'), sol: vote('同意', '2026-11-01') } };
assert.deepEqual(ids(agreed, { reviewer: 'x' }), ['I21', 'I100', 'C24', 'P20261109-01']);
// Named with --id it is taken even when agreed; a closed one never is.
assert.deepEqual(ids(agreed, { only: 'I07' }), ['I07']);
assert.deepEqual(ids({}, { only: 'P20261111-06' }), []);
assert.deepEqual(ids({}, { only: 'Q1' }), []);
// This reviewer's own answer: skipped, unless --again; --redo takes back the ones without a lean.
const mine = { I07: { me: vote('同意', '2026-11-01') }, I21: { me: vote('', '2026-11-01', '只有意見') } };
assert.deepEqual(ids(mine), ['I100', 'C24', 'P20261109-01']);
assert.deepEqual(ids(mine, { only: 'I07', again: true }), ['I07']);
assert.deepEqual(ids(mine, { redo: true }), ['I21', 'I100', 'C24', 'P20261109-01']);
// --unreviewed: any AI pre-review made since the rule last changed covers it; one from before the change does not.
const others = { I07: { sol: vote('不同意', '2026-11-01') }, C24: { sol: vote('同意', '2026-11-04T00:00:00Z') }, 'P20261109-01': { sol: vote('同意', '2026-11-10') } };
assert.deepEqual(ids(others, { unreviewed: true }), ['I21', 'I100', 'C24']);
assert.deepEqual(ids(others), ['I07', 'I21', 'I100', 'C24', 'P20261109-01']);

// The rule as data: its fields, the class names of its codes, the page's notes; nothing from the votes.
const text = ruleData(rule('I07', '2026-10-31', { flags: ['依審核意見改寫備註'], note: '一級預防', conds: [{ kind: '同處方', atc: 'H02AB' }] }), { C10: { zh: '調血脂藥', ex: [], n: 1 }, H02: { zh: '全身性皮質類固醇', ex: [], n: 1 } });
for (const part of ['編號：I07', '類別：適應症（indications）', '藥品 ATC：C10（調血脂藥）', 'ICD-10：E11 第二型糖尿病', '條件：同處方 H02AB（全身性皮質類固醇）', '備註：一級預防', '命中：樣本中解釋 3 個藥', '頁面註記：依審核意見改寫備註'])
  assert.ok(text.includes(part), part);
assert.ok(!/藥師甲|同意/.test(text));
console.log('prereview queue checks passed');
