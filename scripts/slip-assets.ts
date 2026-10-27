import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMap } from '../src/sku-map';
import { rosterNames } from './roster';

// Builds the 領藥憑單 lookup assets and records them in manifest.json (rerun after scripts/assets.mjs).
// Usage: npm run slip-assets -- [A21030000I-D2100G-001.csv] [--date YYYY-MM-DD] [--map ../GTsloth-map/sku-nhi-map.csv]
// Download the CSV from https://data.gov.tw/dataset/168341 and pass it unopened: spreadsheet edits corrupt codes.
// --map rebuilds nhi/products.json from the private 商品代號對照檔: only 健保碼, 六碼, 對接品名 and 改用六碼 are published.
// Without a CSV or --map only the manifest entries are refreshed from the files already in public/assets.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'public', 'assets');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const mapIndex = args.indexOf('--map');
const mapPath = mapIndex >= 0 ? args.splice(mapIndex, 2)[1] : undefined;
if (mapIndex >= 0 && !mapPath) throw new Error('Use --map path/to/sku-nhi-map.csv');
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
if (mapPath) {
  const bytes = await readFile(mapPath);
  const entries = [...readMap(bytes.toString('utf8')).values()].filter(entry => entry.code).sort((a, b) => a.sku.localeCompare(b.sku));
  const products: Record<string, string[][]> = {};
  for (const { sku, code, key, replacedBy } of entries) (products[code] ??= []).push(replacedBy ? [sku, key, replacedBy] : [sku, key]);
  // 判定日期 of the newest row; 判定 and 來源 (store names) stay in the private repository.
  const mapDate = entries.map(entry => entry.date).sort().at(-1) ?? '';
  await writeFile(path.join(assets, 'nhi', 'products.json'), JSON.stringify({
    source: 'whyfenta/GTsloth-map sku-nhi-map.csv', dataDate: mapDate, sourceSha256: sha256(bytes), count: entries.length,
    products: Object.fromEntries(Object.entries(products).sort(([a], [b]) => a.localeCompare(b))),
  }) + '\n');
  console.log(`nhi/products.json: ${Object.keys(products).length} 個健保碼、${entries.length} 個六碼，對照檔判定日期至 ${mapDate}`);
}
const manifestPath = path.join(assets, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { assets: { path: string }[] };
const roster = JSON.parse(await readFile(path.join(assets, 'nhi', 'institutions.json'), 'utf8'));
const products = JSON.parse(await readFile(path.join(assets, 'nhi', 'products.json'), 'utf8'));
const entries: { path: string; [key: string]: string }[] = [
  { path: 'forms/rx-slip.jpg', source: '會員中台「列印憑單」A4 範本內嵌的空白表格底圖（pdfimages -j 取出，未修改）' },
  { path: 'nhi/institutions.json', source: `${roster.source} ${roster.file}`, sourceSha256: roster.sourceSha256, dataDate: roster.dataDate,
    conversion: 'scripts/slip-assets.ts：醫事機構種類 A 的代碼與名稱', license: '政府資料開放授權條款第1版' },
  { path: 'licenses/OGDL-Taiwan-1.0.txt', source: 'https://data.gov.tw/license' },
  { path: 'nhi/products.json', source: products.source, sourceSha256: products.sourceSha256, dataDate: products.dataDate,
    conversion: 'scripts/slip-assets.ts --map：健保碼 → 六碼、對接品名與改用六碼（不含判定、判定日期與來源）' },
];
// Replace this script's entries in place and append new ones, leaving every other asset entry untouched.
for (const { path: relative, ...extra } of entries) {
  const bytes = await readFile(path.join(assets, relative));
  const entry = { path: relative, bytes: bytes.length, sha256: sha256(bytes), ...extra };
  const index = manifest.assets.findIndex(asset => asset.path === relative);
  if (index >= 0) manifest.assets[index] = entry; else manifest.assets.push(entry);
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
