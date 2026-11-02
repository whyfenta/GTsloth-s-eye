import assert from 'node:assert/strict';
import { markedSex, rxFacts, splitFields } from '../src/prescription-qr';
import { deidentify } from '../src/prescription-sample';
import { checkPrescription, compileRules, ruleTable, type DrugInfo, type IcdEntry, type RuleTables } from '../src/rx-check';
import { rulesVersion, type RxData } from '../src/rx-data';
import { MAX_BATCH, MAX_FAILED, SAMPLE_FORMAT, sampleCheck, sampleOf, sampleRecords, sendSamples, withDrugs } from '../src/rx-sample';
import { samplesOn } from '../src/sample-config';

// Synthetic prescriptions, drug codes and rule tables only; the ATC and ICD-10-CM codes are the public classifications.
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

// A QR as a hospital prints it: 14 fixed fields, then code, dose, frequency, route and total for each drug.
const NAME = '測試甲', ID = 'A223456789', BIRTH = '0900101';
const qr = (dx: string, codes: string[], changes: Record<number, string> = {}) => {
  const fields = ['0000000000', '2', '', NAME, ID, BIRTH, 'AB', '1150101', 'TESTVISIT1', '28', '', dx, '0000000000', '9,TESTNOTE01',
    ...codes.flatMap(code => [code, '1', 'BID', 'PO', '56'])];
  for (const [n, value] of Object.entries(changes)) fields[Number(n) - 1] = value;
  return fields.join(';') + ';';
};
const drugsQR = (codes: string[]) => codes.flatMap(code => [code, '1', 'QD', 'PO', '28']).join(';') + ';';

// The sample line is the collector's line; a QR the collector turns down is its failure line.
let sample = sampleOf(qr('E11.9#N40#', ['TESTMETF01', 'TESTDUTA01']));
assert.deepEqual(sample, { line: deidentify(qr('E11.9#N40#', ['TESTMETF01', 'TESTDUTA01'])), qrs: 1 });
assert.match(sampleOf(qr('E11', ['TESTMETF01'], { 1: '測試院所' })).line, /^失敗：第 1 欄出現中文或全形字.*欄位數 19$/);
// A drugs-only second QR joins the line; a failed line takes none, and a broken second QR is its own failure line.
const joined = withDrugs(sample, drugsQR(['TESTALPR01']));
assert.equal(joined.sample.line, `${sample.line}TESTALPR01;1;QD;PO;28;`);
assert.equal(joined.sample.qrs, 2);
const failed = sampleOf(qr('E11', ['TESTMETF01'], { 2: '２' }));
assert.equal(withDrugs(failed, drugsQR(['TESTALPR01'])).sample, failed);
assert.match(withDrugs(sample, 'TESTALPR01;1;Q\nD;PO;28;').failed ?? '', /^失敗：/);
assert.equal(withDrugs(sample, 'TESTALPR01;1;Q\nD;PO;28;').sample, sample);

// The check is worked out again from the de-identified line, so a pharmacist re-running the line gets the same.
const fields = splitFields(joined.sample.line);
const expected = checkPrescription(rxFacts(fields, fields[5], markedSex(fields[4])), drugs, data.rules);
let check = sampleCheck(joined.sample.line, data);
assert.deepEqual(check, {
  top: '紅',
  alerts: [`紅 TESTDUTA01 G04CB02 ${expected.drugs[1].notes[0].text}`],
  cautions: ['T01紅'],
  unexplained: ['TESTDUTA01 G04CB02', 'TESTALPR01 N05BA12'],
  unknownDrugs: [], unknownDx: [],
});
assert.match(check.alerts[0], /T01 測試提示甲（女性；AGE20-29）/);
// A yellow high-alert drug, a grey caution, codes the lookups do not know.
check = sampleCheck(sampleOf(qr('E11#V01.0#X99#E11.99', ['TESTQUET01', 'TESTALPR01', 'TESTSPEC01'], { 6: '0400101' })).line, data);
assert.equal(check.top, '黃');
assert.deepEqual(check.alerts, ['黃 TESTQUET01 N05AH04 高警訊藥，本次診斷與科別都無法解釋']);
assert.deepEqual(check.cautions, ['T02灰']);
assert.deepEqual(check.unexplained, ['TESTALPR01 N05BA12']);
assert.deepEqual(check.unknownDrugs, ['TESTSPEC01']);
assert.deepEqual(check.unknownDx, ['V010 舊碼', 'X99 查無', 'E1199 類別']);
// No diagnosis: grey for the prescription, no drug counted as unexplained.
check = sampleCheck(sampleOf(qr('', ['TESTOTHR01'])).line, data);
assert.equal(check.top, '灰');
assert.deepEqual(check.unexplained, []);
assert.equal(sampleCheck(sampleOf(qr('E11', ['TESTMETF01'])).line, data).top, '');

// The request: format, rules version, lines with their checks, failures with the first request; nothing identifying.
const lines = Array.from({ length: MAX_BATCH + 3 }, (_, i) => sampleOf(qr('E11', ['TESTMETF01'], { 8: `11501${String(i + 1).padStart(2, '0')}` })));
const records = sampleRecords([joined.sample, failed, ...lines], ['失敗：測試原因，欄位數 3'], data, '9.9.9', '2026-11-02T00:00:00.000Z');
assert.equal(records.length, 2);
assert.deepEqual(records.map(record => record.prescriptions.length), [MAX_BATCH, 4]);
assert.deepEqual(records[0].failed, [failed.line, '失敗：測試原因，欄位數 3']);
assert.deepEqual(records[1].failed, []);
assert.deepEqual({ ...records[0], prescriptions: [], failed: [] }, { format: SAMPLE_FORMAT, version: 1, app: '9.9.9', sent: '2026-11-02T00:00:00.000Z', rules: 'abcdef012345', prescriptions: [], failed: [] });
assert.deepEqual(records[0].prescriptions[0], { line: joined.sample.line, qrs: 2, check: sampleCheck(joined.sample.line, data) });
const text = JSON.stringify(records);
for (const secret of [NAME, ID, ID.slice(2), BIRTH, 'TESTVISIT1', 'TESTNOTE01']) assert.ok(!text.includes(secret), secret);
// Without the rule data the lines still go, unchecked and with no rules version; failures alone make one request; nothing, none.
const unchecked = sampleRecords([sample], [], undefined, 'x', 't');
assert.deepEqual(unchecked, [{ format: SAMPLE_FORMAT, version: 1, app: 'x', sent: 't', rules: '', prescriptions: [{ line: sample.line, qrs: 1 }], failed: [] }]);
assert.deepEqual(sampleRecords([], ['失敗：a，欄位數 1'], data, 'x', 't').map(record => [record.prescriptions.length, record.failed.length]), [[0, 1]]);
assert.deepEqual(sampleRecords([], [], data, 'x', 't'), []);
assert.equal(sampleRecords([], Array.from({ length: MAX_FAILED + 5 }, (_, i) => `失敗：${i}，欄位數 1`), data, 'x', 't')[0].failed.length, MAX_FAILED);

// Each request goes out as the simple text/plain POST the Apps Script takes.
const calls: [string, RequestInit][] = [];
await sendSamples(records, 'https://script.example/exec', (async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response(); }) as typeof fetch);
assert.equal(calls.length, 2);
assert.deepEqual(calls.map(([url, init]) => [url, init.method, init.mode, JSON.parse(init.body as string)]), records.map(record => ['https://script.example/exec', 'POST', 'no-cors', record]));

// Sending is on whenever there is an address; ?samples=0 turns it off for one page load.
assert.equal(samplesOn('', ''), false);
assert.equal(samplesOn('?samples=1', ''), false);
assert.equal(samplesOn('', 'https://script.example/exec'), true);
assert.equal(samplesOn('?rxcheck=1', 'https://script.example/exec'), true);
assert.equal(samplesOn('?samples=0', 'https://script.example/exec'), false);
// The rules version: the first 4 hex digits of each table's SHA-256 in rules.json, in RULE_FILES order.
const sha = (c: string) => c.repeat(64);
assert.equal(rulesVersion({ tables, sourceSha256: { 'indications.csv': sha('a'), 'co-drugs.csv': sha('b'), 'cautions.csv': sha('c'), 'specialty.csv': sha('d'),
  'drug-classes.csv': sha('e'), 'settings.csv': sha('f') } }), 'aaaabbbbccccddddeeeeffff');
assert.equal(rulesVersion({ tables }), '-'.repeat(24));
console.log('rx-sample tests passed');
