import { asset } from './model';
import { compileRules, RULE_FILES, type DrugInfo, type IcdEntry, type RuleTables, type Rules } from './rx-check';

/** Built by `npm run rx-assets` from docs/reference: the rule tables, 健保碼 → ATC and 成分, and ICD-10-CM Chinese names. */
export interface DrugFile { dataDate: string; ingredients: string[]; drugs: Record<string, [string, number]> }
export interface IcdFile { version: string; codes: Record<string, string>; deleted: Record<string, string> }
/** rulesVersion: rulesVersion() of rules.json, so a sample says which rules judged it. */
export interface RxData { rules: Rules; drugs: Map<string, DrugInfo>; icd: Map<string, IcdEntry>; drugDate: string; icdVersion: string; rulesVersion: string }

async function json<T>(path: string): Promise<T> {
  const response = await fetch(asset(path));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return await response.json() as T;
}
export interface RuleFileJson { tables: RuleTables; sourceSha256?: Record<string, string> }
/** The first 4 hex digits of each rule table's SHA-256 in rules.json, in RULE_FILES order: a change to any table changes it. */
export const rulesVersion = (rules: RuleFileJson) => RULE_FILES.map(file => (rules.sourceSha256?.[`${file}.csv`] ?? '').slice(0, 4).padEnd(4, '-')).join('');
/** The three files as the check reads them. */
export function readRxData(rules: RuleFileJson, drugs: DrugFile, icd: IcdFile): RxData {
  return {
    rules: compileRules(rules.tables),
    drugs: new Map(Object.entries(drugs.drugs).map(([code, [atc, index]]) => [code, { atc, ingredients: drugs.ingredients[index] }])),
    icd: new Map<string, IcdEntry>([...Object.entries(icd.codes).map(([code, name]) => [code, { name, deleted: false }] as const),
      ...Object.entries(icd.deleted).map(([code, name]) => [code, { name, deleted: true }] as const)]),
    drugDate: drugs.dataDate, icdVersion: icd.version, rulesVersion: rulesVersion(rules),
  };
}
let pending: Promise<RxData> | undefined;
/**
 * The three files whole (~8 MB, gzip ~1 MB), on the first scan with the check switched on, so no request depends on a
 * prescription. A failed load is retried on the next scan.
 */
export function loadRxData(): Promise<RxData> {
  if (!pending) {
    pending = Promise.all([json<RuleFileJson>('rx/rules.json'), json<DrugFile>('rx/drugs.json'), json<IcdFile>('rx/icd10cm.json')])
      .catch(() => { throw new Error('處方警示資料載入失敗，下次掃碼會再試。'); })
      .then(([rules, drugs, icd]) => readRxData(rules, drugs, icd));
    pending.catch(() => { pending = undefined; });
  }
  return pending;
}
