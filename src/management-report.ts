// 樹懶的管理: everything the page shows and prints, derived from the parsed pages and the reviewer's edits.
import { formatQuantity } from './model';
import { aggregateStock, aggregateUsage, assemble, assemblyComplete, cmp, dayBefore, DEFAULT_SAFETY_STRATEGY, formatDay, formatFrac, frac, longPeriod, matchStores, overstock, parseDecimal, partnerSupplied, PARTNER_LIMIT, SAFETY_STRATEGIES, safetyList, safetyStrategyRange, slotLists, statMonths, stockDuplicates, stockErrors, sub, unheldOnList, usageCodes, usageErrors, ZERO,
  type Assembly, type Frac, type SafetyResult, type SafetyRow, type SafetyStrategy, type SlotRow, type StockRow, type UsageRow, type UsageSummary } from './management-model';
import type { ParsedPage } from './management-parser';
import type { ListSpec } from './management-pdf';

export type ListKind = 'safety' | 'dead' | 'empty';
export const LIST_TITLE: Record<ListKind, string> = { safety: '安全量調整及採購建議清單', dead: '呆藥清單', empty: '空位清單' };
/** Reviewer decisions that are not edits of a row. */
export type Decisions = { storeConfirmed: boolean; scopeConfirmed: boolean; zeroConfirmed: boolean; missingAcknowledged: string; safetyStrategy?: SafetyStrategy };
export type Derived = {
  usage: Assembly<ParsedPage>; stock: Assembly<ParsedPage>; usageRows: UsageRow[]; stockRows: StockRow[];
  /** Problems with the sources themselves; any one blocks every list. */
  blockers: string[]; warnings: string[];
  pendingUsage: UsageRow[]; pendingStock: StockRow[]; summary: UsageSummary; duplicates: StockRow[][];
  months?: Frac; period?: string; payment?: string; storeLabel: string; storeMatch?: 'same' | 'different' | 'unsure';
  safety?: SafetyResult; dead: SlotRow[]; empty: SlotRow[]; zeroRows: number;
  /** Set when more than PARTNER_LIMIT codes of the ordinary safety list have no stock line: how many there were. */
  partner?: { missing: number };
  /** Usage codes without any stock line; the ones on the safety list need an explicit acknowledgement. */
  missing: { sku: string; name: string; pages: number[]; onList: boolean }[]; missingKey: string;
  ready: boolean; available: Record<ListKind, boolean>; reasons: Record<ListKind, string>;
};
export const needsReview = <R extends { reviewed: boolean; excluded?: string }>(row: R, errors: string[]) => !row.excluded && (!row.reviewed || errors.length > 0);
const pagesOf = (rows: { origin: { reportPage: number } }[]) => [...new Set(rows.map(row => row.origin.reportPage))].sort((a, b) => a - b);
const label = { usage: '醫品調劑數量統計表', inventory: '庫存簡表' };

export function derive(pages: ParsedPage[], rejected: { kind: 'usage' | 'inventory'; reason: string }[], decisions: Decisions): Derived {
  const usage = assemble(pages.filter(page => page.kind === 'usage')); const stock = assemble(pages.filter(page => page.kind === 'inventory'));
  const blockers: string[] = []; const warnings: string[] = [];
  for (const item of rejected) blockers.push(`${label[item.kind]}：${item.reason}`);
  for (const [kind, set] of [['usage', usage], ['inventory', stock]] as const) {
    if (!set.pages.length) { blockers.push(`尚未取得可用的${label[kind]}`); continue; }
    if (set.totals.length > 1) blockers.push(`${label[kind]}各頁的總頁數不同（${set.totals.join('、')}），不是同一份報表`);
    if (set.metas.length > 1) blockers.push(`${label[kind]}各頁的門市、期間、給付方式或列印日期不一致，不能混算`);
    if (set.missing.length) blockers.push(`${label[kind]}缺少第 ${set.missing.join('、')} 頁（共 ${Math.max(...set.totals)} 頁）；缺頁不能當成沒有資料`);
    for (const [a, b] of set.conflicts) blockers.push(`${label[kind]}第 ${a.reportPage} 頁出現兩次且內容不同（第 ${a.file + 1} 份第 ${a.filePage} 頁、第 ${b.file + 1} 份第 ${b.filePage} 頁），請移除錯誤的檔案`);
  }
  const usageRows = usage.pages.flatMap(page => page.usage); const stockRows = stock.pages.flatMap(page => page.stock);
  const first = usage.pages[0]?.facts; const firstStock = stock.pages[0]?.facts;
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
  const pendingUsage = usageRows.filter(row => needsReview(row, usageErrors(row)));
  const duplicates = stockDuplicates(stockRows); const duplicated = new Set(duplicates.flat());
  const pendingStock = stockRows.filter(row => needsReview(row, stockErrors(row)) || duplicated.has(row));
  const summary = aggregateUsage(usageRows); const items = aggregateStock(stockRows);
  const sourcesReady = !blockers.length && assemblyComplete(usage) && assemblyComplete(stock) && Boolean(months);
  const ready = sourcesReady && !pendingUsage.length && !pendingStock.length && !summary.unitConflicts.length && !summary.invalid.length;
  const strategy = decisions.safetyStrategy ?? DEFAULT_SAFETY_STRATEGY;
  const ordinary = months ? safetyList(summary.items, months, items, false, strategy) : undefined;
  const partner = ordinary && stock.pages.length && partnerSupplied(unheldOnList(ordinary)) ? { missing: unheldOnList(ordinary) } : undefined;
  const safety = partner ? safetyList(summary.items, months!, items, true, strategy) : ordinary;
  const { dead, empty } = slotLists(stockRows, usageCodes(usageRows));
  const listed = new Set(safety?.rows.map(row => row.sku));
  const missing = summary.items.filter(item => !items.has(item.sku)).map(item => ({ sku: item.sku, name: item.name, pages: pagesOf(item.rows), onList: listed.has(item.sku) }));
  const missingKey = missing.filter(item => item.onList).map(item => item.sku).join(',');
  const zeroRows = stockRows.filter(row => !row.excluded && parseDecimal(row.qty)?.n === 0n).length;
  const payment = first?.payment; const long = months ? longPeriod(months) : false;
  const reasons: Record<ListKind, string> = { safety: '', dead: '', empty: '' };
  const notReady = !sourcesReady ? '來源報表尚未齊備或有問題' : pendingUsage.length + pendingStock.length ? `還有 ${pendingUsage.length + pendingStock.length} 筆待校對` : summary.unitConflicts.length ? `${summary.unitConflicts.length} 個六碼的單位不一致` : '';
  if (notReady) reasons.safety = reasons.dead = reasons.empty = notReady;
  else {
    if (missingKey && decisions.missingAcknowledged !== missingKey) reasons.safety = `清單內有 ${missingKey.split(',').length} 個六碼在庫存簡表找不到，請先核對並確認`;
    const slot = !long ? `統計期間 ${months ? formatFrac(months) : '?'} 個月，須大於 2.5 個月才能判斷未使用` : payment !== '全部' ? `給付方式為「${payment}」，範圍外的使用會被誤判為未使用；請以「全部」重新列印調劑表` : !decisions.scopeConfirmed ? '請先確認庫存簡表涵蓋要評估的全部儲位' : '';
    reasons.dead = slot; reasons.empty = slot || (!zeroRows && !decisions.zeroConfirmed ? '庫存簡表沒有任何零庫存列；請以包含零庫存的條件重新列印，或確認列印時已包含零庫存' : '');
  }
  const available = { safety: !reasons.safety, dead: !reasons.dead, empty: !reasons.empty };
  const period = first?.period ? `${formatDay(first.period.start)}～${formatDay(first.period.end)}` : undefined;
  return { usage, stock, usageRows, stockRows, blockers, warnings, pendingUsage, pendingStock, summary, duplicates, months, period, payment, storeLabel: first?.store.label ?? firstStock?.store.label ?? '',
    storeMatch, safety, dead, empty, zeroRows, partner, missing, missingKey, ready, available, reasons };
}

export const NO_STOCK = '簡表無此碼';
const show = (value: Frac) => formatFrac(value);
/** Safety minus stock on hand, 0 when the stock already covers it; unknown when the stock sheet has no line for the code. */
export function toOrder(row: SafetyRow): Frac | undefined {
  if (!row.stock) return undefined; const need = sub(frac(row.safety), row.stock); return cmp(need, ZERO) > 0 ? need : ZERO;
}
export function listRows(kind: ListKind, data: Derived): string[][] {
  if (kind === 'safety') return (data.safety?.rows ?? []).map(row => { const order = toOrder(row); return [row.sku, row.name, row.stock ? show(row.stock) : NO_STOCK, show(row.a), show(row.ab), show(frac(row.safety)), order ? show(order) : '—']; });
  const rows = kind === 'dead' ? data.dead : data.empty;
  return rows.map(row => kind === 'dead' ? [row.sku, row.name + (row.negative ? '\n【負庫存異常】' : ''), row.location, formatQuantity(row.qty)] : [row.sku, row.name, row.location]);
}
/** Cells printed in red heavy type: on the safety list, stock above 4 months of use (OVERSTOCK_MONTHS). */
export function listAlerts(kind: ListKind, data: Derived): boolean[][] {
  if (kind !== 'safety') return listRows(kind, data).map(cells => cells.map(() => false));
  return (data.safety?.rows ?? []).map(row => [false, false, overstock(row), false, false, false, false]);
}
export type SpecContext = { files: Record<'usage' | 'inventory', string[]>; version: number; appVersion: string; time: string };
export function listSpec(kind: ListKind, data: Derived, context: SpecContext): ListSpec {
  const rows = listRows(kind, data); const s = data.safety!;
  const files = (kind: 'usage' | 'inventory') => { const names = context.files[kind]; return names.length > 1 ? `${names[0]} 等 ${names.length} 個檔案` : names[0] ?? ''; };
  const meta = [
    `${data.storeLabel || '門市未填'}  |  統計期間 ${data.period ?? ''}（${data.months ? formatFrac(data.months) : '?'} 個月）  |  給付方式 ${data.payment ?? ''}  |  ${LIST_TITLE[kind]} ${rows.length} 筆`,
    `來源：調劑表 ${files('usage')}（${data.usage.pages.length} 頁）；庫存簡表 ${files('inventory')}（${data.stock.pages.length} 頁）  |  校對版本 ${context.version}  |  樹懶的管理 ${context.appVersion}  |  ${context.time} 產生`,
  ];
  // The header has room for three meta lines, so a partner store's skip and backfill counts replace the tie note.
  const order = () => s.outside ? `A > 8 共 ${s.eligible + s.outside.none + s.outside.low} 筆；合作診所供貨，略過無庫存 ${s.outside.none}、不足 0.1 月 ${s.outside.low} 筆，遞補 ${s.outside.filled} 筆；取 K = ${s.k} 筆，依 A 由高到低`
    : `A > 8 共 ${s.eligible} 筆；取 K = ${s.k} 筆，依 A 由高到低（同值依六碼）`;
  if (kind === 'safety') return { title: `${LIST_TITLE.safety} · ${SAFETY_STRATEGIES[s.strategy].name}`, rows, alerts: listAlerts(kind, data), meta: [...meta, `品項數 N = ${s.n}；前 10% = ${s.limit} 筆；${order()}`],
    columns: [{ label: '六編碼', width: 18 }, { label: '品名', width: 68 }, { label: '現有庫存量', width: 22, align: 'right' }, { label: '調劑頻率(/月)', width: 24, align: 'right' }, { label: '均月銷', width: 18, align: 'right' }, { label: '建議安全量', width: 20, align: 'right' }, { label: '待採量', width: 20, align: 'right' }],
    note: `${SAFETY_STRATEGIES[s.strategy].name}（係數 ${safetyStrategyRange(s.strategy)}）。調劑頻率 A = 合計次數 ÷ 統計月數；每次用量 B = 四捨五入（合計數量 ÷ 合計次數）；均月銷 = A × B。建議安全量 = 無條件進位（均月銷 × 係數）；係數依本清單 A 排名：前 1/3 為 ${formatFrac(SAFETY_STRATEGIES[s.strategy].maximum)}，其餘依名次線性降至末位 ${formatFrac(SAFETY_STRATEGIES[s.strategy].minimum)}（同 A 同係數）；品名有「缺貨」前綴者係數 +1。待採量 = 建議安全量 − 現有庫存量（不足 0 記 0）。紅色粗體為現有庫存量 > 4 倍均月銷：醫院換藥致用量銳減時易逾期耗損。A、均月銷顯示兩位小數，以完整精度計算。現有庫存量為同碼各儲位合計；` + (data.partner ? `同值依六碼。合作診所供貨：一般規則下清單內有 ${data.partner.missing} 個六碼簡表無紀錄或庫存合計為 0（> ${PARTNER_LIMIT}）；這些及庫存不足 0.1 個月用量（含負庫存）者視為合作診所供應，由後一位遞補，N 不變。` : '「簡表無此碼」表示這份庫存簡表沒有該碼，不代表庫存為 0，待採量印「—」；名稱取自調劑表，可能被截短。'),
    empty: `沒有符合的品項：品項數 N = ${s.n}，前 10% 為 ${s.limit} 筆，A > 8 的品項 ${s.eligible} 筆。` };
  if (kind === 'dead') return { title: LIST_TITLE.dead, rows, meta,
    columns: [{ label: '六碼', width: 20 }, { label: '清理後名稱', width: 104 }, { label: '儲位', width: 40 }, { label: '庫存量', width: 26, align: 'right' }],
    note: `呆藥：庫存簡表中庫存量不為 0、且統計期間內未出現在醫品調劑數量統計表的品項，依儲位排序（空白儲位在後）。負庫存依條件列入並標示「負庫存異常」。判斷依據為使用者確認的庫存範圍。`,
    empty: '庫存簡表中沒有「庫存量不為 0 且統計期間內未調劑」的品項。' };
  return { title: LIST_TITLE.empty, rows, meta,
    columns: [{ label: '六碼', width: 22 }, { label: '清理後名稱', width: 118 }, { label: '儲位', width: 50 }],
    note: `空位：庫存簡表中庫存量為 0、且統計期間內未出現在醫品調劑數量統計表的品項，依儲位排序（空白儲位在後）。${data.zeroRows ? '' : '這份庫存簡表沒有零庫存列，結果依使用者確認「列印時已包含零庫存」。'}`,
    empty: data.zeroRows ? '庫存簡表的零庫存品項都在統計期間內有調劑紀錄，沒有空位。' : '庫存簡表沒有任何零庫存列（使用者已確認列印時包含零庫存），因此沒有空位。' };
}
