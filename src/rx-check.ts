/**
 * 處方警示: is each drug on a prescription explained by this visit's diagnoses (ICD-10-CM)? Pure functions: no DOM, no network.
 * The rules are the draft tables in docs/reference/rx-rules/, awaiting a pharmacist's review. The logic is the prototype
 * check_rules.py's, which tests/rx-check-samples.test.ts compares drug by drug against local samples.
 */
import { csvRows } from './csv';

export type Level = '紅' | '黃' | '灰';
/** An explained drug: by a diagnosis, by another drug on the prescription, by the department, or as a low-risk drug. */
export type Layer = '適應症' | '同處方' | '科別常用' | '低風險';
/** What the check reads from a QR: diagnoses upper-cased without dots, the 2-character 就醫科別 or '', and the age band. Page memory only. */
export interface RxFacts { dx: string[]; dept: string; age: string; drugs: { code: string; frequency: string; route: string }[] }
export interface DrugInfo { atc: string; ingredients: string }
export interface Note { level: Level; text: string }
/** A drug's verdict and one-line reason, then the cautions it triggers. info is missing for a code outside the NHI drug list. */
export interface DrugCheck { code: string; frequency: string; route: string; info?: DrugInfo; verdict: Layer | Level; reason: string; notes: Note[] }
/** notes: the prescription's own, a missing diagnosis first and repeated ingredients last. */
export interface RxCheck { drugs: DrugCheck[]; notes: Note[] }
/** How a reason names diagnoses: the prototype prints bare codes joined by spaces; the page adds the Chinese name. */
export interface Labels { dx: (code: string) => string; join: string }

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
interface Caution { id: string; atc: string[]; keyword: string; kind: '診斷' | '年齡' | '同處方'; condition: string[]; level: Level; message: string }
export interface Rules { indications: Indication[]; coDrugs: CoDrug[]; cautions: Caution[]; specialty: Map<string, string[]>; lowRisk: string[]; highAlert: string[];
  /** settings.csv: the level of a repeated ingredient, and whether the department layer explains a drug. */
  repeated: Level; byDepartment: boolean }

const LEVELS: Level[] = ['紅', '黃', '灰'];
/** Indications are tried label first, then guidelines, then common practice; another basis comes last. */
const BASIS_RANK: Record<string, number> = { 仿單: 0, 指引: 1, 常見: 2, 常見仿單外: 3 };
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
const atcHit = (atc: string, prefixes: string[]) => prefixes.some(prefix => atc.startsWith(prefix));
/** A token is a prefix (E11, N18.4) or a range (I10-I16) whose ends are compared at the low end's length. */
function icdHit(code: string, token: string): boolean {
  if (!token.includes('-')) return code.startsWith(normCode(token));
  const [low, high] = token.split('-').map(normCode);
  const part = code.slice(0, low.length);
  return low <= part && part <= high;
}
const icdHits = (dx: string[], spec: string[]) => dx.filter(code => spec.some(token => icdHit(code, token)));
/** true or false; undefined when the band straddles n or there is no band. */
function ageAtLeast(band: string, n: number): boolean | undefined {
  const match = /^AGE(\d+)(?:-(\d+)|\+)$/.exec(band);
  if (!match) return undefined;
  const low = Number(match[1]), high = match[2] ? Number(match[2]) : 200;
  return low >= n ? true : high < n ? false : undefined;
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
    const kind = cell('條件類型');
    const atc = list(cell('ATC'), 'ATC', why => fail('ATC', why), true);
    const keyword = cell('成分關鍵字');
    if (!/^[A-Z0-9 -]*$/.test(keyword) || keyword !== keyword.trim()) fail('成分關鍵字', '只能是大寫英文、數字與空格，前後不留空白。');
    if (!atc.length && !keyword) fail('ATC', 'ATC 與成分關鍵字至少要填一個。');
    const condition = kind === '診斷' ? list(cell('條件'), 'ICD', why => fail('條件', why))
      : kind === '同處方' ? list(cell('條件'), 'ATC', why => fail('條件', why))
      : kind === '年齡' ? /^>=\d+$/.test(cell('條件')) ? [cell('條件').slice(2)] : fail('條件', '年齡條件寫成 >=65 這樣。')
      : fail('條件類型', '要是診斷、年齡或同處方。');
    return { id: cell('編號'), atc, keyword, kind: kind as Caution['kind'], condition, level: level(cell('等級'), why => fail('等級', why)), message: cell('提示') };
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

const PLAIN: Labels = { dx: code => code, join: ' ' };
/**
 * Each drug in turn, stopping at the first layer that explains it: an indication for one of the diagnoses, another drug on the
 * prescription, a drug the department often prescribes, a low-risk drug. Otherwise a high-alert drug is yellow, any other grey.
 * Cautions (diagnosis, age, another drug) are checked whatever the verdict; a code outside the NHI drug list is low risk.
 */
export function checkPrescription(rx: RxFacts, drugs: Map<string, DrugInfo>, rules: Rules, labels: Labels = PLAIN): RxCheck {
  const { dx, dept, age } = rx;
  const dxText = (codes: string[]) => codes.map(labels.dx).join(labels.join);
  // One ATC per distinct code: the same code twice on a prescription does not explain itself.
  const atcs = new Map<string, string>();
  for (const { code } of rx.drugs) { const info = drugs.get(code); if (info && !atcs.has(code)) atcs.set(code, info.atc); }
  const notes: Note[] = dx.length ? [] : [{ level: '灰', text: '處方沒有診斷碼，無法解釋的藥不另提示' }];
  const checked = rx.drugs.map(({ code, frequency, route }): DrugCheck => {
    const info = drugs.get(code);
    if (!info) return { code, frequency, route, verdict: '低風險', reason: '不在健保用藥品項（可能是特材）', notes: [] };
    const { atc } = info;
    const others = [...atcs].filter(([other]) => other !== code).map(([, value]) => value);
    const verdict = (): Pick<DrugCheck, 'verdict' | 'reason'> => {
      for (const rule of rules.indications) {
        if (!atcHit(atc, rule.atc)) continue;
        const hits = icdHits(dx, rule.dx);
        if (hits.length) return { verdict: '適應症', reason: `${dxText(hits)}（${rule.basis}）` };
      }
      for (const rule of rules.coDrugs) {
        if (!atcHit(atc, rule.atc)) continue;
        const partner = others.find(other => atcHit(other, rule.partners));
        if (partner) return { verdict: '同處方', reason: `同處方 ${partner}：${rule.note}（${rule.basis}）` };
      }
      const usual = rules.specialty.get(dept);
      if (rules.byDepartment && usual && atcHit(atc, usual)) return { verdict: '科別常用', reason: `本次診斷無對應，${DEPARTMENTS[dept] ?? dept}常開` };
      if (atcHit(atc, rules.lowRisk)) return { verdict: '低風險', reason: '本次診斷無對應，低風險藥不提示' };
      if (atcHit(atc, rules.highAlert) && dx.length) return { verdict: '黃', reason: '高警訊藥，本次診斷與科別都無法解釋' };
      return { verdict: '灰', reason: dx.length ? '本次診斷與科別都無法解釋（預設收合）' : '處方沒有診斷碼' };
    };
    const cautions: Note[] = [];
    const ingredients = info.ingredients.toUpperCase();
    for (const caution of rules.cautions) {
      if (!(atcHit(atc, caution.atc) || (caution.keyword && ingredients.includes(caution.keyword)))) continue;
      const head = `${caution.id} ${caution.message}`;
      if (caution.kind === '診斷') {
        const hits = icdHits(dx, caution.condition);
        if (hits.length) cautions.push({ level: caution.level, text: `${head}（本次：${dxText(hits)}）` });
      } else if (caution.kind === '年齡') {
        const [years] = caution.condition;
        const hit = ageAtLeast(age, Number(years));
        if (hit) cautions.push({ level: caution.level, text: `${head}（${age}）` });
        else if (hit === undefined) cautions.push({ level: '灰', text: `${caution.id} 無法判斷：${age ? `${age} 跨過 ${years} 歲` : '沒有年齡'}` });
      } else {
        const hits = others.filter(other => atcHit(other, caution.condition));
        if (hits.length) cautions.push({ level: caution.level, text: `${head}（同處方：${hits.join(' ')}）` });
      }
    }
    return { code, frequency, route, info, ...verdict(), notes: cautions };
  });
  // Each distinct code counts an ingredient once, so a repeated code is not a repeated ingredient.
  const seen = new Map<string, number>();
  for (const code of atcs.keys()) for (const base of new Set(ingredientBases(drugs.get(code)!.ingredients))) seen.set(base, (seen.get(base) ?? 0) + 1);
  for (const [base, n] of seen) if (n > 1) notes.push({ level: rules.repeated, text: `同成分重複：${base} 出現在 ${n} 個品項` });
  return { drugs: checked, notes };
}

export interface IcdEntry { name: string; deleted: boolean }
/** ICD-10-CM puts the dot after the third character. */
export const icdDisplay = (code: string) => code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code;
/** I2510 → I25.10 and its Chinese name; a code not in the table falls back to its category, and says so. */
export function dxLabel(code: string, icd: Map<string, IcdEntry>): string {
  for (let n = code.length; n > 2; n--) {
    const entry = icd.get(code.slice(0, n));
    if (!entry) continue;
    const note = entry.deleted ? '（舊碼，2014 版已刪除）' : n === code.length ? '' : `（查無 ${code}，此為類別）`;
    return `${icdDisplay(code.slice(0, n))} ${entry.name}${note}`;
  }
  return `${code}（查無此碼）`;
}
