import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RULE_FILES, ruleTable, type RuleTables } from '../src/rx-check';
import { reconcile, unsynced, type Ledger } from '../scripts/rx-review-ledger';
import { rulesVersion } from '../src/rx-data';

const row = (atc: string, icd: string, basis = '仿單') => ({ ATC: atc, 藥理類別: atc, '可解釋的ICD-10': icd, 依據: basis, 備註: '' });
const caution = (id: string, level = '黃') => ({ 編號: id, ATC: 'N02A', 成分關鍵字: '', 條件類型: '診斷', 條件: 'J45', 等級: level, 提示: '提示', 依據: '仿單' });
const tablesOf = (indications: Record<string, string>[], cautions: Record<string, string>[] = []): RuleTables =>
  ({ indications, 'co-drugs': [], cautions, specialty: [], 'drug-classes': [], settings: [] });
const blank = (): Ledger => ({ batches: [], rules: [], questions: [], retired: [], atcZh: {} });
const start = (tables: RuleTables) => reconcile(tables, blank(), { batch: 'b1', now: 't1' }).ledger;
const at = (time: string, batch = 'b2') => ({ batch, now: time });

test('new rows get the next id, also after a retired one', () => {
  const ledger = start(tablesOf([row('A10', 'E11'), row('C10', 'E78')], [caution('C01')]));
  assert.deepEqual(ledger.rules.map(rule => rule.id), ['I01', 'I02', 'C01']);
  const without = reconcile(tablesOf([row('A10', 'E11')], [caution('C01')]), ledger, at('t2')).ledger;
  assert.deepEqual(without.retired.map(rule => rule.id), ['I02']);
  const next = reconcile(tablesOf([row('A10', 'E11'), row('R01A', 'J30')], [caution('C01')]), without, at('t3'));
  assert.deepEqual(next.added, ['I03']);
  assert.equal(next.rows[1].rule.batch, 'b2');
  assert.equal(next.rows[1].rule.changed, 't3');
});
test('moving a row keeps its id and its review', () => {
  const ledger = start(tablesOf([row('A10', 'E11'), row('C10', 'E78')]));
  const moved = reconcile(tablesOf([row('C10', 'E78'), row('A10', 'E11')]), ledger, at('t2'));
  assert.deepEqual(moved.rows.map(entry => [entry.rule.id, entry.rule.changed]), [['I02', 't1'], ['I01', 't1']]);
  assert.deepEqual(moved.added, []);
  assert.deepEqual(moved.changed, []);
});
test('two rows for one ATC stay apart; editing one brings only that one back', () => {
  const ledger = start(tablesOf([row('C10', 'E78'), row('C10', 'N18', '指引')]));
  const edited = reconcile(tablesOf([row('C10', 'E78'), row('C10', 'N18 E11', '指引')]), ledger, at('t2'));
  assert.deepEqual(edited.changed, ['I02']);
  assert.equal(edited.rows[0].rule.changed, 't1');
  assert.equal(edited.rows[1].rule.changed, 't2');
  assert.match(edited.rows[1].rule.prev ?? '', /N18（指引）/);
});
test('a changed rule loses its outcome and comes back, unless the change is the pharmacist\'s own', () => {
  const ledger = start(tablesOf([], [caution('C15', '灰')]));
  ledger.rules[0].outcome = '同意';
  const again = reconcile(tablesOf([], [caution('C15', '黃')]), ledger, at('t2'));
  assert.equal(again.rows[0].rule.outcome, undefined);
  assert.equal(again.rows[0].rule.changed, 't2');
  const own = reconcile(tablesOf([], [caution('C15', '黃')]), ledger, { ...at('t2'), applied: { C15: '依意見改成黃色' } });
  assert.equal(own.rows[0].rule.outcome, '依意見改成黃色');
  assert.equal(own.rows[0].rule.changed, 't1');
});
test('a review the team closed opens again when the rule changes', () => {
  const ledger = start(tablesOf([], [caution('C15', '灰')]));
  ledger.rules[0].approved = { at: '2026-11-12', n: 2 };
  assert.deepEqual(reconcile(tablesOf([], [caution('C15', '灰')]), ledger, at('t2')).rows[0].rule.approved, { at: '2026-11-12', n: 2 });
  const again = reconcile(tablesOf([], [caution('C15', '黃')]), ledger, at('t2'));
  assert.equal(again.rows[0].rule.approved, undefined);
  assert.equal(again.rows[0].rule.changed, 't2');
});
test('a wording change in 備註 does not come back for review', () => {
  const ledger = start(tablesOf([row('C10', 'E78')]));
  const reworded = reconcile(tablesOf([{ ...row('C10', 'E78'), 備註: '改了說明' }]), ledger, at('t2'));
  assert.deepEqual(reworded.changed, []);
});

// The ledger matches docs/reference/rx-rules/: a rule added or edited there has to reach the pharmacist's review page.
const tables = Object.fromEntries(RULE_FILES.map(file => [file, ruleTable(readFileSync(`docs/reference/rx-rules/${file}.csv`, 'utf8'))])) as RuleTables;
const ledgerText = readFileSync('docs/reference/rx-rules-review.json', 'utf8');
const ledger: Ledger = JSON.parse(ledgerText);
test('the review ledger knows every rule in the tables', () => {
  assert.deepEqual(unsynced(tables, ledger), [], '規則表改過了：請執行 npm run rx-review-page（docs/reference/rx-rules.md「審核頁」），把審核紀錄與審核頁清單一起 commit');
});
// The review page reads public/assets/rx/review.json: it has to say what the ledger and the published rules say.
test('the review page catalog is the ledger as it is now', () => {
  const hint = '請執行 npm run rx-review-page，把 public/assets/rx/review.json 一起 commit';
  const catalogText = readFileSync('public/assets/rx/review.json', 'utf8');
  const catalog: { rulesVersion: string; items: { id: string; table: string; changed: string; outcome?: string; approved?: unknown }[]; retired: { id: string }[]; proposals: unknown[] } = JSON.parse(catalogText);
  const published: Parameters<typeof rulesVersion>[0] = JSON.parse(readFileSync('public/assets/rx/rules.json', 'utf8'));
  assert.equal(catalog.rulesVersion, rulesVersion(published), `審核頁清單的規則版本落後：${hint}`);
  const state = (items: { id: string; changed: string; outcome?: string; approved?: unknown }[]) => items.map(item => [item.id, item.changed, item.outcome ?? '', JSON.stringify(item.approved ?? null)]);
  assert.deepEqual(state(catalog.items.filter(item => item.table !== 'questions')), state(ledger.rules), `審核頁清單和審核紀錄不同：${hint}`);
  assert.deepEqual(state(catalog.items.filter(item => item.table === 'questions')), state(ledger.questions), `審核頁清單和審核紀錄不同：${hint}`);
  assert.deepEqual(catalog.retired.map(item => item.id), ledger.retired.map(item => item.id), hint);
  assert.deepEqual(catalog.proposals, ledger.proposals ?? [], hint);
  // Public like the ledger: counts and drug names only.
  assert.doesNotMatch(catalogText, /\b[0-9A-Za-z]{10};\d?;/);
  assert.doesNotMatch(catalogText, /\b\d{10}\b/, '不要寫院所代碼');
});
test('a closed review says when and by how many, and a closed proposal what became of it', () => {
  for (const rule of [...ledger.rules, ...ledger.questions]) {
    if (!rule.approved) continue;
    assert.match(rule.approved.at, /^\d{4}-\d\d-\d\d$/, `${rule.id} 的結案日期`);
    assert.ok(Number.isInteger(rule.approved.n) && rule.approved.n >= 1, `${rule.id} 的同意人數`);
    assert.ok(rule.approved.at >= rule.changed.slice(0, 10), `${rule.id} 在內容改變之前就結案`);
  }
  for (const proposal of ledger.proposals ?? []) {
    assert.match(proposal.id, /^P\d{8}-\d{2}$/);
    assert.ok(['已採用', '不採用', '需更多樣本'].includes(proposal.status), `${proposal.id} 的狀態`);
    assert.match(proposal.decided, /^\d{4}-\d\d-\d\d$/);
  }
});
test('the review ledger is consistent and holds no sample content', () => {
  const batches = new Set(ledger.batches.map(batch => batch.id));
  for (const item of [...ledger.rules, ...ledger.questions, ...ledger.retired]) assert.ok(batches.has(item.batch), `${item.id} 的批次 ${item.batch} 不存在`);
  const ids = [...ledger.rules, ...ledger.questions, ...ledger.retired].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, '編號重複');
  // A sample line starts with a 10-character institution code and separates its fields with ;
  assert.doesNotMatch(ledgerText, /\b[0-9A-Za-z]{10};\d?;/);
  // The repository is public: no institution, no age band of a particular prescription. Counts and drug pairs only.
  assert.doesNotMatch(ledgerText, /\b\d{10}\b/, '不要寫院所代碼');
  assert.doesNotMatch(ledgerText, /\d+\s*多歲|AGE\d/, '不要寫某張處方的年齡層');
});
console.log('review ledger ids, change detection and sync with the rule tables passed');
