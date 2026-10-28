import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules, icdDisplay, normCode, ruleTable, RULE_FILES, type RuleTables } from '../src/rx-check';

// Builds the 處方警示 assets from docs/reference and records them in manifest.json (rerun after scripts/assets.mjs).
// Usage: npm run rx-assets
// rx/rules.json: the tables in docs/reference/rx-rules/, checked row by row; rerun after editing them (npm test fails until then).
// rx/drugs.json: 健保碼 → ATC代碼 and 成分 from docs/reference/nhi-drug-codes.csv.
// rx/icd10cm.json: every ICD-10-CM code → Chinese name from docs/reference/icd10cm-zh.csv. One file, fetched whole, so no
// request depends on a patient's diagnoses (a file per chapter would tell the server which chapter was scanned).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'public', 'assets');
const reference = path.join(root, 'docs', 'reference');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** The data date and version are documented once, in the reference files' own notes. */
async function documented(file: string, pattern: RegExp): Promise<string> {
  const match = pattern.exec(await readFile(path.join(reference, file), 'utf8'));
  if (!match) throw new Error(`${file} 找不到 ${pattern}，請照原格式記錄資料日期或版本。`);
  return match[1];
}
const DECLARATION = 'https://www.nhi.gov.tw/ch/cp-4379-5d212-3280-1.html';
await mkdir(path.join(assets, 'rx'), { recursive: true });

const ruleBytes = Object.fromEntries(await Promise.all(RULE_FILES.map(async file => [file, await readFile(path.join(reference, 'rx-rules', `${file}.csv`))] as const)));
const tables = Object.fromEntries(RULE_FILES.map(file => [file, ruleTable(ruleBytes[file].toString('utf8'))])) as RuleTables;
const rules = compileRules(tables);
await writeFile(path.join(assets, 'rx', 'rules.json'), JSON.stringify({
  source: 'docs/reference/rx-rules/', status: '草稿，待藥師審核；「依據」欄是起草者的判斷，不是查證過的結果',
  sourceSha256: Object.fromEntries(RULE_FILES.map(file => [`${file}.csv`, sha256(ruleBytes[file])])), tables,
}) + '\n');
console.log(`rx/rules.json: 適應症 ${rules.indications.length} 列、同處方 ${rules.coDrugs.length} 列、注意事項 ${rules.cautions.length} 列、科別 ${rules.specialty.size} 科`);

const drugBytes = await readFile(path.join(reference, 'nhi-drug-codes.csv'));
const drugDate = await documented('nhi-drug-codes.md', /資料基準日：[^（\n]*（(\d{4}-\d{2}-\d{2})）/);
// A code has a row per payment period; ATC and 成分 are the same in every one (checked here), so the first row stands.
const drugs = new Map<string, [string, string]>();
for (const row of ruleTable(drugBytes.toString('utf8'))) {
  const code = row['藥品代號'], atc = row['ATC代碼'], ingredients = row['成分'];
  if (!/^[0-9A-Z]{10}$/.test(code) || atc === undefined || ingredients === undefined) throw new Error(`nhi-drug-codes.csv 的藥品代號或欄位不對：${code}`);
  const known = drugs.get(code);
  if (known && (known[0] !== atc || known[1] !== ingredients)) throw new Error(`nhi-drug-codes.csv 的 ${code} 各列 ATC 或成分不同。`);
  drugs.set(code, [atc, ingredients]);
}
// 成分 repeats across codes (8,345 for 45,217 codes), so each drug points into one list.
const ingredients = [...new Set([...drugs.values()].map(([, text]) => text))].sort();
const index = new Map(ingredients.map((text, i) => [text, i]));
await writeFile(path.join(assets, 'rx', 'drugs.json'), JSON.stringify({
  source: 'docs/reference/nhi-drug-codes.csv', sourceSha256: sha256(drugBytes), dataDate: drugDate, count: drugs.size,
  attribution: '出處：衛生福利部中央健康保險署「健保用藥品項」，依健保署政府網站資料開放宣告使用。', ingredients,
  drugs: Object.fromEntries([...drugs].sort(([a], [b]) => a.localeCompare(b)).map(([code, [atc, text]]) => [code, [atc, index.get(text)]])),
}) + '\n');
console.log(`rx/drugs.json: ${drugs.size} 個健保碼、${ingredients.length} 種成分，資料基準日 ${drugDate}`);

const icdBytes = await readFile(path.join(reference, 'icd10cm-zh.csv'));
const icdVersion = await documented('icd10cm-zh.md', /資料版本：健保署「([^」]+)」/);
const codes: Record<string, string> = {}, deleted: Record<string, string> = {};
for (const row of ruleTable(icdBytes.toString('utf8'))) {
  const code = normCode(row['代碼']);
  // The page shows a code with its dot after the third character; the table must agree.
  if (icdDisplay(code) !== row['代碼'] || code in codes || code in deleted) throw new Error(`icd10cm-zh.csv 的代碼不對或重複：${row['代碼']}`);
  if (row['版本'] === '2023') codes[code] = row['中文名稱'];
  else if (row['版本'] === '2014已刪除') deleted[code] = row['中文名稱'];
  else throw new Error(`icd10cm-zh.csv 的 ${row['代碼']} 版本不是 2023 或 2014已刪除。`);
}
const icdCount = Object.keys(codes).length + Object.keys(deleted).length;
await writeFile(path.join(assets, 'rx', 'icd10cm.json'), JSON.stringify({
  source: 'docs/reference/icd10cm-zh.csv', sourceSha256: sha256(icdBytes), version: icdVersion, count: icdCount,
  attribution: `出處：衛生福利部中央健康保險署「${icdVersion}」，依健保署政府網站資料開放宣告使用。`, codes, deleted,
}) + '\n');
console.log(`rx/icd10cm.json: ${icdCount} 碼（其中 2014 版已刪除的舊碼 ${Object.keys(deleted).length} 碼），${icdVersion}`);

const manifestPath = path.join(assets, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { assets: { path: string }[] };
const license = '健保署政府網站資料開放宣告（使用時註明出處）';
const entries: { path: string; [key: string]: string }[] = [
  { path: 'rx/rules.json', source: 'docs/reference/rx-rules/*.csv（本專案的規則表草稿，待藥師審核）', conversion: 'scripts/rx-assets.ts：逐列檢查後原樣轉成 JSON' },
  { path: 'rx/drugs.json', source: '衛生福利部中央健康保險署「健保用藥品項」，經 docs/reference/nhi-drug-codes.csv 精簡', sourceSha256: sha256(drugBytes), dataDate: drugDate,
    conversion: 'scripts/rx-assets.ts：健保碼 → ATC代碼與成分', license, licenseSource: DECLARATION },
  { path: 'rx/icd10cm.json', source: `衛生福利部中央健康保險署「${icdVersion}」，經 docs/reference/icd10cm-zh.csv 轉換`, sourceSha256: sha256(icdBytes),
    conversion: 'scripts/rx-assets.ts：代碼 → 中文名稱（含 2014 版已刪除的舊碼）', license, licenseSource: DECLARATION },
  { path: 'licenses/NHI-open-data.txt', source: DECLARATION },
];
// Replace this script's entries in place and append new ones, leaving every other asset entry untouched.
for (const { path: relative, ...extra } of entries) {
  const bytes = await readFile(path.join(assets, relative));
  const entry = { path: relative, bytes: bytes.length, sha256: sha256(bytes), ...extra };
  const at = manifest.assets.findIndex(asset => asset.path === relative);
  if (at >= 0) manifest.assets[at] = entry; else manifest.assets.push(entry);
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
