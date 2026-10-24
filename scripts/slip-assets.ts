import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rosterNames } from './roster';

// Builds the 領藥憑單 lookup assets and records them in manifest.json (rerun after scripts/assets.mjs).
// Usage: npm run slip-assets -- [A21030000I-D2100G-001.csv] [--date YYYY-MM-DD]
// Download the CSV from https://data.gov.tw/dataset/168341 and pass it unopened: spreadsheet edits corrupt codes.
// Without a CSV only the manifest entries are refreshed from the files already in public/assets.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'public', 'assets');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const dateIndex = args.indexOf('--date');
const dataDate = dateIndex >= 0 ? args.splice(dateIndex, 2)[1] : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDate ?? '')) throw new Error('Use --date YYYY-MM-DD');

if (args[0]) {
  const bytes = await readFile(args[0]);
  const { names, skipped } = rosterNames(bytes.toString('utf8'));
  const count = Object.keys(names).length;
  if (count < 1000) throw new Error(`名冊只有 ${count} 筆醫院／診所，請確認下載的是完整的 A21030000I-D2100G-001.csv。`);
  await mkdir(path.join(assets, 'nhi'), { recursive: true });
  await writeFile(path.join(assets, 'nhi', 'institutions.json'), JSON.stringify({
    source: 'https://data.gov.tw/dataset/168341', file: 'A21030000I-D2100G-001.csv', dataDate, sourceSha256: sha256(bytes), count,
    attribution: '此資料係由衛生福利部中央健康保險署提供，依政府資料開放授權條款（Open Government Data License）進行公眾釋出。',
    names,
  }) + '\n');
  console.log(`nhi/institutions.json: ${count} 筆醫院／診所，資料日期 ${dataDate}`);
  if (skipped.length) console.warn(`略過 ${skipped.length} 筆無法還原的代碼（請勿先用 Excel 開啟名冊）：\n  ${skipped.join('\n  ')}`);
}
const manifestPath = path.join(assets, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { assets: { path: string }[] };
const roster = JSON.parse(await readFile(path.join(assets, 'nhi', 'institutions.json'), 'utf8'));
const entries: { path: string; [key: string]: string }[] = [
  { path: 'forms/rx-slip.jpg', source: '會員中台「列印憑單」A4 範本內嵌的空白表格底圖（pdfimages -j 取出，未修改）' },
  { path: 'nhi/institutions.json', source: `${roster.source} ${roster.file}`, sourceSha256: roster.sourceSha256, dataDate: roster.dataDate,
    conversion: 'scripts/slip-assets.ts：醫事機構種類 A 的代碼與名稱', license: '政府資料開放授權條款第1版' },
  { path: 'licenses/OGDL-Taiwan-1.0.txt', source: 'https://data.gov.tw/license' },
];
// Replace this script's entries in place and append new ones, leaving every other asset entry untouched.
for (const { path: relative, ...extra } of entries) {
  const bytes = await readFile(path.join(assets, relative));
  const entry = { path: relative, bytes: bytes.length, sha256: sha256(bytes), ...extra };
  const index = manifest.assets.findIndex(asset => asset.path === relative);
  if (index >= 0) manifest.assets[index] = entry; else manifest.assets.push(entry);
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
