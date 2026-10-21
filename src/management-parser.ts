// 樹懶的管理: reads one text-layer page of either report into rows and page facts.
// Only system-printed PDFs are accepted; a page with any image is refused instead of guessed.
import { autoExclusion, managementName, parseDay, storeId, type Day, type Origin, type ReportPage, type StockRow, type StoreId, type UsageRow } from './management-model';
import { extractTextPage, textLayer, type TextLayer, type TextPage } from './textlayer';
import type { Span } from './parser';
import { printedDay } from './report-date';

export type ReportKind = 'usage' | 'inventory';
export const KIND_LABEL: Record<ReportKind, string> = { usage: '醫品調劑數量統計表', inventory: '庫存簡表' };
/** Facts printed on every page that must agree across all pages of one report. */
export type PageFacts = { store: StoreId; reportPage: number; reportTotal: number; printed?: Day; period?: { start: Day; end: Day }; payment?: string; warehouse?: string };
export type ParsedPage = ReportPage & { kind: ReportKind; facts: PageFacts; rotation: number; usage: UsageRow[]; stock: StockRow[] };
export type PageResult = { ok: true; page: ParsedPage } | { ok: false; kind?: ReportKind; reason: string };
const compact = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');

export function reportKind(layer: TextLayer): ReportKind | undefined {
  const text = compact(layer.reading.text);
  if (text.includes('醫品調劑數量統計表')) return 'usage';
  if (text.includes('庫存簡表')) return 'inventory';
  return undefined;
}

type Run = Span & { run: number };
/** Whole text runs (never split), so a value is read exactly as the report printed it. */
function runsOf(layer: TextLayer): Run[] {
  const runs = new Map<number, typeof layer.chars>();
  for (const char of layer.chars) { const list = runs.get(char.run); if (list) list.push(char); else runs.set(char.run, [char]); }
  return [...runs].map(([run, chars]) => ({ run, text: chars.map(c => c.text).join(''), confidence: 100, x0: Math.min(...chars.map(c => c.x0)), x1: Math.max(...chars.map(c => c.x1)), y0: Math.min(...chars.map(c => c.y0)), y1: Math.max(...chars.map(c => c.y1)) }));
}
/** Left and right edge of a heading label on one printed line, even when one text run holds several labels. */
function labelOn(layer: TextLayer, line: Span, label: string): [number, number] | undefined {
  const chars = layer.chars.filter(c => Math.abs(c.y1 - line.y1) < (c.y1 - c.y0) * .4).sort((a, b) => a.x0 - b.x0);
  const text = chars.map(c => c.text).join(''); const at = text.indexOf(label);
  return at < 0 ? undefined : [chars[at].x0, chars[at + Array.from(label).length - 1].x1];
}
const numeric = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
const USAGE_LABELS = ['醫品編號', '醫品名稱', '單位', '次數', '數量', '健保價'] as const;

/**
 * 醫品調劑數量統計表. The text runs are stored out of the printed order, so columns come from coordinates:
 * code and name by where a run starts, the right-aligned numbers by where they end. 健保價 is never read as a value.
 */
export function parseUsagePage(layer: TextLayer, file: number, filePage: number): PageResult {
  const lines = layer.reading.lines; const all = compact(layer.reading.text); const { height } = layer;
  if (!all.includes('醫品調劑數量統計表')) return { ok: false, reason: '不是醫品調劑數量統計表' };
  const header = lines.find(line => USAGE_LABELS.every(label => compact(line.text).includes(label)));
  if (!header) return { ok: false, kind: 'usage', reason: '找不到完整表頭（醫品編號、醫品名稱、單位、次數、數量、健保價）' };
  const edges = USAGE_LABELS.map(label => labelOn(layer, header, label));
  if (edges.some(edge => !edge) || edges.some((edge, i) => i && edge![0] <= edges[i - 1]![0])) return { ok: false, kind: 'usage', reason: '表頭欄位順序與範本不同' };
  const [code, name, unit, count, quantity, price] = edges as [number, number][];
  const above = lines.filter(line => line.y1 <= header.y0 + 1).map(line => line.text.normalize('NFKC')).join('\n');
  const period = above.match(/統計期間[:：]\s*(\d{8})\s*至\s*(\d{8})/); const start = period && parseDay(period[1]); const end = period && parseDay(period[2]);
  const pageNo = above.match(/頁次[:：]\s*(\d+)\s*\/\s*(\d+)/); const payment = above.match(/給付方式[:：]\s*(.+?)\s*(?:頁次|列印時間|$)/m)?.[1]?.trim();
  const store = above.match(/營業點[:：]\s*(\d+)\s+(\S+)/);
  const missing = [!start || !end ? '統計期間' : '', !pageNo ? '頁次' : '', !payment ? '給付方式' : '', !store ? '營業點' : ''].filter(Boolean);
  if (missing.length) return { ok: false, kind: 'usage', reason: `每頁都要印有${missing.join('、')}，這一頁缺少，無法確認屬於同一份報表` };
  const reportPage = Number(pageNo![1]); const reportTotal = Number(pageNo![2]);
  if (!reportPage || reportPage > reportTotal) return { ok: false, kind: 'usage', reason: `頁次 ${pageNo![0]} 不合理` };
  const tolerance = (header.y1 - header.y0) * .3;
  const body = runsOf(layer).filter(run => run.y0 > header.y1 - 1 && run.text.trim()).sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0);
  // A printed line: runs sharing a baseline.
  const rowsOf: Run[][] = [];
  for (const run of body) { const line = rowsOf.find(group => Math.abs(group[0].y1 - run.y1) < (run.y1 - run.y0) * .4); if (line) line.push(run); else rowsOf.push([run]); }
  const usage: UsageRow[] = []; const countEdge = (count[1] + quantity[1]) / 2; const quantityEdge = (quantity[1] + price[1]) / 2;
  for (const line of rowsOf) {
    const cells = { code: [] as string[], name: [] as string[], unit: [] as string[], count: [] as string[], quantity: [] as string[], price: [] as string[] };
    for (const run of line.sort((a, b) => a.x0 - b.x0)) {
      const text = run.text.normalize('NFKC').trim();
      if (run.x0 < name[0] - tolerance) cells.code.push(text);
      else if (run.x0 < unit[0] - tolerance) cells.name.push(run.text.trim());
      else if (numeric.test(text)) (run.x1 <= countEdge ? cells.count : run.x1 <= quantityEdge ? cells.quantity : cells.price).push(text);
      else if (run.x0 < count[0]) cells.unit.push(text);
      else cells.price.push(text); // text right of the unit column is never a count or quantity
    }
    const top = Math.min(...line.map(r => r.y0)); const bottom = Math.max(...line.map(r => r.y1));
    if (!cells.code.length && !cells.count.length && !cells.quantity.length) {
      // A name printed on a second line belongs to the line above it.
      const previous = usage.at(-1); if (previous && cells.name.length) { previous.rawName += cells.name.join(''); previous.origin.bottom = bottom / height + .002; }
      continue;
    }
    const notes: string[] = [];
    for (const [key, label] of [['code', '醫品編號'], ['unit', '單位'], ['count', '次數'], ['quantity', '數量']] as const) if (cells[key].length > 1) notes.push(`${label}欄有多個值（${cells[key].join('、')}），請核對原圖`);
    if (cells.price.some(text => !numeric.test(text))) notes.push('健保價欄有非數字文字，請核對原圖');
    const sku = cells.code.join(' ');
    usage.push({ id: `u${file}-${filePage}-${usage.length}`, origin: { file, filePage, reportPage, top: Math.max(0, top / height - .002), bottom: Math.min(1, bottom / height + .002) },
      sku, rawName: cells.name.join(''), unit: cells.unit.join(' '), count: cells.count.join(' '), quantity: cells.quantity.join(' '), notes, reviewed: notes.length === 0, excluded: autoExclusion(sku) });
  }
  if (!usage.length && reportPage !== reportTotal) return { ok: false, kind: 'usage', reason: '表頭下沒有任何明細列' };
  const facts: PageFacts = { store: storeId(store![2], store![1]), reportPage, reportTotal, printed: printedDay(above), period: { start: start!, end: end! }, payment };
  const meta = JSON.stringify([facts.store.label, facts.store.number, period![1], period![2], payment, reportTotal]);
  const signature = JSON.stringify(usage.map(r => [r.sku, r.rawName, r.unit, r.count, r.quantity]));
  return { ok: true, page: { key: `u${file}-${filePage}`, kind: 'usage', file, filePage, reportPage, reportTotal, signature, meta, facts, rotation: layer.rotation, usage, stock: [] } };
}

/** 庫存簡表, read with the inventory sheet's own text-layer parser; each page must carry its own header and page number. */
export function parseStockPage(text: TextPage, layer: TextLayer, file: number, filePage: number): PageResult {
  const all = compact(layer.reading.text);
  if (!all.includes('庫存簡表')) return { ok: false, reason: '不是庫存簡表' };
  const result = extractTextPage(filePage, text);
  if (!result?.layout) return { ok: false, kind: 'inventory', reason: '找不到完整表頭（商品代號、名稱、國際條碼、儲位、庫存量）' };
  const full = layer.reading.lines.map(line => line.text.normalize('NFKC')).join('\n');
  const pageNo = full.match(/頁次[:：]?\s*(\d+)\s*(?:of|\/)\s*(\d+)/i); const title = result.report.storeName;
  const missing = [!pageNo ? '頁次' : '', !title ? '門市名稱' : ''].filter(Boolean);
  if (missing.length) return { ok: false, kind: 'inventory', reason: `每頁都要印有${missing.join('、')}，這一頁缺少，無法確認屬於同一份報表` };
  const reportPage = Number(pageNo![1]); const reportTotal = Number(pageNo![2]);
  if (!reportPage || reportPage > reportTotal) return { ok: false, kind: 'inventory', reason: `頁次 ${pageNo![0]} 不合理` };
  const printed = printedDay(full); const warehouse = full.match(/庫別[:：]\s*(\d+)/)?.[1];
  const stock: StockRow[] = result.rows.map((row, i) => {
    const cleaned = managementName(row.rawName); const box = Object.values(row.boxes);
    const notes = [...row.issues, ...(cleaned.uncertain ? ['名稱前綴無法完整解析，請核對原名稱'] : [])];
    return { id: `s${file}-${filePage}-${i}`, origin: { file, filePage, reportPage, top: Math.min(...box.map(b => b.y)), bottom: Math.max(...box.map(b => b.y + b.height)) },
      sku: row.sku, rawName: row.rawName, name: cleaned.name, location: row.location, qty: row.bookQty, notes, reviewed: notes.length === 0, excluded: autoExclusion(row.sku) };
  });
  const facts: PageFacts = { store: storeId(title), reportPage, reportTotal, printed, warehouse };
  const meta = JSON.stringify([facts.store.label, reportTotal, printed && [printed.y, printed.m, printed.d]]);
  const signature = JSON.stringify(stock.map(r => [r.sku, r.rawName, r.location, r.qty]));
  return { ok: true, page: { key: `s${file}-${filePage}`, kind: 'inventory', file, filePage, reportPage, reportTotal, signature, meta, facts, rotation: layer.rotation, usage: [], stock } };
}

/** One page of a file dropped on the `expected` side. Scans and pages of the other report are refused with the reason. */
export function parsePage(text: TextPage | undefined, expected: ReportKind, file: number, filePage: number): PageResult {
  if (!text) return { ok: false, reason: '只接受系統列印的 PDF，不接受圖片檔' };
  if (text.hasImages) return { ok: false, reason: '這一頁含有圖片（掃描檔或隱藏 OCR 文字層），本功能只接受系統直接列印、沒有圖片的 PDF' };
  if (!text.items.some(item => item.str.trim())) return { ok: false, reason: '這一頁沒有文字層，本功能只接受系統直接列印的 PDF' };
  const layer = textLayer(text); const kind = reportKind(layer);
  if (!kind) return { ok: false, reason: '不是醫品調劑數量統計表或庫存簡表' };
  if (kind !== expected) return { ok: false, kind, reason: `這是${KIND_LABEL[kind]}，請放到「${KIND_LABEL[kind]}」區` };
  return kind === 'usage' ? parseUsagePage(layer, file, filePage) : parseStockPage(text, layer, file, filePage);
}
