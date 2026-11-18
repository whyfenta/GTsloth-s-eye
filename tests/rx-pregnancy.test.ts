import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atcHit, ingredientBases, type Caution, type DrugInfo } from '../src/rx-check';
import { readRxData } from '../src/rx-data';

// The 懷孕／哺乳 cautions (docs/reference/rx-rules.md「懷孕與哺乳」): a woman aged 10-49 with a drug her label says not to take
// while pregnant (red), to stop once pregnant (yellow, 懷孕停藥) or not to take while breastfeeding (yellow). They name drugs by ATC and keyword, so a combination product or a code with an
// odd ATC is easily missed (dutasteride with tamsulosin is G04CA52, not G04CB). Checked against the whole NHI file the page reads.
const data = readRxData(...(['rules', 'drugs', 'icd10cm'].map(name => JSON.parse(readFileSync(`public/assets/rx/${name}.json`, 'utf8'))) as Parameters<typeof readRxData>));
const LEVEL: Record<string, string> = { 懷孕: '紅', 懷孕停藥: '黃', 哺乳: '黃' };
const prefix = (caution: Caution) => /^(懷孕停藥|懷孕|哺乳)：/.exec(caution.message)?.[1];
const group = data.rules.cautions.filter(prefix);
assert.ok(group.length, '找不到提示以「懷孕：」「懷孕停藥：」或「哺乳：」開頭的注意事項');

// Every one is for a woman aged 10-49, and nothing else: red for pregnancy, yellow to stop once pregnant or for breastfeeding.
for (const caution of group) {
  const conditions = caution.conditions.map(condition => condition.key).sort();
  assert.deepEqual(conditions, ['年齡:10-49', '性別:女'], `${caution.id} 的條件要是 性別+年齡、女;10-49`);
  assert.equal(caution.level, LEVEL[prefix(caution)!], `${caution.id}：「懷孕：」給紅色，「懷孕停藥：」與「哺乳：」給黃色`);
}

/**
 * Products deliberately left out although they contain an ingredient of the group, by ATC prefix, with the reason. A product
 * listed here is not checked; anything else containing one of the ingredients must be matched by a caution of the group.
 */
const LEFT_OUT: Record<string, string> = {
  D10AD: '外用 isotretinoin、tretinoin：舊制不是 X，懷孕禁忌只在口服劑型',
  D06BX01: '外用 metronidazole：仿單的懷孕禁忌只針對口服治療陰道滴蟲',
  S01AE03: '眼用 ciprofloxacin：全身吸收少，仿單沒有不要哺乳',
  S02CA03: '耳用 ciprofloxacin 複方：同上',
  S01BC05: '眼用 ketorolac：仿單沒有待產與分娩禁忌',
  C04AE01: '腦循環用的 dihydroergotoxine（co-dergocrine）：美國仿單沒有懷孕禁忌，不是子宮收縮用的麥角鹼',
  G01AE: '陰道用抗感染複方，只含少量雌激素',
  G01AX: '陰道用抗感染複方，只含少量 estriol',
};

const matches = (caution: Caution, info: DrugInfo) => atcHit(info.atc, caution.atc) || (!!caution.keyword && info.ingredients.toUpperCase().includes(caution.keyword));
// The ingredients the group means: those of the single-ingredient products it matches.
const meant = new Set<string>();
for (const info of data.drugs.values()) {
  const bases = [...new Set(ingredientBases(info.ingredients))];
  if (bases.length === 1 && group.some(caution => matches(caution, info))) meant.add(bases[0]);
}
const missed: string[] = [], twice: string[] = [];
for (const [code, info] of data.drugs) {
  const by = group.filter(caution => matches(caution, info));
  if (by.length > 1) twice.push(`${code}（${info.atc}，${info.ingredients}）：${by.map(caution => caution.id).join('、')}`);
  if (by.length || atcHit(info.atc, Object.keys(LEFT_OUT))) continue;
  const found = ingredientBases(info.ingredients).filter(base => meant.has(base));
  if (found.length) missed.push(`${code}（${info.atc}，${info.ingredients}）含 ${found.join('、')}`);
}
assert.deepEqual(missed, [], '這些健保碼含懷孕／哺乳規則的成分，卻沒有被任何一條對到：在該條加上 ATC 或成分關鍵字，或寫進 LEFT_OUT 並說明理由');
assert.deepEqual(twice, [], '這些健保碼對到兩條以上的懷孕／哺乳規則，同一個藥會出現兩則：調整 ATC，讓每個藥只對到一條');
console.log(`懷孕／哺乳規則 ${group.length} 條，涵蓋 ${meant.size} 種成分，passed`);
