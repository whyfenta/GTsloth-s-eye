import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Only public dependency assets are downloaded. No user document is read or sent.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public', 'assets');
const fontsCommit = '51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca';
const dataCommit = '806cd9adc8c6e8abc11c782db1818c990576bebc';
const upstreamDataCommit = 'e12c65a915945e4c28e237a9b52bc4a8f39a0cec';
const assetManifest = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fetchAsset(relative, url, extra = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`Empty download: ${url}`);
  if (extra.expectedSha256 && sha256(bytes) !== extra.expectedSha256) {
    throw new Error(`Pinned asset hash mismatch: ${relative}`);
  }
  await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
  await writeFile(path.join(target, relative), bytes);
  const entry = { path: relative, source: url, bytes: bytes.length, sha256: sha256(bytes), ...extra };
  assetManifest.push(entry);
  console.log(`${relative}: ${bytes.length} bytes, SHA256 ${entry.sha256}`);
  return bytes;
}

await mkdir(target, { recursive: true });
await Promise.all(['eng', 'chi_tra'].map(async language => {
  const primary = `https://raw.githubusercontent.com/naptha/tessdata/${dataCommit}/4.0.0_best_int/${language}.traineddata.gz`;
  const cdn = `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${language}@1.0.0/4.0.0_best_int/${language}.traineddata.gz`;
  const bytes = await fetchAsset(`tessdata/${language}.traineddata.gz`, primary, {
    language, modelFamily: '4.0.0_best_int', packageVersion: '1.0.0',
    expectedSha256: language === 'eng'
      ? '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'
      : '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743',
    license: 'Apache-2.0',
    licenseSource: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/${upstreamDataCommit}/LICENSE`,
    packageLicenseSource: `https://raw.githubusercontent.com/naptha/tessdata/${dataCommit}/LICENSE`,
  });
  const unpacked = gunzipSync(bytes);
  const entry = assetManifest.find(item => item.path === `tessdata/${language}.traineddata.gz`);
  entry.uncompressedBytes = unpacked.length;
  entry.uncompressedSha256 = sha256(unpacked);
  // Independently check the published Tesseract.js data package is byte-identical.
  const cdnResponse = await fetch(cdn, { signal: AbortSignal.timeout(120000) });
  if (!cdnResponse.ok) throw new Error(`Model package verification failed: ${cdnResponse.status}`);
  const cdnBytes = Buffer.from(await cdnResponse.arrayBuffer());
  if (sha256(cdnBytes) !== entry.sha256) throw new Error(`Model source/package mismatch for ${language}`);
  entry.verifiedPackageSource = cdn;
}));

await Promise.all([
  fetchAsset('fonts/NotoSansTC-Regular.ttf', `https://raw.githubusercontent.com/google/fonts/${fontsCommit}/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf`, {
    family: 'Noto Sans TC', format: 'TrueType variable', axis: 'wght', defaultWeight: 100, requestedPdfWeight: 400,
    expectedSha256: '864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f',
    license: 'SIL Open Font License 1.1', licenseSource: `https://raw.githubusercontent.com/google/fonts/${fontsCommit}/ofl/notosanstc/OFL.txt`,
  }),
  fetchAsset('fonts/LibreBarcode128-Regular.ttf', `https://raw.githubusercontent.com/google/fonts/${fontsCommit}/ofl/librebarcode128/LibreBarcode128-Regular.ttf`, {
    family: 'Libre Barcode 128', format: 'TrueType',
    expectedSha256: 'bece6b8695cf29f04ce1c706f0f508a65545f3b6240a03cef302b70f846630a7',
    license: 'SIL Open Font License 1.1', licenseSource: `https://raw.githubusercontent.com/google/fonts/${fontsCommit}/ofl/librebarcode128/OFL.txt`,
  }),
  fetchAsset('licenses/NotoSansTC-OFL.txt', `https://raw.githubusercontent.com/google/fonts/${fontsCommit}/ofl/notosanstc/OFL.txt`),
  fetchAsset('licenses/LibreBarcode128-OFL.txt', `https://raw.githubusercontent.com/google/fonts/${fontsCommit}/ofl/librebarcode128/OFL.txt`),
  fetchAsset('licenses/tessdata-packaging-Apache-2.0.txt', `https://raw.githubusercontent.com/naptha/tessdata/${dataCommit}/LICENSE`),
  fetchAsset('licenses/tessdata-models-Apache-2.0.txt', `https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/${upstreamDataCommit}/LICENSE`),
]);

// Runtime copying is optional until dependencies are installed. It can be rerun.
async function copyRuntime(packageName, packageRelative, targetRelative) {
  const source = path.join(root, 'node_modules', packageName, packageRelative);
  try { await stat(source); } catch { return; }
  const bytes = await readFile(source);
  await mkdir(path.dirname(path.join(target, targetRelative)), { recursive: true });
  await copyFile(source, path.join(target, targetRelative));
  assetManifest.push({ path: targetRelative, source: `${packageName}/${packageRelative}`, bytes: bytes.length, sha256: sha256(bytes) });
}
await copyRuntime('tesseract.js', 'dist/worker.min.js', 'ocr/worker.min.js');
await copyRuntime('tesseract.js', 'LICENSE.md', 'licenses/tesseract.js-LICENSE.md');
await copyRuntime('pdfjs-dist', 'LICENSE', 'licenses/pdfjs-LICENSE.txt');
for (const directory of ['cmaps', 'standard_fonts']) {
  try {
    const files = await readdir(path.join(root, 'node_modules', 'pdfjs-dist', directory));
    for (const filename of files) {
      await copyRuntime('pdfjs-dist', `${directory}/${filename}`, `pdfjs/${directory}/${filename}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
try {
  const coreFiles = await readdir(path.join(root, 'node_modules', 'tesseract.js-core'));
  for (const filename of coreFiles.filter(name => /^tesseract-core.*\.(?:wasm|js)$/.test(name))) {
    await copyRuntime('tesseract.js-core', filename, `ocr/core/${filename}`);
  }
  await copyRuntime('tesseract.js-core', 'LICENSE', 'licenses/tesseract.js-core-LICENSE.txt');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

assetManifest.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(path.join(target, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, fetchedAt: new Date().toISOString(),
  notice: 'Public dependency assets only. NotoSansTC-Regular.ttf is the official variable font with default weight 100; select getVariation({ wght: 400 }) through a fontkit.create wrapper when embedding PDF subsets. It is not a static font conversion.',
  assets: assetManifest,
}, null, 2) + '\n');
await writeFile(path.join(target, 'SOURCE-NOTICES.txt'), [
  'Inventory Count Sheet dependency assets',
  '',
  'OCR models: Tesseract.js 4.0.0_best_int eng and chi_tra, sourced from',
  `https://github.com/naptha/tessdata/tree/${dataCommit}/4.0.0_best_int`,
  'Models originate in tesseract-ocr/tessdata_best and are Apache-2.0 licensed.',
  'The pinned naptha/tessdata repository LICENSE is also Apache-2.0.',
  'The npm package metadata says MIT, which conflicts with its upstream repository.',
  'This distribution includes the actual upstream Apache-2.0 LICENSE files.',
  'Model gzip data is unchanged.',
  'Published @tesseract.js-data package version 1.0.0 was independently compared by SHA-256.',
  '',
  `Fonts: https://github.com/google/fonts/tree/${fontsCommit}/ofl`,
  'Noto Sans TC and Libre Barcode 128 are SIL Open Font License 1.1 fonts.',
  'NotoSansTC-Regular.ttf is the official variable TTF; its default weight is 100.',
  'Regular PDF weight: use fontkit.create(bytes).getVariation({ wght: 400 })',
  'via the PDFDocument.registerFontkit create wrapper and subset: true.',
  'The file has not been renamed internally or otherwise transformed.',
  'Use an actual Code 128 encoder; do not directly apply the barcode font to digits.',
  'Encoder documentation: https://graphicore.github.io/librebarcode/documentation/code128',
  '',
  'All asset hashes, source URLs, byte sizes and upstream pins are in manifest.json.',
  'User inventory files are never part of these downloads.',
  '',
].join('\n'));
