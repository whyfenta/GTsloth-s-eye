import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RULE_FILES, ruleTable, type RuleTables } from '../src/rx-check';
import { reconcile, unsynced, type Ledger } from '../scripts/rx-review-ledger';

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
  assert.deepEqual(unsynced(tables, ledger), [], '規則表改過了：請執行 npm run rx-review-page，並把產生的資料寫進審核頁（docs/reference/rx-rules.md「審核頁」）');
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
