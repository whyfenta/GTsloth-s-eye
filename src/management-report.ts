// 樹懶的管理: everything the page shows and prints, derived from the parsed pages and the reviewer's edits.
import { formatQuantity } from './model';
import { aggregateStock, aggregateUsage, assemble, assembleReports, assemblyComplete, cmp, dayBefore, disposition, daysBetween, DEFAULT_SAFETY_STRATEGY, formatDay, formatFrac, frac, largeOrder, LARGE_ORDER, longPeriod, matchStores, NHI_A_FACTOR, overstock, parseDecimal, PARTNER_COVERS, partnerSupplied, SAFETY_STRATEGIES, safetyList, safetyStrategyRange, SELF_PAY_DISPOSITION, mergeStockReports, slotLists, STALE_DAYS, statMonths, stockDuplicates, stockErrors, today, toOrder, unheldOnList, usageCodes, usageErrors,
  type Assembly, type Day, type Frac, type PartnerCover, type SafetyResult, type SafetyStrategy, type SlotRow, type StockRow, type UsageRow, type UsageSummary } from './management-model';
import type { ParsedPage } from './management-parser';
import type { ListSpec } from './management-pdf';

export type ListKind = 'safety' | 'dead' | 'empty';
export const LIST_TITLE: Record<ListKind, string> = { safety: '安全量調整及採購建議清單', dead: '呆藥清單', empty: '空位清單' };
/** Printed between the dead stock and the self-pay lines that follow it, in grey. */
export const SELF_PAY_HEADING = '以下品項偵測應為自費品，耗量不在健保調劑量統計內，但機械判別難免有誤，請過目。';
/** Reviewer decisions that are not edits of a row. */
export type Decisions = { storeConfirmed: boolean; safetyStrategy?: SafetyStrategy;
  /** Partner-clinic stores: how little stock (in months of use) counts as clinic-supplied. 'wide' is opt-in. */
  partnerCover?: PartnerCover };
export type Derived = {
  /** `stock` combines every stock sheet's pages; `stockReports` keeps each separately printed sheet, in import order. */
  usage: Assembly<ParsedPage>; stock: Assembly<ParsedPage>; stockReports: Assembly<ParsedPage>[]; usageRows: UsageRow[]; stockRows: StockRow[];
  /** Lines printed by more than one stock sheet (same code and location) that were counted once. */
  stockOverlap: number;
  /** Problems with the sources themselves; any one blocks every list. */
  blockers: string[]; warnings: string[];
  pendingUsage: UsageRow[]; pendingStock: StockRow[]; summary: UsageSummary; duplicates: StockRow[][];
  months?: Frac; period?: string; payment?: string; storeLabel: string; storeMatch?: 'same' | 'different' | 'unsure';
  safety?: SafetyResult; dead: SlotRow[]; empty: SlotRow[]; zeroRows: number;
  /** Self-pay lines with stock outside the usage report: kept out of dead stock, printed in grey after it. */
  selfPay: SlotRow[];
  /** Reports printed STALE_DAYS or more before today: their numbers may no longer match the store. */
  stale: { kind: 'usage' | 'inventory'; printed: Day; days: number }[];
  /** Set when more than PARTNER_LIMIT codes of the ordinary safety list have no stock line: how many there were. */
  partner?: { missing: number };
  /** Usage codes without any stock line; kept in N and marked when printed on the safety list. */
  missing: { sku: string; name: string; pages: number[]; onList: boolean }[];
  ready: boolean; available: Record<ListKind, boolean>; reasons: Record<ListKind, string>;
};
export const needsReview = <R extends { reviewed: boolean; excluded?: string }>(row: R, errors: string[]) => !row.excluded && (!row.reviewed || errors.length > 0);
const pagesOf = (rows: { origin: { reportPage: number } }[]) => [...new Set(rows.map(row => row.origin.reportPage))].sort((a, b) => a - b);
const label = { usage: '醫品調劑數量統計表', inventory: '庫存簡表' };

export function derive(pages: ParsedPage[], rejected: { kind: 'usage' | 'inventory'; reason: string }[], decisions: Decisions, now: Day = today(), nhi: ReadonlyMap<string, string> | null = new Map()): Derived {
  const usage = assemble(pages.filter(page => page.kind === 'usage'));
  // Stock sheets may be several separate printouts (a main sheet and a supplement): each must be complete on its own.
  const stockReports = assembleReports(pages.filter(page => page.kind === 'inventory'));
  const stock: Assembly<ParsedPage> = { pages: stockReports.flatMap(set => set.pages), duplicates: stockReports.flatMap(set => set.duplicates), conflicts: stockReports.flatMap(set => set.conflicts),
    missing: [], totals: [...new Set(stockReports.flatMap(set => set.totals))], metas: stockReports.flatMap(set => set.metas) };
  const blockers: string[] = []; const warnings: string[] = [];
  for (const item of rejected) blockers.push(`${label[item.kind]}：${item.reason}`);
  if (!stockReports.length) blockers.push(`尚未取得可用的${label.inventory}`);
  const reportName = (i: number) => stockReports.length > 1 ? `${label.inventory}（第 ${i + 1} 份報表，共 ${stockReports[i].totals[0]} 頁）` : label.inventory;
  for (const [name, set] of [[label.usage, usage] as const, ...stockReports.map((set, i) => [reportName(i), set] as const)]) {
    if (!set.pages.length) { blockers.push(`尚未取得可用的${name}`); continue; }
    if (set.totals.length > 1) blockers.push(`${name}各頁的總頁數不同（${set.totals.join('、')}），不是同一份報表`);
    if (set.metas.length > 1) blockers.push(`${name}各頁的門市、期間、給付方式或列印日期不一致，不能混算`);
    if (set.missing.length) blockers.push(`${name}缺少第 ${set.missing.join('、')} 頁（共 ${Math.max(...set.totals)} 頁）；缺頁不能當成沒有資料`);
    for (const [a, b] of set.conflicts) blockers.push(`${name}第 ${a.reportPage} 頁出現兩次且內容不同（第 ${a.file + 1} 份第 ${a.filePage} 頁、第 ${b.file + 1} 份第 ${b.filePage} 頁），請移除錯誤的檔案`);
  }
  const stores = [...new Set(stockReports.map(set => set.pages[0].facts.store.label))];
  if (stores.length > 1) blockers.push(`各份庫存簡表不是同一門市（${stores.join('、')}），不能合併`);
  const usageRows = usage.pages.flatMap(page => page.usage);
  const merged = mergeStockReports(stockReports.map(set => ({ rows: set.pages.flatMap(page => page.stock), printed: set.pages[0].facts.printed, time: set.pages[0].facts.printedTime })));
  const stockRows = merged.rows;
  // The oldest stock sheet decides the print-date warnings: its quantities are the least current.
  const first = usage.pages[0]?.facts; const firstStock = stockReports.map(set => set.pages[0].facts).sort((a, b) => a.printed && b.printed ? (dayBefore(a.printed, b.printed) ? -1 : dayBefore(b.printed, a.printed) ? 1 : 0) : 0)[0];
  let storeMatch: Derived['storeMatch'];
  if (first && firstStock) {
    storeMatch = matchStores(first.store, firstStock.store);
    if (storeMatch === 'different') blockers.push(`兩份報表不是同一門市：調劑表「${first.store.label}」、庫存簡表「${firstStock.store.label}」`);
    if (storeMatch === 'unsure' && !decisions.storeConfirmed) blockers.push(`無法自動確認「${first.store.label}」與「${firstStock.store.label}」是同一門市，請在上方確認`);
  }
  const months = first?.period && statMonths(first.period.start, first.period.end) || undefined;
  if (first?.period && !months) blockers.push('統計期間的截止日早於起日');
  if (first?.period && firstStock?.printed && dayBefore(firstStock.printed, first.period.end))
    warnings.push(`庫存簡表列印於 ${formatDay(firstStock.printed)}，早於調劑統計截止日 ${formatDay(first.period.end)}；庫存量是列印當時的數字`);
  const stale: Derived['stale'] = [];
  for (const [kind, facts] of [['inventory', firstStock], ['usage', first]] as const) {
    const days = facts?.printed ? daysBetween(facts.printed, now) : 0;
    if (facts?.printed && days >= STALE_DAYS) {
      stale.push({ kind, printed: facts.printed, days });
      warnings.push(`${label[kind]}列印於 ${formatDay(facts.printed)}，距今已 ${days} 天；輸出的清單可能失真，建議重新列印最新報表`);
    }
  }
  const pendingUsage = usageRows.filter(row => needsReview(row, usageErrors(row)));
  const duplicates = stockDuplicates(stockRows); const duplicated = new Set(duplicates.flat());
  const pendingStock = stockRows.filter(row => needsReview(row, stockErrors(row)) || duplicated.has(row));
  const summary = aggregateUsage(usageRows); const items = aggregateStock(stockRows);
  const sourcesReady = !blockers.length && assemblyComplete(usage) && stockReports.length > 0 && stockReports.every(assemblyComplete) && Boolean(months);
  const ready = sourcesReady && !pendingUsage.length && !pendingStock.length && !summary.unitConflicts.length && !summary.invalid.length;
  const strategy = decisions.safetyStrategy ?? DEFAULT_SAFETY_STRATEGY;
  // null: the 健保碼 lookup could not be loaded, so no code gets the A factor and the list is told so.
  const codes = nhi ?? new Map<string, string>();
  const ordinary = months ? safetyList(summary.items, months, items, false, strategy, undefined, codes) : undefined;
  const partner = ordinary && stock.pages.length && partnerSupplied(unheldOnList(ordinary)) ? { missing: unheldOnList(ordinary) } : undefined;
  const safety = partner ? safetyList(summary.items, months!, items, true, strategy, PARTNER_COVERS[decisions.partnerCover ?? 'standard'], codes) : ordinary;
  if (!nhi && safety?.rows.length) warnings.push(`健保碼對照載入失敗，健保碼 A 開頭品項的建議量未套用 × ${formatFrac(NHI_A_FACTOR)}，安全量與待採量可能偏高；請重新整理頁面後再產生清單`);
  const { dead, empty, selfPay } = slotLists(stockRows, usageCodes(usageRows));
  const listed = new Set(safety?.rows.map(row => row.sku));
  const missing = summary.items.filter(item => !items.has(item.sku)).map(item => ({ sku: item.sku, name: item.name, pages: pagesOf(item.rows), onList: listed.has(item.sku) }));
  const zeroRows = stockRows.filter(row => !row.excluded && parseDecimal(row.qty)?.n === 0n).length;
  const payment = first?.payment; const long = months ? longPeriod(months) : false;
  const reasons: Record<ListKind, string> = { safety: '', dead: '', empty: '' };
  const notReady = !sourcesReady ? '來源報表尚未齊備或有問題' : pendingUsage.length + pendingStock.length ? `還有 ${pendingUsage.length + pendingStock.length} 筆待校對` : summary.unitConflicts.length ? `${summary.unitConflicts.length} 個六碼的單位不一致` : '';
  if (notReady) reasons.safety = reasons.dead = reasons.empty = notReady;
  else {
    reasons.dead = long ? '' : `統計期間 ${months ? formatFrac(months) : '?'} 個月，須大於 2.5 個月才能判斷未使用`;
    reasons.empty = !long ? reasons.dead : empty.length ? '' : '庫存簡表沒有庫存為 0、有儲位且未出現在調劑統計內的品項';
  }
  const available = { safety: !reasons.safety, dead: !reasons.dead, empty: !reasons.empty };
  const period = first?.period ? `${formatDay(first.period.start)}～${formatDay(first.period.end)}` : undefined;
  return { usage, stock, stockReports, stockOverlap: merged.overlap, usageRows, stockRows, blockers, warnings, pendingUsage, pendingStock, summary, duplicates, months, period, payment, storeLabel: first?.store.label ?? firstStock?.store.label ?? '',
    storeMatch, safety, dead, empty, selfPay, zeroRows, stale, partner, missing, ready, available, reasons };
}

export const NO_STOCK = '簡表無此碼';
const show = (value: Frac) => formatFrac(value);
export function listRows(kind: ListKind, data: Derived): string[][] {
  if (kind === 'safety') return (data.safety?.rows ?? []).map(row => { const order = toOrder(row); return [row.sku, row.name, row.stock ? show(row.stock) : NO_STOCK, show(row.a), show(row.ab), show(frac(row.safety)), order ? show(order) : '—']; });
  return kind === 'dead' ? data.dead.map(deadCells) : data.empty.map(row => [row.sku, row.name, row.location]);
}
const slotCells = (row: SlotRow) => [row.sku, row.name + (row.negative ? '\n【負庫存異常】' : ''), row.location, formatQuantity(row.qty)];
const deadCells = (row: SlotRow) => [...slotCells(row), disposition(row)];
/** The self-pay lines printed after the dead stock, cells as on the dead-stock list; their handling is left to a person. */
export const selfPayRows = (data: Derived) => data.selfPay.map(row => [...slotCells(row), SELF_PAY_DISPOSITION]);
/**
 * Cells printed in red, on the safety list only: the name of a 缺貨 code, stock above 4 months of use (OVERSTOCK_MONTHS), and 待採量
 * worth more than LARGE_ORDER at 健保價, which never applies to a (管3)/(管4) controlled drug.
 */
export function listAlerts(kind: ListKind, data: Derived): boolean[][] {
  if (kind !== 'safety') return listRows(kind, data).map(cells => cells.map(() => false));
  return (data.safety?.rows ?? []).map(row => [false, row.shortage, overstock(row), false, false, false, largeOrder(row)]);
}
/** The footer line explaining the red cells of the safety list. */
export const SAFETY_ALERT_NOTE = `紅色：品名保有「缺貨」前綴（供應商缺貨）；紅色粗體：現有庫存量 > 4 倍均月銷，醫院換藥致用量銳減時易逾期耗損；待採量 × 健保價 > ${formatFrac(LARGE_ORDER)} 元，優先採購可更快達免運門檻（(管3)(管4)管制藥只能申請，不標示）。`;
export type SpecContext = { files: Record<'usage' | 'inventory', string[]>; version: number; appVersion: string; time: string };
export function listSpec(kind: ListKind, data: Derived, context: SpecContext): ListSpec {
  const rows = listRows(kind, data); const s = data.safety!;
  const warn = data.stale.length ? `【警語】${data.stale.map(item => `${label[item.kind]}列印於 ${formatDay(item.printed)}（距產生日 ${item.days} 天）`).join('、')}，輸出結果可能失真。` : '';
  const files = (kind: 'usage' | 'inventory') => { const names = context.files[kind]; return names.length > 1 ? `${names[0]} 等 ${names.length} 個檔案` : names[0] ?? ''; };
  const meta = [
    `${data.storeLabel || '門市未填'}  |  統計期間 ${data.period ?? ''}（${data.months ? formatFrac(data.months) : '?'} 個月）  |  給付方式 ${data.payment ?? ''}  |  ${LIST_TITLE[kind]} ${rows.length} 筆${kind === 'dead' && data.selfPay.length ? `（另附自費品 ${data.selfPay.length} 筆）` : ''}`,
    `來源：調劑表 ${files('usage')}（${data.usage.pages.length} 頁）；庫存簡表 ${files('inventory')}（${data.stock.pages.length} 頁）  |  校對版本 ${context.version}  |  樹懶的管理 ${context.appVersion}  |  ${context.time} 產生`,
  ];
  // The header has room for three meta lines, so a partner store's skip and backfill counts replace the tie note.
  const order = () => s.outside ? `A > 8 共 ${s.eligible + s.outside.none + s.outside.low} 筆；合作診所供貨，略過無庫存 ${s.outside.none}、不足 ${formatFrac(s.outside.cover)} 月 ${s.outside.low} 筆，遞補 ${s.outside.filled} 筆；取 K = ${s.k} 筆，依 A 由高到低`
    : `A > 8 共 ${s.eligible} 筆；取 K = ${s.k} 筆，依 A 由高到低（同值依六碼）`;
  if (kind === 'safety') return { title: `${LIST_TITLE.safety} · ${SAFETY_STRATEGIES[s.strategy].name}（係數 ${safetyStrategyRange(s.strategy)}）`, rows, alerts: listAlerts(kind, data), meta: [...meta, `品項數 N = ${s.n}；前 10% = ${s.limit} 筆；${order()}`],
    columns: [{ label: '六編碼', width: 18 }, { label: '品名', width: 68 }, { label: '現有庫存量', width: 22, align: 'right' }, { label: '調劑頻率(/月)', width: 24, align: 'right' }, { label: '均月銷', width: 18, align: 'right' }, { label: '建議安全量', width: 20, align: 'right' }, { label: '待採量', width: 20, align: 'right' }],
    // Formulas are on the web page; the footer keeps only what the reader needs beside the red cells and any risk.
    warning: warn, note: SAFETY_ALERT_NOTE + (s.outside && cmp(s.outside.cover, PARTNER_COVERS.standard) > 0 ? `合作診所遮罩放寬至 ${formatFrac(s.outside.cover)} 個月：本店庫存偏低、確需採購的品項也可能被略過。` : ''),
    empty: `沒有符合的品項：品項數 N = ${s.n}，前 10% 為 ${s.limit} 筆，A > 8 的品項 ${s.eligible} 筆。` };
  if (kind === 'dead') return { title: LIST_TITLE.dead, rows, meta,
    columns: [{ label: '六碼', width: 20 }, { label: '清理後名稱', width: 84 }, { label: '儲位', width: 40 }, { label: '庫存量', width: 24, align: 'right' }, { label: '建議處置', width: 22 }],
    tail: data.selfPay.length ? { heading: SELF_PAY_HEADING, rows: selfPayRows(data) } : undefined,
    warning: warn, note: `呆藥：庫存簡表中庫存量不為 0、且統計期間內未出現在醫品調劑數量統計表的品項，名稱前綴含冷藏、缺貨、追追或名稱含(管4)、(管3)等管制藥標示者依序排前並建議「轉調協銷」，其餘建議「月初退倉」；各組依儲位排序（空白儲位在後）。負庫存依條件列入並標示「負庫存異常」。判斷範圍以匯入的庫存簡表為準。${data.selfPay.length ? '名稱前綴含「自費」的品項不經健保調劑，以灰字附於清單末，建議處置為「待判定」，不計入呆藥筆數；庫存為 0 者不列。' : ''}`,
    empty: '庫存簡表中沒有「庫存量不為 0 且統計期間內未調劑」的品項。' };
  return { title: LIST_TITLE.empty, rows, meta,
    columns: [{ label: '六碼', width: 22 }, { label: '清理後名稱', width: 118 }, { label: '儲位', width: 50 }],
    warning: warn, note: '空位：庫存簡表中庫存量為 0、且統計期間內未出現在醫品調劑數量統計表的品項，依儲位排序；儲位空白者本不佔位，不列入。判斷範圍以匯入的庫存簡表為準。',
    empty: '庫存簡表沒有庫存為 0、有儲位且未出現在調劑統計內的品項。' };
}
