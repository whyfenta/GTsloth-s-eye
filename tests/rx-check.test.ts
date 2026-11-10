import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parsePrescriptionSlip } from '../src/prescription-qr';
import { checkPrescription, checkPrescriptions, compileRules, dxLabel, kidneyBelow, kidneyStage, roughEgfr, dxParts, ingredientBases, ruleTable, RULE_FILES, type DrugInfo, type IcdEntry, type RuleTables, type RxFacts } from '../src/rx-check';
import { rxCheckOn } from '../src/rx-check-config';

// Synthetic prescriptions, drug codes and rule tables only; the ATC and ICD-10-CM codes are the public classifications.
const csv = (header: string, ...rows: string[]) => ruleTable([header, ...rows].join('\n'));
const tables = (changes: Partial<RuleTables> = {}): RuleTables => ({
  indications: csv('ATC,藥理類別,可解釋的ICD-10,依據,備註',
    'A10BA,測試類別,R73.0,常見仿單外,', 'A10,測試類別,E08-E13,仿單,', 'B01AC,測試類別,I20-I25,仿單,', 'N05BA,測試類別,F40-F48,仿單,'),
  'co-drugs': csv('ATC,可由同處方的ATC解釋,依據,備註', 'A02BC,B01AC,常見,胃腸保護'),
  cautions: csv('編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據',
    'T01,C07AA,,診斷,J45 J44,紅,測試提示甲,', 'T02,,METFORMIN,診斷,N18.4,紅,測試提示乙,', 'T03,N05BA,,年齡,>=65,灰,測試提示丙,',
    'T04,N02A,,同處方,N05BA,黃,測試提示丁,', 'T05,N05BA,,年齡,>=67,黃,測試提示戊,', 'T06,N05BA,,年齡+同處方,>=65;G04CA C08@HS,黃,測試提示己,',
    'T07,G04CB,,性別+年齡,女;<50,紅,測試提示庚,'),
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
  TESTTAMS01: { atc: 'G04CA02', ingredients: 'TAMSULOSIN HCL 0.2 MG' }, TESTAMLO01: { atc: 'C08CA01', ingredients: 'AMLODIPINE BESYLATE 5 MG' },
  TESTDUTA01: { atc: 'G04CB02', ingredients: 'DUTASTERIDE 0.5 MG' },
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
assert.deepEqual(rx, { dx: ['E119', 'I10'], dept: 'AB', age: 'AGE65-69', sex: 'M', drugs: [{ code: 'TESTMETF01', frequency: 'BID', route: 'PO' }, { code: 'TESTCLOP01', frequency: 'BID', route: 'PO' }] });
for (const [dept, read] of [['AB', 'AB'], ['01', '01'], ['0100', '01'], ['AB01', ''], ['146', ''], ['0NB', ''], ['', '']]) assert.equal(qr('I10', ['TESTSTAT01'], { 7: dept }).dept, read, dept);
assert.deepEqual(qr('', ['TESTSTAT01']).dx, []);
assert.deepEqual(qr(' # E11 ##', ['TESTSTAT01']).dx, ['E11']);
// Sex from the ID number's second character: 身分證 1 or 2, 統一證號 8 or 9 and the older A–D; another character or no ID is unknown.
for (const [id, sex] of [['A123456789', 'M'], ['B234567890', 'F'], ['A823456789', 'M'], ['A923456789', 'F'], ['AC23456789', 'M'], ['AD23456789', 'F'],
  ['A323456789', ''], ['', '']]) assert.equal(qr('I10', ['TESTSTAT01'], { 5: id }).sex, sex, id);

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
assert.deepEqual(notes(qr('F41.1', ['TESTALPR01'], { 6: '' })), ['TESTALPR01 灰 T03 無法讀取年齡', 'TESTALPR01 灰 T05 無法讀取年齡']);
assert.deepEqual(notes(qr('F41.1', ['TESTALPR01'], { 6: '50/01/01' })), ['TESTALPR01 灰 T03 無法讀取年齡', 'TESTALPR01 灰 T05 無法讀取年齡']);
assert.deepEqual(notes(qr('M54.5#F41.1', ['TESTTRAM01', 'TESTALPR01'], { 6: '0550101' })), ['TESTTRAM01 黃 T04 測試提示丁（同處方：N05BA12）']);
assert.deepEqual(notes(qr('I10#J45.909', ['TESTSPEC01'])), [], 'a code outside the NHI list has no cautions');
// Several conditions must all hold. One that has another's conditions and more, for the same drugs, replaces it: T06 is T03 plus another
// drug. C08@HS counts amlodipine only at a frequency containing HS (fields 20–24 are the second drug).
assert.deepEqual(notes(qr('F41.1#N40', ['TESTALPR01', 'TESTTAMS01'])), ['TESTALPR01 灰 T05 無法判斷：AGE65-69 跨過 67 歲', 'TESTALPR01 黃 T06 測試提示己（AGE65-69；同處方：G04CA02）']);
assert.deepEqual(notes(qr('F41.1#I10', ['TESTALPR01', 'TESTAMLO01'])), ['TESTALPR01 灰 T03 測試提示丙（AGE65-69）', 'TESTALPR01 灰 T05 無法判斷：AGE65-69 跨過 67 歲']);
assert.deepEqual(notes(qr('F41.1#I10', ['TESTALPR01', 'TESTAMLO01'], { 22: 'QDHS' })), ['TESTALPR01 灰 T05 無法判斷：AGE65-69 跨過 67 歲', 'TESTALPR01 黃 T06 測試提示己（AGE65-69；同處方：C08CA01）']);
assert.deepEqual(notes(qr('F41.1#N40', ['TESTALPR01', 'TESTTAMS01'], { 6: '0550101' })), [], 'AGE60-64: T06 fails on age even with the other drug');
// Sex and age: a woman under 50, also by a 統一證號; unknown sex (an ID format without it) or an unreadable age is grey only while the other condition holds.
assert.deepEqual(notes(qr('L64.9', ['TESTDUTA01'], { 5: 'B234567890', 6: '0750101' })), ['TESTDUTA01 紅 T07 測試提示庚（女性；AGE40-49）']);
assert.deepEqual(notes(qr('L64.9', ['TESTDUTA01'], { 5: 'A923456789', 6: '0750101' })), ['TESTDUTA01 紅 T07 測試提示庚（女性；AGE40-49）']);
assert.deepEqual(notes(qr('L64.9', ['TESTDUTA01'], { 6: '0750101' })), [], 'a man');
assert.deepEqual(notes(qr('L64.9', ['TESTDUTA01'], { 5: 'A823456789', 6: '0750101' })), [], 'a man by a 統一證號');
assert.deepEqual(notes(qr('L64.9', ['TESTDUTA01'], { 5: 'A323456789', 6: '0750101' })), ['TESTDUTA01 灰 T07 無法取得性別資料']);
assert.deepEqual(notes(qr('N40', ['TESTDUTA01'], { 5: 'A323456789' })), [], 'unknown sex, but AGE65-69 is not under 50');
assert.deepEqual(notes(qr('L64.9', ['TESTDUTA01'], { 5: 'B234567890', 6: '' })), ['TESTDUTA01 灰 T07 無法讀取年齡']);

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

// One patient's prescriptions from several departments are checked as one: every diagnosis against every drug, every drug
// against every other. A reason that leans on another prescription names it; one prescription alone is checked as before.
const combined = (...parts: RxFacts[]) => checkPrescriptions(parts, drugs, rules);
const combinedNotes = (...parts: RxFacts[]) => combined(...parts).drugs.flatMap(drug => drug.notes.map(note => `${drug.part} ${drug.code} ${note.level} ${note.text}`));
rx = qr('E11.9#M54.5', ['TESTMETF01', 'TESTTRAM01', 'TESTACET01', 'TESTACET01']);
assert.deepEqual(checkPrescriptions([rx], drugs, rules), checkPrescription(rx, drugs, rules), 'one prescription: the same check');
// A drug on one prescription against a diagnosis on another: the cardiologist's propranolol and the chest clinic's asthma.
assert.deepEqual(notes(qr('I10', ['TESTPROP01'])), [], 'the cardiology prescription alone');
assert.deepEqual(combinedNotes(qr('I10', ['TESTPROP01']), qr('J45.909', ['TESTOTHR01'], { 7: 'AC' })), ['0 TESTPROP01 紅 T01 測試提示甲（本次：第 2 張 J45909）']);
// A drug against a drug on another prescription; only those on the drug's own prescription are 同處方.
assert.deepEqual(combinedNotes(qr('M54.5', ['TESTTRAM01'], { 6: '0550101' }), qr('F41.1', ['TESTALPR01'], { 6: '0550101' })),
  ['0 TESTTRAM01 黃 T04 測試提示丁（併用：第 2 張 N05BA12）']);
assert.deepEqual(combinedNotes(qr('F41.1#N40', ['TESTALPR01', 'TESTTAMS01']), qr('I10', ['TESTAMLO01'])),
  ['0 TESTALPR01 灰 T05 無法判斷：AGE65-69 跨過 67 歲', '0 TESTALPR01 黃 T06 測試提示己（AGE65-69；同處方：G04CA02）']);
assert.deepEqual(combinedNotes(qr('F41.1', ['TESTALPR01']), qr('I10', ['TESTAMLO01'], { 17: 'QDHS' })),
  ['0 TESTALPR01 灰 T05 無法判斷：AGE65-69 跨過 67 歲', '0 TESTALPR01 黃 T06 測試提示己（AGE65-69；併用：第 2 張 C08CA01）'], 'the frequency on the other prescription counts');
// Explained by another prescription's diagnosis or drug; the department is the drug's own prescription's.
result = combined(qr('I10', ['TESTMETF01'], { 7: '02' }), qr('E11.9', ['TESTPPI001']), qr('I25.10', ['TESTCLOP01'], { 7: '02' }));
assert.deepEqual(result.drugs.map(drug => `${drug.part} ${drug.verdict} ${drug.reason}`),
  ['0 適應症 第 2 張 E119（仿單）', '1 同處方 第 3 張 B01AC04：胃腸保護（常見）', '2 適應症 I2510（仿單）']);
assert.deepEqual(combined(qr('I10', ['TESTPPI001', 'TESTCLOP01']), qr('I10', ['TESTCLOP01'])).drugs[0].reason, '同處方 B01AC04：胃腸保護（常見）', 'a partner on its own prescription first');
assert.deepEqual(combined(qr('I10', ['TESTPROP01']), qr('I10', ['TESTSTAT01'], { 7: '02' })).drugs[1].verdict, '灰', 'not the cardiology department of the other prescription');
// The same 健保碼 on two prescriptions is the drug given twice; on one it is not a repeated ingredient.
assert.deepEqual(combined(qr('I10', ['TESTAMLO01', 'TESTAMLO01']), qr('I10', ['TESTSTAT01'])).notes, []);
assert.deepEqual(combined(qr('I10', ['TESTAMLO01']), qr('E11.9', ['TESTMETF01']), qr('I10', ['TESTAMLO01'])).notes,
  [{ level: '黃', text: '同成分重複：AMLODIPINE 出現在 2 個品項（第 1 張、第 3 張）' }]);
assert.deepEqual(combined(qr('I10', ['TESTSTAT01']), qr('E11.9', ['TESTMETF01', 'TESTMETF02'])).notes, [{ level: '黃', text: '同成分重複：METFORMIN 出現在 2 個品項（第 2 張）' }]);
// Diagnoses: one prescription's are enough; a missing note only when none has any.
assert.deepEqual(combined(qr('', ['TESTQUET01']), qr('I10', ['TESTSTAT01'])).drugs[0].verdict, '黃', 'the other prescription has diagnoses');
assert.deepEqual(combined(qr('', ['TESTQUET01']), qr('', ['TESTSTAT01'])).notes, [{ level: '灰', text: '各張處方都沒有診斷碼，無法解釋的藥不另提示' }]);
// The page names the prescriptions by their cards.
assert.equal(checkPrescriptions([qr('I10', ['TESTPROP01']), qr('I10', ['TESTSTAT01']), qr('J45.909', ['TESTOTHR01'])], drugs, rules,
  { dx: code => code, atc: atc => atc, join: '、', part: index => `卡${index + 1}` }).drugs[0].notes[0].text, 'T01 測試提示甲（本次：卡3 J45909）');

// The page names diagnoses in Chinese; a missing full code falls back to its category and says so.
const icd = new Map<string, IcdEntry>([['E11', { name: '測試類別名', deleted: false }], ['E119', { name: '測試完整碼名', deleted: false }],
  ['I10', { name: '測試名稱', deleted: false }], ['I1590', { name: '測試舊碼名', deleted: true }]]);
assert.equal(dxLabel('E119', icd), 'E11.9 測試完整碼名');
assert.equal(dxLabel('E1165', icd), 'E11 測試類別名（查無 E1165，此為類別）');
assert.equal(dxLabel('I1590', icd), 'I15.90 測試舊碼名（舊碼，2014 版已刪除）');
assert.equal(dxLabel('Z999', icd), 'Z999（查無此碼）');
// The 憑單 card lists each diagnosis with its code and name in their own columns: the same text, split.
assert.deepEqual(dxParts('E119', icd), { code: 'E11.9', name: '測試完整碼名', found: true });
assert.deepEqual(dxParts('E1165', icd), { code: 'E11', name: '測試類別名（查無 E1165，此為類別）', found: true });
assert.deepEqual(dxParts('Z999', icd), { code: 'Z999', name: '（查無此碼）', found: false });
const labelled = checkPrescription(qr('E11.9#I10', ['TESTMETF01']), drugs, compileRules(tables({ indications: csv('ATC,藥理類別,可解釋的ICD-10,依據,備註', 'A10,測試類別,E11 I10,仿單,') })),
  { dx: code => dxLabel(code, icd), atc: code => code, join: '、' });
assert.equal(labelled.drugs[0].reason, 'E11.9 測試完整碼名、I10 測試名稱（仿單）');
// The page also names the other drug a reason or caution points to.
const named = { dx: (code: string) => code, atc: (code: string) => `測試藥名（${code}）`, join: '、' };
assert.equal(checkPrescription(qr('I10', ['TESTPPI001', 'TESTCLOP01']), drugs, rules, named).drugs[0].reason, '同處方 測試藥名（B01AC04）：胃腸保護（常見）');
assert.deepEqual(checkPrescription(qr('M54.5#F41.1', ['TESTTRAM01', 'TESTALPR01'], { 6: '0550101' }), drugs, rules, named).drugs[0].notes,
  [{ level: '黃', text: 'T04 測試提示丁（同處方：測試藥名（N05BA12））' }]);

// A mistyped table stops `npm run rx-assets` with the file, row and column.
const broken = (file: keyof RuleTables, header: string, row: string) => () => compileRules(tables({ [file]: csv(header, row) }));
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,診斷,J45,橙,測試,'), /cautions\.csv 第 2 列「等級」/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,體重,>=65,黃,測試,'), /「條件類型」/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,年齡,65,黃,測試,'), />=65/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,,,診斷,J45,黃,測試,'), /至少要填一個/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,年齡+同處方,>=65,黃,測試,'), /要有 2 段/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,年齡+年齡,>=65;<50,黃,測試,'), /只能寫一次/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,性別,F,黃,測試,'), /男或女/);
assert.throws(broken('cautions', '編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'T01,C07AA,,同處方,C08@hs,黃,測試,'), /C08@HS/);
assert.throws(broken('indications', 'ATC,藥理類別,可解釋的ICD-10,依據,備註', 'C1O,測試,I10,仿單,'), /不是 ATC 前綴/);
assert.throws(broken('indications', 'ATC,藥理類別,可解釋的ICD-10,依據,備註', 'C10,測試,I10-I1,仿單,'), /範圍兩端的碼長相同/);
assert.throws(broken('indications', 'ATC,藥理類別,可解釋的ICD-10,依據,備註', 'C10,測試,I16-I10,仿單,'), /前小後大/);
assert.throws(broken('indications', 'ATC,藥理類別,可解釋的ICD-10,備註', 'C10,測試,I10,'), /「依據」：缺少此欄/);
assert.throws(broken('specialty', '科別代碼,科別,該科常開的ATC,出處', 'AB,測試,C,'), /「出處」：多出此欄/);
assert.throws(broken('settings', '設定,值,可選的值,說明', '同成分重複,橙,紅 黃 灰,'), /settings\.csv 第 2 列「值」/);
assert.throws(broken('settings', '設定,值,可選的值,說明', '同成分重複,黃,紅 黃 灰,'), /缺少「科別常用」/);

// The switch: on by default; the address turns it on or off for one page load.
assert.equal(rxCheckOn(''), true);
assert.equal(rxCheckOn('?rxcheck=1', false), true);
assert.equal(rxCheckOn('?rxcheck=0', true), false);
assert.equal(rxCheckOn('?other=1', true), true);

// 未同處方, 同類數 and 腎功能, and the 特材 the check knows by code.
{
  const more = compileRules(tables({ cautions: csv('編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據',
    'U01,A10A,,未同處方,=NAN02A1000ZZ,黃,測試提示針頭,', 'U02,N05BA N05AH N02A,,年齡+同類數,>=65;>=3 N05BA N05AH N02A,黃,測試提示數量,',
    'U03,A10BA,,腎功能,<30,黃,測試提示腎,', 'U04,A10BA,,腎功能,<50,灰,測試提示腎二,') }));
  const extra = new Map([...drugs, ['TESTINSU01', { atc: 'A10AE04', ingredients: 'INSULIN GLARGINE 100 U/ML' }]]);
  const notes = (rx: RxFacts) => checkPrescription(rx, extra, more).drugs.map(drug => `${drug.code} ${drug.notes.map(note => `${note.level} ${note.text}`).join('｜')}`);
  assert.deepEqual(notes(qr('E11.9', ['TESTINSU01'])), ['TESTINSU01 黃 U01 測試提示針頭（未見：胰島素注射針頭）']);
  assert.deepEqual(notes(qr('E11.9', ['TESTINSU01', 'NAN02A1000ZZ'])), ['TESTINSU01 ', 'NAN02A1000ZZ '], 'the needle is there');
  assert.deepEqual(verdicts(qr('E11.9', ['NAN02A1000ZZ']), more), ['低風險 特材（胰島素注射針頭），不與藥品或診斷衝突'], 'a needle alone clashes with nothing');
  // Three CNS drugs at 65 or older: one note, on the first of them; two are not enough, and an age that cannot be read is grey.
  assert.deepEqual(notes(qr('F41.9', ['TESTALPR01', 'TESTQUET01', 'TESTTRAM01'])),
    ['TESTALPR01 黃 U02 測試提示數量（AGE65-69；共 3 種：N05AH04 N02AX02）', 'TESTQUET01 ', 'TESTTRAM01 ']);
  assert.deepEqual(notes(qr('F41.9', ['TESTALPR01', 'TESTQUET01'])), ['TESTALPR01 ', 'TESTQUET01 ']);
  assert.deepEqual(notes(qr('F41.9', ['TESTALPR01', 'TESTQUET01', 'TESTTRAM01'], { 6: '1000101' })).filter(line => line.includes('U02')), [], 'under 65');
  // Kidney function from the CKD stage; a stage that straddles the threshold, or N18.9, cannot be judged.
  assert.deepEqual(notes(qr('E11.9#N18.4', ['TESTMETF01'])), ['TESTMETF01 黃 U03 測試提示腎（本次：N184，eGFR 15–29）｜灰 U04 測試提示腎二（本次：N184，eGFR 15–29）']);
  assert.deepEqual(notes(qr('E11.9#N18.31', ['TESTMETF01'])), ['TESTMETF01 灰 U04 腎功能無法判斷：N1831（eGFR 45–59）不能確定是否 <50，請確認 eGFR']);
  assert.deepEqual(notes(qr('E11.9#N18.32', ['TESTMETF01'])), ['TESTMETF01 灰 U04 測試提示腎二（本次：N1832，eGFR 30–44）']);
  assert.deepEqual(notes(qr('E11.9#N18.2', ['TESTMETF01'])), ['TESTMETF01 ']);
  assert.deepEqual(kidneyStage(['N189', 'N1832', 'I10']), { code: 'N1832', low: 30, high: 45 }, 'the worst stage');
  // Without a stage, the rough estimate from age and sex never comes near the thresholds: no note at any age.
  assert.deepEqual(notes(qr('E11.9', ['TESTMETF01'], { 6: '0100101' })), ['TESTMETF01 '], 'over 90');
  assert.equal(roughEgfr('AGE90+', 'M'), 79);
  assert.equal(roughEgfr('AGE70-79', 'F'), 88);
  assert.equal(roughEgfr('AGE10-19', 'M'), undefined);
  assert.deepEqual(kidneyBelow([], 'AGE90+', 'M', 80), { hit: undefined, why: '依年齡性別粗估 eGFR 約 79（假設肌酸酐正常），可能 <80，請確認腎功能' });
  assert.throws(() => compileRules(tables({ cautions: csv('編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'U09,A10A,,未同處方,=NAN,黃,x,') })), /不是健保碼/);
  assert.throws(() => compileRules(tables({ cautions: csv('編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'U09,A10A,,同類數,3 A10,黃,x,') })), /同類數寫成/);
  assert.throws(() => compileRules(tables({ cautions: csv('編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據', 'U09,A10A,,腎功能,>30,黃,x,') })), /腎功能條件寫成/);
}

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
