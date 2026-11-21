import assert from 'node:assert/strict';
import { asWrittenIn, legacyId, ruleId, RULE_ID } from '../src/rx-ids';

// docs/reference/rx-rules.md「編號」: an old number turns into the current one by formula, and back, wherever it was written.
const PAIRS = [['C17', 'C-017'], ['C05', 'C-005'], ['C184', 'C-184'], ['I24', 'I-024'], ['I108', 'I-108'], ['D01', 'D-001'], ['K05', 'K-005'],
  ['S02', 'S-02'], ['SAB', 'S-AB'], ['X1', 'X-01'], ['Q9', 'Q-09'], ['Q10', 'Q-10']];
for (const [old, now] of PAIRS) {
  assert.equal(ruleId(old), now, old);
  assert.equal(ruleId(now), now, `${now} stays as it is`);
  assert.equal(legacyId(now), old, now);
  assert.match(now, RULE_ID, now);
  assert.doesNotMatch(old, RULE_ID, old);
}
assert.equal(ruleId('C1000'), 'C-1000');
assert.match('C-1000', RULE_ID);
assert.equal(legacyId('C-1000'), 'C1000');
// Not rule numbers: proposals, codes and anything else stay as they are.
for (const other of ['P20261109-01', 'SELFTEST', 'c17', 'C17黃', 'C10AA', 'I10-I16', 'AGE10-19', '新1', 'C-', '']) {
  assert.equal(ruleId(other), other, other);
  assert.equal(legacyId(other), other, other);
}
// The current form never reads as an ATC code, an ICD-10-CM code or range end, a 2-character department or a 健保碼.
const ATC = /^[A-Z](?:\d\d(?:[A-Z](?:[A-Z](?:\d\d)?)?)?)?$/, ICD = /^[A-Z]\d[0-9A-Z](?:\.?[0-9A-Z]{1,4})?$/;
for (const [, now] of PAIRS) {
  for (const [name, pattern] of [['ATC', ATC], ['ICD-10-CM', ICD], ['科別', /^[0-9A-Z]{2}$/], ['健保碼', /^[0-9A-Z]{10,12}$/]] as const) assert.doesNotMatch(now, pattern, `${now} looks like ${name}`);
}
// A name from the team's sheet, a sample or a note, in either form, becomes the form a list uses (the ledger, the catalog).
const now = asWrittenIn(['C-017', 'I-024', 'P20261109-01']), before = asWrittenIn(['C17', 'I24']);
assert.deepEqual(['C17', 'C-017', 'I24', 'P20261109-01', 'C99'].map(now), ['C-017', 'C-017', 'I-024', 'P20261109-01', 'C99']);
assert.deepEqual(['C17', 'C-017', 'I-024'].map(before), ['C17', 'C17', 'I24']);
console.log('rule numbers passed');
