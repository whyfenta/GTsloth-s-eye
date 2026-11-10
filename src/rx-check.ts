/**
 * 處方警示: is each drug on a prescription explained by this visit's diagnoses (ICD-10-CM)? Pure functions: no DOM, no network.
 * The rules are the draft tables in docs/reference/rx-rules/, awaiting a pharmacist's review. The logic is the prototype
 * check_rules.py's, which tests/rx-check-samples.test.ts compares drug by drug against local samples.
 */
import { csvRows } from './csv';

export type Level = '紅' | '黃' | '灰';
/** An explained drug: by a diagnosis, by another drug on the prescription, by the department, or as a low-risk drug. */
export type Layer = '適應症' | '同處方' | '科別常用' | '低風險';
/** M or F from the ID number's second digit; '' when it is not 1 or 2 (other ID formats) or there is no ID. */
export type Sex = 'M' | 'F' | '';
/** What the check reads from a QR: diagnoses upper-cased without dots, the 2-character 就醫科別 or '', the age band and sex. Page memory only. */
export interface RxFacts { dx: string[]; dept: string; age: string; sex: Sex; drugs: { code: string; frequency: string; route: string }[] }
export interface DrugInfo { atc: string; ingredients: string }
export interface Note { level: Level; text: string }
/**
 * A drug's verdict and one-line reason, then the cautions it triggers. info is missing for a code outside the NHI drug list.
 * part: the prescription it is on, when one patient's prescriptions are checked together (0 for a single prescription).
 */
export interface DrugCheck { code: string; frequency: string; route: string; part: number; info?: DrugInfo; verdict: Layer | Level; reason: string; notes: Note[] }
/** notes: the prescription's own, a missing diagnosis first and repeated ingredients last. */
export interface RxCheck { drugs: DrugCheck[]; notes: Note[] }
/**
 * How a reason names diagnoses and other drugs: the prototype prints bare codes joined by spaces; the page adds names. atc gets
 * the other drug's ATC and its 健保碼. part names one prescription of a combined check (第 2 張), set before a diagnosis or drug
 * that comes from another prescription than the drug's own.
 */
export interface Labels { dx: (code: string) => string; atc: (atc: string, code: string) => string; join: string; part?: (index: number) => string }

/** 健保就醫科別 (TW Core IG, 健保署譯碼簿 2022/8/2): the codes the prototype names. */
export const DEPARTMENTS: Record<string, string> = { '00': '不分科', '01': '家醫科', '02': '內科', '03': '外科', '04': '兒科', '05': '婦產科',
  '06': '骨科', '07': '神經外科', '08': '泌尿科', '09': '耳鼻喉科', '10': '眼科', '11': '皮膚科', '12': '神經科', '13': '精神科', '14': '復健科',
  '15': '整形外科', '22': '急診醫學科', '2B': '洗腎科', AA: '消化內科', AB: '心臟血管內科', AC: '胸腔內科', AD: '腎臟內科', AE: '風濕免疫科',
  AF: '血液腫瘤科', AG: '內分泌科', AH: '感染科', AK: '老人醫學科', BB: '心臟血管外科' };

export const RULE_FILES = ['indications', 'co-drugs', 'cautions', 'specialty', 'drug-classes', 'settings'] as const;
export type RuleFile = typeof RULE_FILES[number];
/** Each CSV as rows keyed by its header, as published in public/assets/rx/rules.json. */
export type RuleTables = Record<RuleFile, Record<string, string>[]>;
const COLUMNS: Record<RuleFile, string[]> = {
  indications: ['ATC', '藥理類別', '可解釋的ICD-10', '依據', '備註'],
  'co-drugs': ['ATC', '可由同處方的ATC解釋', '依據', '備註'],
  cautions: ['編號', 'ATC', '成分關鍵字', '條件類型', '條件', '等級', '提示', '依據'],
  specialty: ['科別代碼', '科別', '該科常開的ATC'],
  'drug-classes': ['ATC', '類型', '說明'],
  settings: ['設定', '值', '可選的值', '說明'],
};
interface Indication { atc: string[]; dx: string[]; basis: string }
interface CoDrug { atc: string[]; partners: string[]; basis: string; note: string }
/** One condition of a caution; key is its type and written value, to tell when one caution has all of another's conditions. */
export type Condition = { key: string } & ({ kind: '診斷'; icd: string[] } | { kind: '年齡'; below: boolean; years: number } | { kind: '性別'; sex: 'M' | 'F' }
  | { kind: '同處方'; partners: { atc: string; frequency: string }[] }
  /** Holds when no other drug on the prescription is one of these: an ATC prefix, or an exact 健保碼 (a 特材 has no ATC). */
  | { kind: '未同處方'; partners: { atc: string; code: string }[] }
  /** Holds when at least min distinct drugs (this one included) have one of these ATCs; only the first of them carries the note. */
  | { kind: '同類數'; min: number; atc: string[] }
  /** Holds when kidney function is below this eGFR (mL/min/1.73 m²): from the CKD stage diagnosed, else a rough age and sex estimate. */
  | { kind: '腎功能'; below: number });
export interface Caution { id: string; atc: string[]; keyword: string; conditions: Condition[]; level: Level; message: string }
export interface Rules { indications: Indication[]; coDrugs: CoDrug[]; cautions: Caution[]; specialty: Map<string, string[]>; lowRisk: string[]; highAlert: string[];
  /** settings.csv: the level of a repeated ingredient, and whether the department layer explains a drug. */
  repeated: Level; byDepartment: boolean }

const LEVELS: Level[] = ['紅', '黃', '灰'];
/** Indications are tried label first, then guidelines, then common practice; another basis comes last. */
export const BASIS_RANK: Record<string, number> = { 仿單: 0, 指引: 1, 常見: 2, 常見仿單外: 3 };
const ATC = /^[A-Z](?:\d\d(?:[A-Z](?:[A-Z](?:\d\d)?)?)?)?$/;
const ICD = /^[A-Z]\d[0-9A-Z](?:\.?[0-9A-Z]{1,4})?$/;

export const normCode = (code: string) => code.replaceAll('.', '').trim().toUpperCase();
/** A rule's diagnosis: a prefix, or a range whose ends have the same length, low end first. */
function isIcd(token: string): boolean {
  const ends = token.split('-');
  if (ends.length > 2 || !ends.every(end => ICD.test(end))) return false;
  const [low, high = low] = ends.map(normCode);
  return low.length === high.length && low <= high;
}
const tokens = (value: string) => value.split(/\s+/).filter(Boolean);
export const atcHit = (atc: string, prefixes: string[]) => prefixes.some(prefix => atc.startsWith(prefix));
/** A token is a prefix (E11, N18.4) or a range (I10-I16) whose ends are compared at the low end's length. */
function icdHit(code: string, token: string): boolean {
  if (!token.includes('-')) return code.startsWith(normCode(token));
  const [low, high] = token.split('-').map(normCode);
  const part = code.slice(0, low.length);
  return low <= part && part <= high;
}
export const icdHits = (dx: string[], spec: string[]) => dx.filter(code => spec.some(token => icdHit(code, token)));
/** true or false; undefined when the band straddles n or there is no band. */
export function ageAtLeast(band: string, n: number): boolean | undefined {
  const match = /^AGE(\d+)(?:-(\d+)|\+)$/.exec(band);
  if (!match) return undefined;
  const low = Number(match[1]), high = match[2] ? Number(match[2]) : 200;
  return low >= n ? true : high < n ? false : undefined;
}

/**
 * 特材 the check knows by 健保碼: not in the NHI drug list, so they never explain or clash with a drug or a diagnosis, but a rule can
 * ask for one (未同處方). Every size of insulin pen needle is claimed under the one code.
 */
export const SUPPLIES: Record<string, string> = { NAN02A1000ZZ: '胰島素注射針頭' };

/** eGFR ranges (mL/min/1.73 m²) of the CKD stages ICD-10-CM codes; N18.9 is CKD of no stated stage, Z99.2 dialysis. */
const KIDNEY: [string, number, number][] = [['N181', 90, 999], ['N182', 60, 90], ['N1830', 30, 60], ['N1831', 45, 60], ['N1832', 30, 45],
  ['N183', 30, 60], ['N184', 15, 30], ['N185', 0, 15], ['N186', 0, 15], ['N189', 0, 90], ['Z992', 0, 15]];
/** The worst CKD stage diagnosed, as the code and its eGFR range; undefined when there is none. */
export function kidneyStage(dx: string[]): { code: string; low: number; high: number } | undefined {
  let worst: { code: string; low: number; high: number } | undefined;
  for (const code of dx) {
    const stage = KIDNEY.find(([prefix]) => code.startsWith(prefix));
    if (stage && (!worst || stage[2] < worst.high || (stage[2] === worst.high && stage[1] < worst.low))) worst = { code, low: stage[1], high: stage[2] };
  }
  return worst;
}
/**
 * A rough eGFR from the age band and sex alone: CKD-EPI 2021 with serum creatinine at the equation's reference (0.7 mg/dL for
 * women, 0.9 for men), so 142 × 0.9938^age (× 1.012 for women), at the band's oldest age (95 for 90+); a man's when the sex is
 * unknown, which is lower. It is what age alone predicts for a normal creatinine, never a measurement: at 95 it is still about 78,
 * so it never reaches the thresholds the cautions use. undefined under 18 or without a band.
 */
export function roughEgfr(band: string, sex: Sex): number | undefined {
  const match = /^AGE(\d+)(?:-(\d+)|\+)$/.exec(band);
  if (!match || Number(match[1]) < 18) return undefined;
  const age = match[2] ? Number(match[2]) : Number(match[1]) + 5;
  return Math.round(142 * 0.9938 ** age * (sex === 'F' ? 1.012 : 1));
}
/** Kidney function below this eGFR: a stage's range decides, or cannot (undefined, with why); without a stage, the rough estimate can only raise a question. */
export function kidneyBelow(dx: string[], band: string, sex: Sex, below: number): { hit: boolean | undefined; code?: string; range?: string; why?: string } {
  const stage = kidneyStage(dx);
  if (stage) {
    const range = stage.high >= 999 ? `≥${stage.low}` : `${stage.low}–${stage.high - 1}`;
    if (stage.high <= below) return { hit: true, code: stage.code, range };
    if (stage.low >= below) return { hit: false };
    return { hit: undefined, code: stage.code, range, why: `腎功能無法判斷：${stage.code}（eGFR ${range}）不能確定是否 <${below}，請確認 eGFR` };
  }
  const estimate = roughEgfr(band, sex);
  if (estimate === undefined || estimate >= below) return { hit: false };
  return { hit: undefined, why: `依年齡性別粗估 eGFR 約 ${estimate}（假設肌酸酐正常），可能 <${below}，請確認腎功能` };
}

// Python's \b and \d are Unicode-aware; these keep the same word boundaries for the prototype's expressions.
const W = '[\\p{L}\\p{N}_]';
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const STRENGTH = new RegExp(`\\s+[\\p{Nd}.]+\\s*(?:MG|MCG|G|ML|IU|U|%)${B}`, 'u');
const SALT = new RegExp(`${B}(?:HCL|HYDROCHLORIDE|SODIUM|CALCIUM|POTASSIUM|MAGNESIUM|BESYLATE|MALEATE|MESYLATE|TARTRATE|SUCCINATE|FUMARATE|CITRATE|SULFATE|ACETATE|BROMIDE|PHOSPHATE|(?:DI|MONO|HEMI)?HYDRATE)${B}`, 'gu');
/** Ingredient names without strength, brackets or salt: INSULIN GLARGINE and INSULIN ASPART stay two ingredients. */
export function ingredientBases(text: string): string[] {
  return text.toUpperCase().split('+').flatMap(part => {
    const end = part.search(STRENGTH);
    const name = (end < 0 ? part : part.slice(0, end)).replace(/[(（][^)）]*[)）]/g, '').replace(SALT, '');
    const base = name.split(/\s+/).filter(Boolean).join(' ');
    return base ? [base] : [];
  });
}

/** A CSV with a header row as rows keyed by it. */
export function ruleTable(text: string): Record<string, string>[] {
  const [header = [], ...rows] = csvRows(text.replace(/^﻿/, ''));
  return rows.map(row => Object.fromEntries(header.map((name, i) => [name, row[i]])));
}
/** Checks every table and turns it into rules; an error names the file, the row (as numbered in a spreadsheet) and the column. */
export function compileRules(tables: RuleTables): Rules {
  const read = <T>(file: RuleFile, map: (cell: (column: string) => string, fail: (column: string, why: string) => never) => T): T[] => {
    const rows = tables[file];
    if (!Array.isArray(rows) || !rows.length) throw new Error(`${file}.csv 沒有資料列。`);
    return rows.map((row, i) => {
      const fail = (column: string, why: string): never => { throw new Error(`${file}.csv 第 ${i + 2} 列「${column}」：${why}`); };
      for (const column of COLUMNS[file]) if (typeof row[column] !== 'string') fail(column, '缺少此欄。');
      if (Object.keys(row).length !== COLUMNS[file].length) fail(Object.keys(row).find(column => !COLUMNS[file].includes(column)) ?? '', '多出此欄。');
      return map(column => row[column], fail);
    });
  };
  const list = (value: string, kind: 'ATC' | 'ICD', fail: (why: string) => never, empty = false) => {
    const values = tokens(value);
    if (!values.length && !empty) fail('不能空白。');
    for (const token of values) {
      if (kind === 'ATC' ? ATC.test(token) : isIcd(token)) continue;
      fail(kind === 'ATC' ? `「${token}」不是 ATC 前綴，寫成 C、C10、C10AA、C10AA05 這樣。`
        : `「${token}」不是 ICD-10-CM 前綴或範圍，寫成 E11、N18.4 或 I10-I16 這樣（範圍兩端的碼長相同，前小後大）。`);
    }
    return values;
  };
  const level = (value: string, fail: (why: string) => never) => LEVELS.includes(value as Level) ? value as Level : fail('要是紅、黃或灰。');

  const indications = read('indications', (cell, fail) => ({
    atc: list(cell('ATC'), 'ATC', why => fail('ATC', why)), dx: list(cell('可解釋的ICD-10'), 'ICD', why => fail('可解釋的ICD-10', why)), basis: cell('依據') }));
  // Stable, as Python's sorted(): rows with the same basis keep the file's order.
  indications.sort((a, b) => (BASIS_RANK[a.basis] ?? 9) - (BASIS_RANK[b.basis] ?? 9));
  const coDrugs = read('co-drugs', (cell, fail) => ({ atc: list(cell('ATC'), 'ATC', why => fail('ATC', why)),
    partners: list(cell('可由同處方的ATC解釋'), 'ATC', why => fail('可由同處方的ATC解釋', why)), basis: cell('依據'), note: cell('備註') }));
  const cautions = read('cautions', (cell, fail): Caution => {
    const atc = list(cell('ATC'), 'ATC', why => fail('ATC', why), true);
    const keyword = cell('成分關鍵字');
    if (!/^[A-Z0-9 -]*$/.test(keyword) || keyword !== keyword.trim()) fail('成分關鍵字', '只能是大寫英文、數字與空格，前後不留空白。');
    if (!atc.length && !keyword) fail('ATC', 'ATC 與成分關鍵字至少要填一個。');
    // Several conditions must all hold: 條件類型 年齡+同處方 with 條件 >=65;G04CA, one ;-separated part per type.
    const kinds = cell('條件類型').split('+').map(kind => kind.trim()), parts = cell('條件').split(';').map(part => part.trim());
    if (new Set(kinds).size < kinds.length) fail('條件類型', '同一種條件只能寫一次。');
    if (parts.length !== kinds.length) fail('條件', `要有 ${kinds.length} 段，以 ; 分隔，順序和條件類型相同。`);
    const conditions = kinds.map((kind, i): Condition => {
      const part = parts[i], key = `${kind}:${tokens(part).join(' ')}`, bad = (why: string) => fail('條件', why);
      if (kind === '診斷') return { key, kind, icd: list(part, 'ICD', bad) };
      if (kind === '年齡') {
        const match = /^(>=|<)(\d+)$/.exec(part);
        return match ? { key, kind, below: match[1] === '<', years: Number(match[2]) } : bad('年齡條件寫成 >=65 或 <50 這樣。');
      }
      if (kind === '性別') return part === '男' || part === '女' ? { key, kind, sex: part === '男' ? 'M' : 'F' } : bad('性別條件寫成男或女。');
      if (kind === '同處方') {
        if (!tokens(part).length) bad('不能空白。');
        // ATC@HS: that drug counts only when its frequency contains HS (HS, QHS, HSPRN …).
        return { key, kind, partners: tokens(part).map(token => {
          const [atc, frequency = '', extra] = token.split('@');
          if (extra !== undefined || !ATC.test(atc) || (token.includes('@') && !/^[A-Z]+$/.test(frequency))) bad(`「${token}」不是 ATC 前綴，寫成 C08、C08CA01，或 C08@HS（這個藥的頻率含 HS 才算）這樣。`);
          return { atc, frequency };
        }) };
      }
      if (kind === '未同處方') {
        if (!tokens(part).length) bad('不能空白。');
        // =NAN02A1000ZZ: that exact 健保碼, for a 特材 without an ATC.
        return { key, kind, partners: tokens(part).map(token => {
          if (token.startsWith('=')) return /^=[0-9A-Z]{10,12}$/.test(token) ? { atc: '', code: token.slice(1) } : bad(`「${token}」不是健保碼，寫成 =NAN02A1000ZZ 這樣。`);
          return ATC.test(token) ? { atc: token, code: '' } : bad(`「${token}」不是 ATC 前綴或 =健保碼。`);
        }) };
      }
      if (kind === '同類數') {
        const [count = '', ...atcs] = tokens(part), match = /^>=(\d+)$/.exec(count);
        if (!match || Number(match[1]) < 2) bad('同類數寫成 >=3 N05A N05B 這樣：先寫至少幾種（2 以上），再寫算在內的 ATC。');
        return { key, kind, min: Number(match![1]), atc: list(atcs.join(' '), 'ATC', bad) };
      }
      if (kind === '腎功能') {
        const match = /^<(\d+)$/.exec(part);
        return match ? { key, kind, below: Number(match[1]) } : bad('腎功能條件寫成 <30 這樣（eGFR，mL/min/1.73 m²）。');
      }
      return fail('條件類型', '要是診斷、年齡、性別、同處方、未同處方、同類數或腎功能，多種條件以 + 連接。');
    });
    return { id: cell('編號'), atc, keyword, conditions, level: level(cell('等級'), why => fail('等級', why)), message: cell('提示') };
  });
  const specialty = new Map<string, string[]>();
  read('specialty', (cell, fail) => {
    const code = cell('科別代碼');
    if (!/^[0-9A-Z]{2}$/.test(code)) fail('科別代碼', '要是 2 碼健保就醫科別。');
    if (specialty.has(code)) fail('科別代碼', `${code} 重複。`);
    specialty.set(code, list(cell('該科常開的ATC'), 'ATC', why => fail('該科常開的ATC', why)));
  });
  const classes = read('drug-classes', (cell, fail) => ({ atc: list(cell('ATC'), 'ATC', why => fail('ATC', why)),
    kind: ['低風險', '高警訊'].includes(cell('類型')) ? cell('類型') : fail('類型', '要是低風險或高警訊。') }));
  const settings = new Map(read('settings', (cell, fail) => {
    const choices = tokens(cell('可選的值'));
    if (!choices.includes(cell('值'))) fail('值', `要是 ${choices.join('、')} 之一。`);
    return [cell('設定'), cell('值')] as const;
  }));
  const setting = (name: string, choices: string[]) => {
    const value = settings.get(name);
    if (!value || !choices.includes(value)) throw new Error(`settings.csv 缺少「${name}」，或值不是 ${choices.join('、')} 之一。`);
    return value;
  };
  return { indications, coDrugs, cautions, specialty, lowRisk: classes.filter(c => c.kind === '低風險').flatMap(c => c.atc),
    highAlert: classes.filter(c => c.kind === '高警訊').flatMap(c => c.atc), repeated: setting('同成分重複', LEVELS) as Level,
    byDepartment: setting('科別常用', ['保留', '停用']) === '保留' };
}

const PLAIN: Labels = { dx: code => code, atc: atc => atc, join: ' ' };
/** A caution with all of another's conditions and more, for the same drugs (C17 is C09 plus another drug), replaces it. */
const covers = (wide: Caution, narrow: Caution) => wide.conditions.length > narrow.conditions.length && wide.keyword === narrow.keyword
  && wide.atc.join(' ') === narrow.atc.join(' ') && narrow.conditions.every(c => wide.conditions.some(d => d.key === c.key));
/**
 * Each drug in turn, stopping at the first layer that explains it: an indication for one of the diagnoses, another drug on the
 * prescription, a drug the department often prescribes, a low-risk drug. Otherwise a high-alert drug is yellow, any other grey.
 * Cautions (diagnosis, age, sex, another drug) are checked whatever the verdict; a code outside the NHI drug list is low risk.
 */
export function checkPrescription(rx: RxFacts, drugs: Map<string, DrugInfo>, rules: Rules, labels: Labels = PLAIN): RxCheck {
  return checkPrescriptions([rx], drugs, rules, labels);
}
/**
 * One patient's prescriptions checked as one (several departments handed in together), as checkPrescription checks one: every
 * prescription's diagnoses can explain a drug or rule it out, a drug on one prescription can explain or interact with a drug on
 * another, and an ingredient on two prescriptions is repeated, even under the same 健保碼 (on one prescription a repeated code
 * is the same drug at two times of day; on two it is the drug given twice). Each drug keeps its own prescription's department.
 * A reason that leans on another prescription's diagnosis or drug names that prescription (labels.part). The age band and sex are
 * the first prescription's that has them. One prescription is checked exactly as the prototype checks it.
 */
export function checkPrescriptions(parts: RxFacts[], drugs: Map<string, DrugInfo>, rules: Rules, labels: Labels = PLAIN): RxCheck {
  const many = parts.length > 1, partName = labels.part ?? ((index: number) => `第 ${index + 1} 張`);
  // The prescriptions each diagnosis and each code is on.
  const dxFrom = new Map<string, number[]>(), codeFrom = new Map<string, number[]>();
  const from = (map: Map<string, number[]>, key: string, index: number) => { const list = map.get(key) ?? []; if (!list.includes(index)) map.set(key, [...list, index]); };
  parts.forEach((part, index) => { for (const code of part.dx) from(dxFrom, code, index); for (const { code } of part.drugs) from(codeFrom, code, index); });
  const dx = many ? [...dxFrom.keys()] : parts[0]?.dx ?? [];
  const age = parts.find(part => part.age)?.age ?? '', sex = parts.find(part => part.sex)?.sex ?? '';
  /** 第 2 張 before what is not on the drug's own prescription; nothing for a single prescription. */
  const elsewhere = (on: number[], part: number) => many && !on.includes(part) ? `${on.map(partName).join('、')} ` : '';
  const list = parts.flatMap((rx, part) => rx.drugs.map(drug => ({ ...drug, part, dept: rx.dept })));
  // One ATC per distinct code: the same code twice does not explain itself. A code keeps every frequency it is given at.
  const atcs = new Map<string, string>(), frequencies = new Map<string, string[]>();
  for (const { code, frequency } of list) {
    const info = drugs.get(code);
    if (info && !atcs.has(code)) atcs.set(code, info.atc);
    frequencies.set(code, [...frequencies.get(code) ?? [], frequency]);
  }
  const notes: Note[] = dx.length ? [] : [{ level: '灰', text: `${many ? '各張處方都' : '處方'}沒有診斷碼，無法解釋的藥不另提示` }];
  const checked = list.map(({ code, frequency, route, part, dept }): DrugCheck => {
    const info = drugs.get(code);
    if (!info) return { code, frequency, route, part, verdict: '低風險',
      reason: SUPPLIES[code] ? `特材（${SUPPLIES[code]}），不與藥品或診斷衝突` : '不在健保用藥品項（可能是特材）', notes: [] };
    const { atc } = info;
    const others = [...atcs].filter(([other]) => other !== code);
    const dxText = (codes: string[]) => codes.map(hit => `${elsewhere(dxFrom.get(hit)!, part)}${labels.dx(hit)}`).join(labels.join);
    const drugText = ([other, value]: [string, string]) => `${elsewhere(codeFrom.get(other)!, part)}${labels.atc(value, other)}`;
    // Another drug on the drug's own prescription is 同處方; one only on another prescription is named by that prescription.
    const onOwn = ([other]: [string, string]) => codeFrom.get(other)!.includes(part);
    const verdict = (): Pick<DrugCheck, 'verdict' | 'reason'> => {
      for (const rule of rules.indications) {
        if (!atcHit(atc, rule.atc)) continue;
        const hits = icdHits(dx, rule.dx);
        if (hits.length) return { verdict: '適應症', reason: `${dxText(hits)}（${rule.basis}）` };
      }
      for (const rule of rules.coDrugs) {
        if (!atcHit(atc, rule.atc)) continue;
        // A partner on the drug's own prescription first.
        const partners = others.filter(([, other]) => atcHit(other, rule.partners));
        const partner = partners.find(onOwn) ?? partners[0];
        if (partner) return { verdict: '同處方', reason: `${onOwn(partner) ? '同處方 ' : ''}${drugText(partner)}：${rule.note}（${rule.basis}）` };
      }
      const usual = rules.specialty.get(dept);
      if (rules.byDepartment && usual && atcHit(atc, usual)) return { verdict: '科別常用', reason: `本次診斷無對應，${DEPARTMENTS[dept] ?? dept}常開` };
      if (atcHit(atc, rules.lowRisk)) return { verdict: '低風險', reason: '本次診斷無對應，低風險藥不提示' };
      if (atcHit(atc, rules.highAlert) && dx.length) return { verdict: '黃', reason: '高警訊藥，本次診斷與科別都無法解釋' };
      return { verdict: '灰', reason: dx.length ? '本次診斷與科別都無法解釋（預設收合）' : '處方沒有診斷碼' };
    };
    // Each condition holds, fails, or cannot be judged (undefined, with why); details join in the note's brackets.
    const judge = (condition: Condition): { hit: boolean | undefined; detail: string; why?: string } => {
      switch (condition.kind) {
        case '診斷': { const hits = icdHits(dx, condition.icd); return { hit: hits.length > 0, detail: `本次：${dxText(hits)}` }; }
        case '年齡': {
          const atLeast = ageAtLeast(age, condition.years);
          // A band that straddles the threshold says so; no band, or a birth date in an unknown format (AGE?…), cannot be read.
          return { hit: atLeast === undefined ? undefined : atLeast !== condition.below, detail: age,
            why: /^AGE\d/.test(age) ? `無法判斷：${age} 跨過 ${condition.years} 歲` : '無法讀取年齡' };
        }
        case '性別': return { hit: sex ? sex === condition.sex : undefined, detail: sex === 'F' ? '女性' : '男性', why: '無法取得性別資料' };
        case '同處方': {
          const hits = others.filter(([other, value]) => condition.partners.some(partner => value.startsWith(partner.atc)
            && (!partner.frequency || frequencies.get(other)!.some(frequency => frequency.includes(partner.frequency)))));
          return { hit: hits.length > 0, detail: `${hits.every(onOwn) ? '同處方' : '併用'}：${hits.map(drugText).join(labels.join)}` };
        }
        case '未同處方': {
          const present = condition.partners.some(partner => partner.code ? codeFrom.has(partner.code) && partner.code !== code
            : others.some(([, value]) => value.startsWith(partner.atc)));
          const names = condition.partners.map(partner => partner.code ? SUPPLIES[partner.code] ?? partner.code : partner.atc);
          return { hit: !present, detail: `未見：${names.join(labels.join)}` };
        }
        case '同類數': {
          const counted = [...atcs].filter(([, value]) => atcHit(value, condition.atc));
          // Once per prescription: on the first drug counted, the others named after it.
          const first = counted[0]?.[0] === code;
          return { hit: first && counted.length >= condition.min,
            detail: `共 ${counted.length} 種：${counted.filter(([other]) => other !== code).map(drugText).join(labels.join)}` };
        }
        case '腎功能': {
          const result = kidneyBelow(dx, age, sex, condition.below);
          return { hit: result.hit, detail: result.code ? `本次：${dxText([result.code])}，eGFR ${result.range}` : '', why: result.why };
        }
      }
    };
    const fired: { caution: Caution; note: Note }[] = [];
    const ingredients = info.ingredients.toUpperCase();
    for (const caution of rules.cautions) {
      if (!(atcHit(atc, caution.atc) || (caution.keyword && ingredients.includes(caution.keyword)))) continue;
      const outcomes = caution.conditions.map(judge);
      if (outcomes.some(outcome => outcome.hit === false)) continue;
      const unknown = outcomes.find(outcome => outcome.hit === undefined);
      fired.push({ caution, note: unknown ? { level: '灰', text: `${caution.id} ${unknown.why}` }
        : { level: caution.level, text: `${caution.id} ${caution.message}（${outcomes.map(outcome => outcome.detail).join('；')}）` } });
    }
    const cautions = fired.filter(({ caution }) => !fired.some(other => covers(other.caution, caution))).map(({ note }) => note);
    return { code, frequency, route, part, info, ...verdict(), notes: cautions };
  });
  // Each distinct code on a prescription counts an ingredient once, so a code repeated on one prescription is not a repeated
  // ingredient; the same code on two prescriptions is. A combined check names the prescriptions.
  const seen = new Map<string, number[]>();
  parts.forEach((rx, part) => {
    for (const code of new Set(rx.drugs.map(drug => drug.code))) {
      const info = drugs.get(code);
      if (info) for (const base of new Set(ingredientBases(info.ingredients))) seen.set(base, [...seen.get(base) ?? [], part]);
    }
  });
  for (const [base, on] of seen) {
    if (on.length > 1) notes.push({ level: rules.repeated, text: `同成分重複：${base} 出現在 ${on.length} 個品項${many ? `（${[...new Set(on)].map(partName).join('、')}）` : ''}` });
  }
  return { drugs: checked, notes };
}

export interface IcdEntry { name: string; deleted: boolean }
/** ICD-10-CM puts the dot after the third character. */
export const icdDisplay = (code: string) => code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code;
/**
 * A diagnosis as the code shown and its Chinese name with any note, for a list that puts codes and names in their own columns.
 * I2510 → I25.10; a code not in the table falls back to its category, and says so; an unknown code stays as written.
 */
export function dxParts(code: string, icd: Map<string, IcdEntry>): { code: string; name: string; found: boolean } {
  for (let n = code.length; n > 2; n--) {
    const entry = icd.get(code.slice(0, n));
    if (!entry) continue;
    const note = entry.deleted ? '（舊碼，2014 版已刪除）' : n === code.length ? '' : `（查無 ${code}，此為類別）`;
    return { code: icdDisplay(code.slice(0, n)), name: `${entry.name}${note}`, found: true };
  }
  return { code, name: '（查無此碼）', found: false };
}
/** The diagnosis on one line: I25.10 and its Chinese name. */
export function dxLabel(code: string, icd: Map<string, IcdEntry>): string {
  const parts = dxParts(code, icd);
  return parts.found ? `${parts.code} ${parts.name}` : `${parts.code}${parts.name}`;
}
