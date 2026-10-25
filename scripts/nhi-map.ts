import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePage } from '../src/management-parser';
import { SIX } from '../src/management-model';
import { parseDay, today, type Day } from '../src/report-date';
import type { TextPage } from '../src/textlayer';
import { loadNhi, rocDay, status, statusLabel, type Candidate } from './nhi-match';
import { applyReview, csvText, decodeCsv, lookup, mapText, marksOf, paidSiblings, readMap, REVIEW_COLUMNS, type MapEntry, type Outcome, type StoreItem } from './sku-map';

// 商品代號對照：庫存簡表的每個六碼先查對照檔，新的或品名變更的六碼才以名稱比對健保碼。
// Usage:
//   npm run nhi-map -- 庫存簡表.pdf [更多庫存簡表.pdf …] [--write] [--date YYYY-MM-DD]
//   npm run nhi-map -- --apply output/nhi-map/<檔名>-待確認.csv [--date YYYY-MM-DD]
//   npm run nhi-map -- --check [--date YYYY-MM-DD]
// Results go to output/nhi-map/, which Git ignores. Only --write and --apply change docs/reference/sku-nhi-map.csv.
// --date: the day whose 給付 status counts (default today in Taiwan). See docs/reference/sku-nhi-map.md.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = path.join(root, 'docs', 'reference'); const mapPath = path.join(reference, 'sku-nhi-map.csv');
const out = path.join(root, 'output', 'nhi-map');
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] ?? '' : undefined; };
const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const iso = (day: Day) => `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
const date = option('--date') ?? iso(today());
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseDay(date)) throw new Error('--date 請用 YYYY-MM-DD');
const apply = option('--apply'); const check = flag('--check'); const write = flag('--write');
if (!apply && !check && !args.length) throw new Error('請指定庫存簡表 PDF，或使用 --apply 待確認.csv、--check。');
const day = rocDay(date);

const nhi = loadNhi(await readFile(path.join(reference, 'nhi-drug-codes.csv'), 'utf8'));
const map = readMap(await readFile(mapPath, 'utf8'));
await mkdir(out, { recursive: true });
const saveMap = async () => { await writeFile(mapPath, mapText(map)); console.log(`已更新 ${path.relative(root, mapPath)}：共 ${map.size} 個六碼`); };

/** One candidate in a review cell: code first, so it can be copied into 採用. */
const describe = (code: string, extra = '') => {
  const e = nhi.codes.get(code); if (!e) return `${code}｜健保檔無此碼`;
  return [code, e.en, e.zh, `${e.form}${e.size ? ` ${e.size}${e.sizeUnit}` : ''}`, e.firm, statusLabel(e, day), extra].filter(Boolean).join('｜');
};
const scored = (c: Candidate) => describe(c.code, `${c.score} 分：${c.why.join('、')}`);
const current = (entry?: MapEntry) => entry ? `${entry.code || '無健保碼'}（${entry.verdict}，${entry.date}：${entry.key}）` : '';

if (apply) {
  const { applied, skipped } = applyReview(decodeCsv(await readFile(apply)), map, nhi, date);
  console.log(`待確認表：寫入 ${applied.length} 筆（人工確認 ${applied.filter(e => e.verdict === '人工確認').length}、無健保碼 ${applied.filter(e => e.verdict === '無健保碼').length}），採用欄空白 ${skipped} 筆`);
  if (applied.length) await saveMap();
} else if (check) {
  // After the NHI file is refreshed: codes that disappeared, stopped being paid, or have a scheduled change.
  const rows: string[][] = []; const counts: Record<string, number> = {};
  for (const entry of map.values()) {
    if (!entry.code) continue;
    const e = nhi.codes.get(entry.code); const s = e && status(e, day);
    const problem = !e ? '健保檔無此碼' : !s!.paid ? '未給付' : s!.stop ? '已排定停止給付' : s!.change ? '已排定調價' : '';
    if (!problem) continue;
    counts[problem] = (counts[problem] ?? 0) + 1;
    rows.push([entry.sku, entry.code, entry.verdict, entry.key, problem, e ? statusLabel(e, day) : '', paidSiblings(nhi, entry.code, day).join('、')]);
  }
  const target = path.join(out, '對照檔檢查.csv');
  await writeFile(target, csvText([['六碼', '健保藥品代號', '判定', '對接品名', '問題', '給付狀態', '同藥證現行碼'], ...rows]));
  console.log(`對照檔 ${map.size} 個六碼，${date} 需注意 ${rows.length} 筆：${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join('、') || '無'}`);
  console.log(`明細：${path.relative(root, target)}`);
} else {
  const items = new Map<string, StoreItem>(); const renamed: string[] = [];
  for (const [index, file] of args.entries()) for (const page of await stockPages(file, index)) {
    const printed = page.facts.printed ? ` ${iso(page.facts.printed)} 列印` : '';
    for (const row of page.stock) {
      if (!SIX.test(row.sku)) continue;
      const known = items.get(row.sku);
      if (!known) { items.set(row.sku, { sku: row.sku, rawName: row.rawName, qty: row.qty, source: `${page.facts.store.label}${printed}` }); continue; }
      known.qty = String(quantity(known.qty) + quantity(row.qty));
      if (known.rawName !== row.rawName) renamed.push(`${row.sku}：${known.rawName} ／ ${row.rawName}`);
    }
  }
  if (renamed.length) console.warn(`同一六碼有不同品名，採用先讀到的：\n  ${renamed.join('\n  ')}`);
  const outcomes = [...items.values()].map(item => ({ item, outcome: lookup(item, map, nhi, day, date) }));
  const result = (o: Outcome) => {
    if (o.kind === 'review') return `待確認：${o.reason}`;
    if (o.kind === 'matched') return o.previous ? '重新比對：自動明確（取代舊對照）' : '新比對：自動明確';
    return o.kind === 'renamed' ? '對照檔（品名已更新）' : '對照檔';
  };
  const lookupRows: string[][] = []; const reviewRows: string[][] = []; const counts: Record<string, number> = {};
  const review = (item: StoreItem, key: string, reason: string, previous: MapEntry | undefined, candidates: string[]) =>
    reviewRows.push([item.sku, item.rawName, key, reason, marksOf(item.rawName), item.qty, current(previous), ...Array.from({ length: 5 }, (_, i) => candidates[i] ?? ''), item.source, '']);
  for (const { item, outcome } of outcomes) {
    const entry = outcome.kind === 'review' ? outcome.previous : outcome.entry;
    const code = entry?.code ?? ''; const e = code ? nhi.codes.get(code) : undefined;
    // A mapped code gone from the NHI file, or no longer paid while its 藥證 has a paid code: the drug moved to a new code.
    const stale = outcome.kind !== 'review' && !!code && (!e || !status(e, day).paid);
    const siblings = stale ? paidSiblings(nhi, code, day) : [];
    const problem = stale && !e ? '對照碼不在健保檔' : siblings.length ? '對照碼今日未給付' : '';
    const label = result(outcome) + (problem ? `（${problem}，待確認）` : '');
    counts[label] = (counts[label] ?? 0) + 1;
    lookupRows.push([item.sku, item.rawName, item.qty, code, e?.en ?? '', e?.zh ?? '', code ? statusLabel(e, day) : entry ? '無健保碼' : '', label, entry?.verdict ?? '']);
    if (outcome.kind === 'review') review(item, outcome.key, outcome.reason, outcome.previous, outcome.match.candidates.slice(0, 5).map(scored));
    else if (problem) review(item, outcome.entry.key, problem, outcome.entry, siblings.map(c => describe(c)));
    if (write && (outcome.kind === 'renamed' || outcome.kind === 'matched')) map.set(item.sku, outcome.entry);
  }
  const stem = path.basename(args[0], path.extname(args[0])) + (args.length > 1 ? `等${args.length}份` : '');
  const lookupPath = path.join(out, `${stem}-查表.csv`); const reviewPath = path.join(out, `${stem}-待確認.csv`);
  await writeFile(lookupPath, csvText([['六碼', '簡表品名', '庫存量', '健保藥品代號', '健保英文名', '健保中文名', '給付狀態', '查表結果', '判定'], ...lookupRows]));
  await writeFile(reviewPath, csvText([REVIEW_COLUMNS, ...reviewRows]));
  console.log(`${items.size} 個六碼（${date} 給付狀態）：\n  ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('\n  ')}`);
  console.log(`查表結果：${path.relative(root, lookupPath)}\n待確認：${path.relative(root, reviewPath)}（在「採用」欄填健保藥品代號或「無」，再執行 --apply）`);
  const changes = outcomes.filter(({ outcome }) => outcome.kind === 'renamed' || outcome.kind === 'matched').length;
  if (write && changes) await saveMap();
  else if (changes) console.log(`有 ${changes} 筆自動明確或品名更新尚未寫入對照檔；確認後加 --write 重新執行。`);
}

function quantity(text: string) { const value = Number(text.replace(/,/g, '')); return Number.isFinite(value) ? value : 0; }

/** Every page of a system-printed 庫存簡表, checked by the management parser; any other page stops the run. */
async function stockPages(file: string, index: number) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const images = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
  const document = await pdfjs.getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n++) {
    const page = await document.getPage(n); const viewport = page.getViewport({ scale: 300 / 72 });
    const [operators, content] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
    const text: TextPage = { viewport: viewport.transform, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), hasImages: operators.fnArray.some(op => images.has(op)),
      items: content.items.flatMap((item: any) => 'str' in item ? [{ str: item.str, transform: item.transform, width: item.width }] : []) };
    const result = parsePage(text, 'inventory', index, n);
    if (!result.ok) throw new Error(`${path.basename(file)} 第 ${n} 頁：${result.reason}`);
    pages.push(result.page);
  }
  return pages;
}
