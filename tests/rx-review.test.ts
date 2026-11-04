import assert from 'node:assert/strict';
import { compileRules, ruleTable, type DrugInfo, type IcdEntry, type RuleTables } from '../src/rx-check';
import type { RxData } from '../src/rx-data';
import { componentAtcs, componentIndex, describeSample, ruleCoverage } from '../src/rx-review';

// Synthetic sample lines, drug codes and rule tables only; the ATC and ICD-10-CM codes are the public classifications.
const csv = (header: string, ...rows: string[]) => ruleTable([header, ...rows].join('\n'));
const tables: RuleTables = {
  indications: csv('ATC,藥理類別,可解釋的ICD-10,依據,備註', 'A10,測試類別,E08-E13,仿單,', 'C09 C03,測試類別,I10-I16,仿單,'),
  'co-drugs': csv('ATC,可由同處方的ATC解釋,依據,備註', 'A02BC,B01AC,常見,胃腸保護'),
  cautions: csv('編號,ATC,成分關鍵字,條件類型,條件,等級,提示,依據',
    'T01,A10BK,,年齡+同處方,>=65;C03,灰,測試提示甲,', 'T02,C07AA,,診斷,J45,紅,測試提示乙,', 'T03,N05BA,,診斷,F03,黃,測試提示丙,',
    'T04,N05BA,,年齡,>=65,灰,測試提示丁,'),
  specialty: csv('科別代碼,科別,該科常開的ATC', 'AB,心臟血管內科,C10'),
  'drug-classes': csv('ATC,類型,說明', 'A06,低風險,'),
  settings: csv('設定,值,可選的值,說明', '同成分重複,黃,紅 黃 灰,', '科別常用,保留,保留 停用,'),
};
const single = (prefix: string, atc: string, ingredients: string, n = 3) => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, { atc, ingredients }] as const);
const drugs = new Map<string, DrugInfo>([
  ...single('TESTHCTZ0', 'C03AA03', 'HYDROCHLOROTHIAZIDE 25 MG'), ['TESTHCTZ9', { atc: 'C03EA01', ingredients: 'HYDROCHLOROTHIAZIDE 25 MG' }],
  ...single('TESTAMLO0', 'C08CA01', 'AMLODIPINE BESYLATE 5 MG'), ...single('TESTOLME0', 'C09CA08', 'OLMESARTAN MEDOXOMIL 20 MG'),
  ...single('TESTTIME0', 'S01ED01', 'TIMOLOL MALEATE 0.5 %'), ...single('TESTTIMO0', 'C07AA06', 'TIMOLOL MALEATE 10 MG'),
  ...single('TESTCHLO0', 'N05BA02', 'CHLORDIAZEPOXIDE HCL 10 MG'), ...single('TESTDICY0', 'A03AA07', 'DICYCLOMINE HCL 10 MG'),
  ['TESTEMPA01', { atc: 'A10BK03', ingredients: 'EMPAGLIFLOZIN 25 MG' }],
  ['TESTTRIP01', { atc: 'C09DX03', ingredients: 'OLMESARTAN MEDOXOMIL 40 MG+AMLODIPINE BESYLATE 5 MG+HYDROCHLOROTHIAZIDE 12.5 MG' }],
  ['TESTEYEC01', { atc: 'S01ED51', ingredients: 'TIMOLOL MALEATE 0.5 %+DORZOLAMIDE HCL 2 %' }],
  ['TESTGAST01', { atc: 'A02AG', ingredients: 'DICYCLOMINE HCL 2 MG+CHLORDIAZEPOXIDE HCL 5 MG+MAGNESIUM OXIDE 40 MG' }],
]);
const icd = new Map<string, IcdEntry>([['E119', { name: '第二型糖尿病，未伴有併發症', deleted: false }], ['I10', { name: '本態性高血壓', deleted: false }]]);
const data: RxData = { rules: compileRules(tables), drugs, icd, drugDate: '', icdVersion: '', rulesVersion: '' };
// A sample line as the collector writes it: no name or ID, SEXM／SEXF in field 5, the age band in field 6.
const line = (dx: string, codes: string[], age = 'AGE70-79', dept = 'AG') => ['0000000000', '2', '', '', 'SEXM', age, dept, '1151020', '', '28', '', dx, '', '',
  ...codes.flatMap(code => [code, '1', 'BID', 'PO', '56'])].join(';') + ';';

// A combination product's ingredients take the ATC of their single-ingredient products; one filed under an ATC fewer than 3 times
// does not count, and an ingredient with ATC codes in the combination's own anatomical group takes those (an eye drop's timolol).
const index = componentIndex(drugs);
assert.deepEqual(componentAtcs(drugs.get('TESTTRIP01')!, index), ['C09CA08', 'C08CA01', 'C03AA03']);
assert.deepEqual(componentAtcs(drugs.get('TESTEYEC01')!, index), ['S01ED01']);
assert.deepEqual(componentAtcs(drugs.get('TESTGAST01')!, index), ['A03AA07', 'N05BA02'], 'chlordiazepoxide has no A group code, so all of its codes');
assert.deepEqual(componentAtcs(drugs.get('TESTEMPA01')!, index), [], 'a single ingredient');

// Coverage: fired, the drug side, each condition, and what combination products hide.
const lines = [
  line('E11.9#I10', ['TESTEMPA01', 'TESTTRIP01']), // T01 misses the thiazide inside the triple combination.
  line('E11.9#I10', ['TESTEMPA01', 'TESTHCTZ00']), // T01 fires.
  line('J45.909', ['TESTEYEC01']), // An eye drop's timolol is not the C07AA of T02.
  line('K30#F03.90', ['TESTGAST01']), // T03 and T04 miss the chlordiazepoxide inside the gastric combination.
  line('E11.9', ['TESTEMPA01', 'TESTTRIP01'], 'AGE60-64'), // Too young for T01 either way.
];
const coverage = Object.fromEntries(ruleCoverage(lines, data).map(row => [row.id, row]));
assert.deepEqual(coverage.T01, { id: 'T01', level: '灰', fired: 1, drug: 3, drugCombo: 0,
  conditions: [{ label: '年齡>=65', holds: 4, combo: 0 }, { label: '同處方', holds: 1, combo: 2 }], comboMisses: [0] });
assert.deepEqual(coverage.T02, { id: 'T02', level: '紅', fired: 0, drug: 0, drugCombo: 0, conditions: [{ label: '診斷', holds: 1, combo: 0 }], comboMisses: [] });
assert.deepEqual([coverage.T03.drugCombo, coverage.T03.comboMisses, coverage.T04.drugCombo, coverage.T04.comboMisses], [1, [3], 1, [3]]);

// One sample for a person to read: names, ATC and ingredients, a daily count from the total and days, then the rules' say.
assert.deepEqual(describeSample(lines[0], data), [
  '無提示｜院所 0000000000｜AG 內分泌科｜AGE70-79｜男｜28 天',
  '  診斷：E11.9 第二型糖尿病，未伴有併發症；I10 本態性高血壓',
  '  藥：TESTEMPA01 A10BK03 EMPAGLIFLOZIN 25 MG｜1 BID PO｜總量 56，每日約 2',
  '  藥：TESTTRIP01 C09DX03 OLMESARTAN MEDOXOMIL 40 MG+AMLODIPINE BESYLATE 5 MG+HYDROCHLOROTHIAZIDE 12.5 MG｜1 BID PO｜總量 56，每日約 2',
]);
assert.deepEqual(describeSample(line('', ['TESTNONE01'], '', '146'), data).slice(0, 3),
  ['灰｜院所 0000000000｜科別未知（146）｜年齡不明｜男｜28 天', '  診斷：（無）', '  藥：TESTNONE01 （不在健保用藥品項）｜1 BID PO｜總量 56，每日約 2']);
console.log('rx review coverage, combination ingredients and sample detail passed');
