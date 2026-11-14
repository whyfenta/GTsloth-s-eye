import assert from 'node:assert/strict';
import { BatchLog, maskedName, personOf } from '../src/batch-model';
import { deidentify } from '../src/prescription-sample';
import { compileRules, ruleTable, type DrugInfo, type IcdEntry, type RuleTables } from '../src/rx-check';
import type { RxData } from '../src/rx-data';
import { MAX_BATCH, MAX_FAILED, SAMPLE_FORMAT } from '../src/rx-sample';

// 批次蒐集: synthetic prescriptions, drug codes and rule tables only, as in rx-sample.test.ts.
const csv = (header: string, ...rows: string[]) => ruleTable([header, ...rows].join('\n'));
const tables: RuleTables = {
  indications: csv('ATC,藥理類別,可解釋的ICD-10,依據,備註', 'A10,測試類別,E08-E13,仿單,'),
  'co-drugs': csv('ATC,可由同處方的ATC解釋,依據,備註', 'A02BC,B01AC,常見,胃腸保護'),
  cautions: csv('編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,G04CB,,性別+年齡,女;<50,紅,測試提示甲,', 'T02,N05BA,,年齡,>=65,灰,測試提示乙,'),
  specialty: csv('科別代碼,科別,該科常開的ATC', 'AB,心臟血管內科,C10'),
  'drug-classes': csv('ATC,類型,說明', 'A06,低風險,', 'N05A,高警訊,'),
  settings: csv('設定,值,可選的值,說明', '同成分重複,黃,紅 黃 灰,', '科別常用,保留,保留 停用,'),
};
const drugs = new Map<string, DrugInfo>(Object.entries({
  TESTMETF01: { atc: 'A10BA02', ingredients: 'METFORMIN HCL 500 MG' }, TESTDUTA01: { atc: 'G04CB02', ingredients: 'DUTASTERIDE 0.5 MG' },
  TESTQUET01: { atc: 'N05AH04', ingredients: 'QUETIAPINE FUMARATE 25 MG' }, TESTALPR01: { atc: 'N05BA12', ingredients: 'ALPRAZOLAM 0.5 MG' },
  TESTOTHR01: { atc: 'R01AD05', ingredients: 'BUDESONIDE 64 MCG' },
}));
const icd = new Map<string, IcdEntry>([['E11', { name: '第二型糖尿病', deleted: false }], ['E119', { name: '第二型糖尿病，未伴有併發症', deleted: false }],
  ['N40', { name: '良性攝護腺增生', deleted: false }], ['V010', { name: '測試舊碼', deleted: true }]]);
const data: RxData = { rules: compileRules(tables), drugs, icd, drugDate: '', icdVersion: '', rulesVersion: 'abcdef012345' };
const qr = (dx: string, codes: string[], changes: Record<number, string> = {}) => {
  const fields = ['0000000000', '1', '', '測試甲', 'A223456789', '0900101', 'AB', '1150101', 'TESTVISIT1', '7', '', dx, '0000000000', '9,TESTNOTE01',
    ...codes.flatMap(code => [code, '1', 'BID', 'PO', '14'])];
  for (const [n, value] of Object.entries(changes)) fields[Number(n) - 1] = value;
  return fields.join(';') + ';';
};
const drugsQR = (codes: string[]) => codes.flatMap(code => [code, '1', 'QD', 'PO', '28']).join(';') + ';';

// The patient is read as the 憑單 reads it, and shown with the middle of the name hidden.
assert.deepEqual(personOf(qr('E11', ['TESTMETF01'])), { idNumber: 'A223456789', name: '測試甲', birth: '0900101' });
assert.deepEqual(personOf(qr('E11', ['TESTMETF01'], { 5: 'X12' })), { idNumber: '', name: '測試甲', birth: '0900101' });
assert.equal(personOf('not;a;qr'), undefined);
assert.equal(maskedName('王小明'), '王○明');
assert.equal(maskedName('歐陽小明'), '歐○○明');
assert.equal(maskedName('王明'), '王○');
assert.equal(maskedName(' '), '');

// Any prescription type and number of days, de-identified as the collector writes it; one patient's prescriptions are grouped.
const log = new BatchLog();
const noSex = qr('N40', ['TESTDUTA01', 'TESTMETF01'], { 5: '' }), withSex = qr('E11', ['TESTMETF01']);
const other = qr('E11', ['TESTOTHR01'], { 4: '測試乙', 5: 'A123456780' });
assert.deepEqual(log.scan('k1', noSex), { state: 'added', index: 0 });
assert.deepEqual(log.scan('k2', other), { state: 'added', index: 1 });
assert.deepEqual(log.scan('k3', withSex, 2), { state: 'added', index: 2 });
assert.equal(log.entries[2].qrs, 2);
assert.equal(log.entries[0].line, deidentify(noSex));
assert.deepEqual(log.scan('k1', noSex), { state: 'duplicate', index: 0 });
assert.equal(log.scan('k4', qr('E11', ['TESTMETF01'], { 1: '測試院所' })).state, 'failed');
assert.deepEqual(log.groups(), [[0, 2], [1]]);
// What the combined check adds goes with each line, rule numbers only; another patient's adds nothing.
assert.deepEqual(log.merged(0, data), ['T01紅']);
assert.deepEqual(log.merged(2, data), ['同成分重複黃']);
assert.deepEqual(log.merged(1, data), []);

// The requests: the collector's lines with their check and merged rules, failures with them; nothing in them names the patient.
const catalog = new Map<string, unknown[]>([['TESTMETF01', [{}]]]);
let requests = log.requests(data, catalog, 'test 批次', 't');
assert.equal(requests.length, 1);
const [{ record, entries }] = requests;
assert.equal(record.format, SAMPLE_FORMAT);
assert.equal(record.app, 'test 批次');
assert.deepEqual(record.prescriptions.map(p => p.merged), [['T01紅'], undefined, ['同成分重複黃']]);
assert.deepEqual(record.prescriptions.map(p => p.unmapped), [['TESTDUTA01'], ['TESTOTHR01'], []]);
assert.deepEqual(record.prescriptions.map(p => p.qrs), [1, 1, 2]);
assert.equal(record.failed.length, 1);
assert.equal(entries.length, 4);
const text = JSON.stringify(record);
for (const secret of ['測試甲', '測試乙', 'A223456789', '0900101', 'patient']) assert.ok(!text.includes(secret), secret);
// Without the rule data or lookup, lines go without the check, merged rules or 對照檔查無.
const bare = log.requests(undefined, undefined, 'x', 't')[0].record.prescriptions[0];
assert.ok(!('check' in bare) && !('merged' in bare) && !('unmapped' in bare));

// A request sent is not sent again, and the patient's sent lines still count for the combined check of the rest.
log.markSent([entries[0]]);
assert.equal(log.unsent.length, 3);
requests = log.requests(data, undefined, 'x', 't');
assert.deepEqual(requests[0].record.prescriptions.map(p => p.merged), [undefined, ['同成分重複黃']]);
// A drugs-only second QR joins the line before it, unless that line has gone.
assert.equal(log.scan('k5', drugsQR(['TESTALPR01'])).state, 'failed', 'the line before is a failure');
const fresh = new BatchLog();
fresh.scan('a', withSex);
assert.equal(fresh.scan('b', drugsQR(['TESTALPR01'])).state, 'appended');
fresh.markSent(fresh.entries);
assert.match(fresh.scan('c', drugsQR(['TESTQUET01'])).state, /^failed$/);
assert.match(fresh.entries[1].line, /^失敗：只有藥品的第 2 個 QR，但前一張處方已經匯入，欄位數 5$/);

// Saved without the patients: each line's patient by number, so a reload keeps the grouping but cannot join new scans to it.
const saved = JSON.parse(JSON.stringify(log.save()));
assert.deepEqual(saved.patients, [0, -1, 0, -1, -1]);
assert.deepEqual(saved.sent, [true, false, false, false, false]);
assert.ok(!JSON.stringify(saved).includes('測試甲'));
const reloaded = new BatchLog();
assert.ok(reloaded.load(saved));
assert.deepEqual(reloaded.groups(), [[0, 2], [1]]);
assert.ok(reloaded.restored(reloaded.entries[0]) && reloaded.isSent(reloaded.entries[0]));
assert.deepEqual(reloaded.merged(2, data), ['同成分重複黃']);
assert.equal(reloaded.scan('n', withSex).state, 'duplicate', 'a restored line rescanned');
reloaded.scan('m', qr('E11', ['TESTQUET01']));
assert.deepEqual(reloaded.groups(), [[0, 2], [1], [5]]);
for (const broken of [null, {}, { ...saved, version: 2 }, { ...saved, sent: [] }, { ...saved, patients: saved.patients.map(() => -2) }]) assert.ok(!new BatchLog().load(broken));

// A large batch goes as the sheet takes it: MAX_BATCH prescriptions and MAX_FAILED failure lines a request.
const big = new BatchLog();
for (let i = 0; i < MAX_BATCH * 2 + 1; i++) big.scan(`p${i}`, qr('E11', ['TESTMETF01'], { 4: `病人${i}`, 5: '', 8: '1150102', 9: `V${i}` }));
for (let i = 0; i < MAX_FAILED + 1; i++) big.scan(`f${i}`, qr('E11', ['TESTMETF01'], { 1: `院所${i}` }));
const chunks = big.requests(undefined, undefined, 'x', 't');
assert.deepEqual(chunks.map(c => [c.record.prescriptions.length, c.record.failed.length]), [[MAX_BATCH, MAX_FAILED], [MAX_BATCH, 1], [1, 0]]);
assert.equal(chunks.reduce((n, c) => n + c.entries.length, 0), big.entries.length);
big.remove(0);
assert.equal(big.collected, MAX_BATCH * 2);
console.log('batch-model ok');
