import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parsePrescriptionSlip } from '../src/prescription-qr';
import { checkPrescription, compileRules, dxLabel, ingredientBases, ruleTable, RULE_FILES, type DrugInfo, type IcdEntry, type RuleTables, type RxFacts } from '../src/rx-check';
import { rxCheckOn } from '../src/rx-check-config';

// Synthetic prescriptions, drug codes and rule tables only; the ATC and ICD-10-CM codes are the public classifications.
const csv = (header: string, ...rows: string[]) => ruleTable([header, ...rows].join('\n'));
const tables = (changes: Partial<RuleTables> = {}): RuleTables => ({
  indications: csv('ATC,藥理類別,可解釋的ICD-10,依據,備註',
    'A10BA,測試類別,R73.0,常見仿單外,', 'A10,測試類別,E08-E13,仿單,', 'B01AC,測試類別,I20-I25,仿單,', 'N05BA,測試類別,F40-F48,仿單,'),
  'co-drugs': csv('ATC,可由同處方的ATC解釋,依據,備註', 'A02BC,B01AC,常見,胃腸保護'),
  cautions: csv('編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據',
    'T01,C07AA,,診斷,J45 J44,紅,測試提示甲,', 'T02,,METFORMIN,診斷,N18.4,紅,測試提示乙,', 'T03,N05BA,,年齡,>=65,灰,測試提示丙,',
    'T04,N02A,,同處方,N05BA,黃,測試提示丁,', 'T05,N05BA,,年齡,>=67,黃,測試提示戊,'),
  specialty: csv('科別代碼,科別,該科常開的ATC', 'AB,心臟血管內科,C10'),
  'drug-classes': csv('ATC,類型,說明', 'A06,低風險,', 'N05A N02A,高警訊,'),
  settings: csv('設定,值,可選的值,說明', '同成分重複,黃,紅 黃 灰,', '科別常用,保留,保留 停用,'),
  ...changes,
});
const rules = compileRules(tables());
const drugs = new Map<string, DrugInfo>(Object.entries({
  TESTMETF01: { atc: 'A10BA02', ingredients: 'METFORMIN HCL 500 MG' }, TESTMETF02: { atc: 'A10BA02', ingredients: 'Metformin Hydrochloride 850 mg' },
  TESTCLOP01: { atc: 'B01AC04', ingredients: 'CLOPIDOGREL 75 MG' }, TESTPPI001: { atc: 'A02BC01', ingredients: 'OMEPRAZOLE 20 MG' },
  TESTSTAT01: { atc: 'C10AA05', ingredients: 'ATORVASTATIN CALCIUM 10 MG' }, TESTLAXA01: { atc: 'A06AD11', ingredients: 'LACTULOSE 667 MG/ML' },
  TESTQUET01: { atc: 'N05AH04', ingredients: 'QUETIAPINE FUMARATE 25 MG' }, TESTPROP01: { atc: 'C07AA05', ingredients: 'PROPRANOLOL HCL 10 MG' },
  TESTALPR01: { atc: 'N05BA12', ingredients: 'ALPRAZOLAM 0.5 MG' }, TESTTRAM01: { atc: 'N02AX02', ingredients: 'TRAMADOL HCL 37.5 MG+ACETAMINOPHEN 325 MG' },
  TESTACET01: { atc: 'N02BE01', ingredients: 'ACETAMINOPHEN 500 MG' }, TESTOTHR01: { atc: 'R01AD05', ingredients: 'BUDESONIDE 64 MCG' },
}));
// A QR as a hospital prints it: 14 fixed fields, then code, dose, frequency, route and total for each drug.
const qr = (dx: string, drugCodes: string[], changes: Record<number, string> = {}) => {
  const fields = ['0000000000', '2', '', '測試', 'A123456789', '0500101', 'AB', '1150101', '', '28', '', dx, '', '',
    ...drugCodes.flatMap(code => [code, '1', 'BID', 'PO', '56'])];
  for (const [n, value] of Object.entries(changes)) fields[Number(n) - 1] = value;
  return parsePrescriptionSlip(fields.join(';') + ';').rx;
};
const verdicts = (rx: RxFacts, use = rules) => checkPrescription(rx, drugs, use).drugs.map(drug => `${drug.verdict} ${drug.reason}`);

// The QR fields the check reads: case, spaces and dots do not matter; a padded 就醫科別 is read, a hospital's own one is not.
let rx = qr('e11.9#i10#', ['testmetf01 ', 'TESTCLOP01'], { 7: 'ab00' });
assert.deepEqual(rx, { dx: ['E119', 'I10'], dept: 'AB', age: 'AGE65-69', drugs: [{ code: 'TESTMETF01', frequency: 'BID', route: 'PO' }, { code: 'TESTCLOP01', frequency: 'BID', route: 'PO' }] });
for (const [dept, read] of [['AB', 'AB'], ['01', '01'], ['0100', '01'], ['AB01', ''], ['146', ''], ['0NB', ''], ['', '']]) assert.equal(qr('I10', ['TESTSTAT01'], { 7: dept }).dept, read, dept);
assert.deepEqual(qr('', ['TESTSTAT01']).dx, []);
assert.deepEqual(qr(' # E11 ##', ['TESTSTAT01']).dx, ['E11']);

// Layers in order: a diagnosis, another drug, the department, a low-risk drug; then high-alert yellow, anything else grey.
assert.deepEqual(verdicts(qr('E11.9', ['TESTMETF01'])), ['適應症 E119（仿單）']);
assert.deepEqual(verdicts(qr('R73.0', ['TESTMETF01'])), ['適應症 R730（常見仿單外）'], 'only the off-label row explains it');
assert.deepEqual(verdicts(qr('E11.9#R73.0', ['TESTMETF01'])), ['適應症 E119（仿單）'], 'a label indication is tried before an off-label one listed first');
assert.deepEqual(verdicts(qr('I25.10#I26.99', ['TESTCLOP01'])), ['適應症 I2510（仿單）'], 'I20-I25 holds I25.10, not I26.99');
assert.deepEqual(verdicts(qr('I10', ['TESTPPI001', 'TESTCLOP01'])), ['同處方 同處方 B01AC04：胃腸保護（常見）', '灰 本次診斷與科別都無法解釋（預設收合）']);
assert.deepEqual(verdicts(qr('I10', ['TESTSTAT01'])), ['科別常用 本次診斷無對應，心臟血管內科常開']);
assert.deepEqual(verdicts(qr('I10', ['TESTSTAT01'], { 7: '02' })), ['灰 本次診斷與科別都無法解釋（預設收合）']);
const noDepartment = compileRules(tables({ settings: csv('設定,值,可選的值,說明', '同成分重複,黃,紅 黃 灰,', '科別常用,停用,保留 停用,') }));
assert.deepEqual(verdicts(qr('I10', ['TESTSTAT01']), noDepartment), ['灰 本次診斷與科別都無法解釋（預設收合）'], 'settings.csv can switch the department layer off');
assert.deepEqual(verdicts(qr('I10', ['TESTLAXA01'])), ['低風險 本次診斷無對應，低風險藥不提示']);
assert.deepEqual(verdicts(qr('I10', ['TESTQUET01'])), ['黃 高警訊藥，本次診斷與科別都無法解釋']);
assert.deepEqual(verdicts(qr('I10', ['TESTOTHR01'])), ['灰 本次診斷與科別都無法解釋（預設收合）']);
assert.deepEqual(verdicts(qr('I10', ['TESTSPEC01'])), ['低風險 不在健保用藥品項（可能是特材）']);
// The same code twice does not explain itself.
assert.deepEqual(verdicts(qr('I10', ['TESTPPI001', 'TESTPPI001'])), ['灰 本次診斷與科別都無法解釋（預設收合）', '灰 本次診斷與科別都無法解釋（預設收合）']);
// Without diagnoses: one grey note for the prescription, and a high-alert drug is only grey.
let result = checkPrescription(qr('', ['TESTQUET01', 'TESTCLOP01']), drugs, rules);
assert.deepEqual(result.notes, [{ level: '灰', text: '處方沒有診斷碼，無法解釋的藥不另提示' }]);
assert.deepEqual(result.drugs.map(drug => `${drug.verdict} ${drug.reason}`), ['灰 處方沒有診斷碼', '灰 處方沒有診斷碼']);

// Cautions apply whatever the verdict: by diagnosis (ATC or ingredient keyword), age band, or another drug.
const notes = (rx: RxFacts) => checkPrescription(rx, drugs, rules).drugs.flatMap(drug => drug.notes.map(note => `${drug.code} ${note.level} ${note.text}`));
assert.deepEqual(notes(qr('I10#J45.909', ['TESTPROP01'])), ['TESTPROP01 紅 T01 測試提示甲（本次：J45909）']);
assert.deepEqual(notes(qr('E11.9#N18.4', ['TESTMETF02'])), ['TESTMETF02 紅 T02 測試提示乙（本次：N184）'], 'the keyword matches 成分 in any case');
assert.deepEqual(notes(qr('E11.9#N18.30', ['TESTMETF01'])), []);
assert.deepEqual(notes(qr('F41.1', ['TESTALPR01'], { 6: '0450101' })), ['TESTALPR01 灰 T03 測試提示丙（AGE70-79）', 'TESTALPR01 黃 T05 測試提示戊（AGE70-79）']);
assert.deepEqual(notes(qr('F41.1', ['TESTALPR01'], { 6: '0550101' })), [], 'AGE60-64 is under both');
assert.deepEqual(notes(qr('F41.1', ['TESTALPR01'])), ['TESTALPR01 灰 T03 測試提示丙（AGE65-69）', 'TESTALPR01 灰 T05 無法判斷：AGE65-69 跨過 67 歲']);
assert.deepEqual(notes(qr('F41.1', ['TESTALPR01'], { 6: '' })), ['TESTALPR01 灰 T03 無法判斷：沒有年齡', 'TESTALPR01 灰 T05 無法判斷：沒有年齡']);
assert.deepEqual(notes(qr('F41.1', ['TESTALPR01'], { 6: '50/01/01' })), ['TESTALPR01 灰 T03 無法判斷：AGE?99/99/99 跨過 65 歲', 'TESTALPR01 灰 T05 無法判斷：AGE?99/99/99 跨過 67 歲']);
assert.deepEqual(notes(qr('M54.5#F41.1', ['TESTTRAM01', 'TESTALPR01'], { 6: '0550101' })), ['TESTTRAM01 黃 T04 測試提示丁（同處方：N05BA12）']);
assert.deepEqual(notes(qr('I10#J45.909', ['TESTSPEC01'])), [], 'a code outside the NHI list has no cautions');

// Repeated ingredients, compared without strength, brackets or salt; a repeated code is not one.
assert.deepEqual(ingredientBases('METFORMIN HCL 500 MG'), ['METFORMIN']);
assert.deepEqual(ingredientBases('Metformin Hydrochloride 850 mg'), ['METFORMIN']);
assert.deepEqual(ingredientBases('TRAMADOL HCL 37.5 MG+ACETAMINOPHEN 325 MG'), ['TRAMADOL', 'ACETAMINOPHEN']);
assert.deepEqual(ingredientBases('NYSTATIN 100000 U (UNIT)'), ['NYSTATIN']);
assert.deepEqual(ingredientBases('ATROPINE SULFATE .1 MG/ML'), ['ATROPINE']);
assert.deepEqual(ingredientBases('INSULIN GLARGINE 100 IU/ML+INSULIN ASPART 100 IU/ML'), ['INSULIN GLARGINE', 'INSULIN ASPART']);
assert.deepEqual(ingredientBases('PETROLATUM 1 GM'), ['PETROLATUM 1 GM'], 'GM is not one of the strength units, as in the prototype');
result = checkPrescription(qr('E11.9#M54.5', ['TESTMETF01', 'TESTMETF02', 'TESTTRAM01', 'TESTACET01', 'TESTACET01']), drugs, rules);
assert.deepEqual(result.notes, [{ level: '黃', text: '同成分重複：METFORMIN 出現在 2 個品項' }, { level: '黃', text: '同成分重複：ACETAMINOPHEN 出現在 2 個品項' }]);
const greyRepeats = compileRules(tables({ settings: csv('設定,值,可選的值,說明', '同成分重複,灰,紅 黃 灰,', '科別常用,保留,保留 停用,') }));
assert.equal(checkPrescription(qr('E11.9', ['TESTMETF01', 'TESTMETF02']), drugs, greyRepeats).notes[0].level, '灰', 'settings.csv sets the level');

// The page names diagnoses in Chinese; a missing full code falls back to its category and says so.
const icd = new Map<string, IcdEntry>([['E11', { name: '測試類別名', deleted: false }], ['E119', { name: '測試完整碼名', deleted: false }],
  ['I10', { name: '測試名稱', deleted: false }], ['I1590', { name: '測試舊碼名', deleted: true }]]);
assert.equal(dxLabel('E119', icd), 'E11.9 測試完整碼名');
assert.equal(dxLabel('E1165', icd), 'E11 測試類別名（查無 E1165，此為類別）');
assert.equal(dxLabel('I1590', icd), 'I15.90 測試舊碼名（舊碼，2014 版已刪除）');
assert.equal(dxLabel('Z999', icd), 'Z999（查無此碼）');
const labelled = checkPrescription(qr('E11.9#I10', ['TESTMETF01']), drugs, compileRules(tables({ indications: csv('ATC,藥理類別,可解釋的ICD-10,依據,備註', 'A10,測試類別,E11 I10,仿單,') })),
  { dx: code => dxLabel(code, icd), join: '、' });
assert.equal(labelled.drugs[0].reason, 'E11.9 測試完整碼名、I10 測試名稱（仿單）');

// A mistyped table stops `npm run rx-assets` with the file, row and column.
const broken = (file: keyof RuleTables, header: string, row: string) => () => compileRules(tables({ [file]: csv(header, row) }));
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,診斷,J45,橙,測試,'), /cautions\.csv 第 2 列「等級」/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,體重,>=65,黃,測試,'), /「條件類型」/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,年齡,65,黃,測試,'), />=65/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,,,診斷,J45,黃,測試,'), /至少要填一個/);
assert.throws(broken('indications', 'ATC,藥理類別,可解釋的ICD-10,依據,備註', 'C1O,測試,I10,仿單,'), /不是 ATC 前綴/);
assert.throws(broken('indications', 'ATC,藥理類別,可解釋的ICD-10,依據,備註', 'C10,測試,I10-I1,仿單,'), /範圍兩端的碼長相同/);
assert.throws(broken('indications', 'ATC,藥理類別,可解釋的ICD-10,依據,備註', 'C10,測試,I16-I10,仿單,'), /前小後大/);
assert.throws(broken('indications', 'ATC,藥理類別,可解釋的ICD-10,備註', 'C10,測試,I10,'), /「依據」：缺少此欄/);
assert.throws(broken('specialty', '科別代碼,科別,該科常開的ATC,出處', 'AB,測試,C,'), /「出處」：多出此欄/);
assert.throws(broken('settings', '設定,值,可選的值,說明', '同成分重複,橙,紅 黃 灰,'), /settings\.csv 第 2 列「值」/);
assert.throws(broken('settings', '設定,值,可選的值,說明', '同成分重複,黃,紅 黃 灰,'), /缺少「科別常用」/);

// The switch: off by default until the rules are reviewed; the address turns it on or off for one page load.
assert.equal(rxCheckOn(''), false);
assert.equal(rxCheckOn('?rxcheck=1'), true);
assert.equal(rxCheckOn('?rxcheck=0', true), false);
assert.equal(rxCheckOn('?other=1', true), true);

// The published assets match docs/reference: rerun `npm run rx-assets` after editing a table or refreshing a reference file.
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const published = JSON.parse(readFileSync('public/assets/rx/rules.json', 'utf8'));
for (const file of RULE_FILES) {
  const path = `docs/reference/rx-rules/${file}.csv`;
  assert.deepEqual(published.tables[file], ruleTable(readFileSync(path, 'utf8')), `${path} 改過了，請執行 npm run rx-assets`);
  assert.equal(published.sourceSha256[`${file}.csv`], sha256(path), `${path} 改過了，請執行 npm run rx-assets`);
}
compileRules(published.tables);
for (const [asset, source] of [['drugs', 'nhi-drug-codes'], ['icd10cm', 'icd10cm-zh']]) {
  // Read the header only: the files are megabytes.
  const head = readFileSync(`public/assets/rx/${asset}.json`, 'utf8').slice(0, 400);
  assert.match(head, new RegExp(`"sourceSha256":"${sha256(`docs/reference/${source}.csv`)}"`), `docs/reference/${source}.csv 改過了，請執行 npm run rx-assets`);
}
console.log('prescription check layers, cautions, repeated ingredients, rule checks and published assets passed');
