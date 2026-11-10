/**
 * For the weekly review of samples (docs/rx-samples-weekly-review.md), run through `npm run rx-try` on the reviewer's computer:
 * each de-identified sample written out for a person to read, and how much of the samples each caution can see, including the
 * prescriptions a caution would have caught had it looked inside combination products. Pure functions: no DOM, no network, no files.
 */
import { markedSex, rxFacts, splitFields } from './prescription-qr';
import { ageAtLeast, atcHit, checkPrescription, kidneyBelow, DEPARTMENTS, dxLabel, icdHits, ingredientBases, type Caution, type Condition, type DrugInfo, type Level, type RxFacts } from './rx-check';
import type { RxData } from './rx-data';
import { sampleCheck } from './rx-sample';

/** A sample line as the check reads it: field 5 holds SEXM／SEXF, field 6 the age band. */
const factsOf = (fields: string[]): RxFacts => rxFacts(fields, fields[5].trim().toUpperCase(), markedSex(fields[4]));

/** Each ingredient of a single-ingredient product → its ATC codes and how many products have each. */
export type ComponentIndex = Map<string, Map<string, number>>;
export function componentIndex(drugs: Map<string, DrugInfo>): ComponentIndex {
  const index: ComponentIndex = new Map(), bases = new Map<string, string[]>();
  for (const { atc, ingredients } of drugs.values()) {
    if (!bases.has(ingredients)) bases.set(ingredients, ingredientBases(ingredients));
    const [base, ...more] = bases.get(ingredients)!;
    if (!base || more.length) continue;
    const atcs = index.get(base) ?? new Map<string, number>();
    atcs.set(atc, (atcs.get(atc) ?? 0) + 1);
    index.set(base, atcs);
  }
  return index;
}
/** An ATC needs this many single-ingredient products: the NHI list has a few combinations filed under one ingredient's name. */
const MIN_PRODUCTS = 3;
/**
 * The ATC codes a combination product's ingredients have as single-ingredient products, those of the combination's own anatomical
 * group first (timolol in an eye drop is S01ED01, not C07AA06): when there are any only those, else all. Empty for one ingredient.
 */
export function componentAtcs(info: DrugInfo, index: ComponentIndex): string[] {
  const bases = ingredientBases(info.ingredients);
  if (bases.length < 2) return [];
  return [...new Set(bases.flatMap(base => {
    const atcs = [...index.get(base) ?? []].filter(([, n]) => n >= MIN_PRODUCTS).map(([atc]) => atc);
    const own = atcs.filter(atc => atc[0] === info.atc[0]);
    return own.length ? own : atcs;
  }))];
}

/** How a drug or condition is there: as the rule is written, only inside a combination product, not judgeable (age, sex), or not. */
type Match = 'direct' | 'combo' | 'unknown' | '';
const conditionLabel = (condition: Condition) => condition.kind === '年齡' ? `年齡${condition.below ? '<' : '>='}${condition.years}`
  : condition.kind === '性別' ? `性別${condition.sex === 'M' ? '男' : '女'}` : condition.kind === '腎功能' ? `腎功能<${condition.below}`
  : condition.kind === '同類數' ? `同類數>=${condition.min}` : condition.kind;
export interface CautionCoverage {
  id: string; level: Level;
  /** Prescriptions where the page shows it (any level, a 無法判斷 grey included). */
  fired: number;
  /** Prescriptions with a drug it names (ATC or keyword), and those with one only inside a combination product. */
  drug: number; drugCombo: number;
  /** Each condition: prescriptions where it holds, and (同處方) those where it holds only through a combination product. */
  conditions: { label: string; holds: number; combo: number }[];
  /** Prescriptions (indices into the lines) it would catch if combination products counted their ingredients, and does not. */
  comboMisses: number[];
}
/**
 * Every caution against every sample line, one prescription at a time as the samples are. A caution that never fires may have
 * no such patients (no drug, or the condition never met), patients whose drug and condition never meet on one prescription, or
 * prescriptions it cannot see because their drug, or the other drug, is inside a combination product with its own ATC.
 */
export function ruleCoverage(lines: string[], data: RxData, index = componentIndex(data.drugs)): CautionCoverage[] {
  const coverage = data.rules.cautions.map((caution): CautionCoverage => ({ id: caution.id, level: caution.level, fired: 0, drug: 0, drugCombo: 0,
    conditions: caution.conditions.map(condition => ({ label: conditionLabel(condition), holds: 0, combo: 0 })), comboMisses: [] }));
  const components = new Map<string, string[]>();
  const inside = (code: string, info: DrugInfo) => {
    if (!components.has(code)) components.set(code, componentAtcs(info, index));
    return components.get(code)!;
  };
  lines.forEach((line, i) => {
    const rx = factsOf(splitFields(line));
    const shown = new Set(checkPrescription(rx, data.drugs, data.rules).drugs.flatMap(drug => drug.notes.map(note => note.text.split(' ')[0])));
    const frequencies = new Map<string, string[]>();
    for (const { code, frequency } of rx.drugs) frequencies.set(code, [...frequencies.get(code) ?? [], frequency]);
    const codes = [...frequencies.keys()].flatMap(code => { const info = data.drugs.get(code); return info ? [{ code, info }] : []; });
    const drugMatch = (caution: Caution, code: string, info: DrugInfo): Match =>
      atcHit(info.atc, caution.atc) || (caution.keyword && info.ingredients.toUpperCase().includes(caution.keyword)) ? 'direct'
        : caution.atc.length && inside(code, info).some(atc => atcHit(atc, caution.atc)) ? 'combo' : '';
    // A condition for one drug of the prescription (self), or for the prescription as a whole (self '').
    const holds = (condition: Condition, self: string): Match => {
      switch (condition.kind) {
        case '診斷': return icdHits(rx.dx, condition.icd).length ? 'direct' : '';
        case '年齡': { const atLeast = ageAtLeast(rx.age, condition.years); return atLeast === undefined ? 'unknown' : atLeast !== condition.below ? 'direct' : ''; }
        case '性別': return !rx.sex ? 'unknown' : rx.sex === condition.sex ? 'direct' : '';
        case '同處方': {
          let found: Match = '';
          for (const { code, info } of codes) {
            if (code === self) continue;
            for (const partner of condition.partners) {
              if (partner.frequency && !frequencies.get(code)!.some(frequency => frequency.includes(partner.frequency))) continue;
              if (info.atc.startsWith(partner.atc)) return 'direct';
              if (inside(code, info).some(atc => atc.startsWith(partner.atc))) found = 'combo';
            }
          }
          return found;
        }
        case '未同處方': return condition.partners.some(partner => partner.code ? rx.drugs.some(drug => drug.code === partner.code && drug.code !== self)
          : codes.some(({ code, info }) => code !== self && info.atc.startsWith(partner.atc))) ? '' : 'direct';
        case '同類數': return codes.filter(({ info }) => atcHit(info.atc, condition.atc)).length >= condition.min ? 'direct' : '';
        case '腎功能': { const hit = kidneyBelow(rx.dx, rx.age, rx.sex, condition.below).hit; return hit === undefined ? 'unknown' : hit ? 'direct' : ''; }
      }
    };
    data.rules.cautions.forEach((caution, k) => {
      const row = coverage[k];
      if (shown.has(caution.id)) row.fired++;
      const matches = codes.map(({ code, info }) => ({ code, match: drugMatch(caution, code, info) }));
      if (matches.some(({ match }) => match === 'direct')) row.drug++;
      else if (matches.some(({ match }) => match === 'combo')) row.drugCombo++;
      caution.conditions.forEach((condition, c) => {
        const match = holds(condition, '');
        if (match === 'direct') row.conditions[c].holds++;
        else if (match === 'combo') row.conditions[c].combo++;
      });
      if (shown.has(caution.id)) return;
      const missed = matches.some(({ code, match }) => {
        if (!match) return false;
        const outcomes = caution.conditions.map(condition => holds(condition, code));
        return !outcomes.includes('') && (match === 'combo' || outcomes.includes('combo'));
      });
      if (missed) row.comboMisses.push(i);
    });
  });
  return coverage;
}

/**
 * One sample line for a person to read: the department, age band and sex; each diagnosis with its Chinese name; each drug with its
 * ATC and NHI ingredients, dose, frequency and route, and its total over the days given (a daily count in the total's own unit,
 * which is tablets for most oral drugs); then what the rules say now.
 */
export function describeSample(line: string, data: RxData): string[] {
  const fields = splitFields(line), rx = factsOf(fields), check = sampleCheck(line, data);
  const dept = rx.dept ? `${rx.dept} ${DEPARTMENTS[rx.dept] ?? ''}`.trim() : `科別未知（${fields[6].trim() || '空白'}）`;
  const sex = rx.sex === 'M' ? '男' : rx.sex === 'F' ? '女' : '性別不明';
  const days = Number(fields[9]);
  const out = [`${check.top || '無提示'}｜院所 ${fields[0]}｜${dept}｜${rx.age || '年齡不明'}｜${sex}｜${fields[9].trim() || '?'} 天`,
    `  診斷：${rx.dx.map(code => dxLabel(code, data.icd)).join('；') || '（無）'}`];
  for (let i = 14; i + 4 < fields.length; i += 5) {
    const [code, dose, frequency, route, total] = fields.slice(i, i + 5).map(value => value.trim());
    const info = data.drugs.get(code.toUpperCase()), amount = Number(total);
    const daily = days > 0 && amount > 0 ? `，每日約 ${Math.round(100 * amount / days) / 100}` : '';
    out.push(`  藥：${code} ${info ? `${info.atc} ${info.ingredients}` : '（不在健保用藥品項）'}｜${[dose, frequency, route].filter(Boolean).join(' ')}｜總量 ${total}${daily}`);
  }
  for (const alert of check.alerts) out.push(`  警示：${alert}`);
  if (check.cautions.length) out.push(`  注意事項：${check.cautions.join('、')}`);
  if (check.unexplained.length) out.push(`  未解釋：${check.unexplained.join('、')}`);
  return out;
}
