import './style.css';
import './management.css';
declare const __APP_VERSION__: string;
const appVersion = __APP_VERSION__;
import { formatQuantity, LIMITS } from './model';
import { autoExclusion, COLD_FACTOR, CONTROLLED_FACTOR, DEFAULT_SAFETY_STRATEGY, formatDay, formatFrac, matchStores, PARTNER_COVERS, SAFETY_STRATEGIES, safetyStrategyRange, SIX, stockErrors, usageErrors, type SafetyStrategy, type StockRow, type UsageRow } from './management-model';
import { KIND_LABEL, parsePage, type ParsedPage, type ReportKind } from './management-parser';
import { derive, LIST_TITLE, listRows, listSpec, type Decisions, type Derived, type ListKind } from './management-report';
import { feedbackKey, feedbackRecord, sendFeedback, worthSending } from './management-feedback';
import { FEEDBACK_ENDPOINT } from './feedback-config';
import { DocumentSource } from './source';
import { cropCanvas, rotateCanvas } from './geometry';

const app = document.querySelector<HTMLDivElement>('#app')!;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const icon = (name: 'chart' | 'upload' | 'file' | 'arrow') => {
  const paths = { chart: '<path d="M4 3v18h17M8 17v-5m5 5V7m5 10V4"/>', upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 15v5h16v-5"/>', file: '<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h5"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>' };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
const KINDS: ReportKind[] = ['inventory', 'usage'];
const LISTS: ListKind[] = ['safety', 'dead', 'empty'];
const PER_PAGE = 25;
/** Text-only PDFs, never OCR: a stock sheet printed with zero stock runs to ~150 pages before the usage report is added. */
const MAX_PAGES = 400;
type Entry = { kind: ReportKind; source: DocumentSource; hash: string };
type Output = { bytes: Uint8Array; url: string; version: number; pages: number; rows: number };
// entries: files in import order; a row's origin.file is its index here. Changing the files clears the results.
let entries: Entry[] = []; let adding = false; let parsing = false; let cancelRequested = false; let parsed = false; let documentNumber = 0;
let pages: ParsedPage[] = []; let rejected: { kind: ReportKind; reason: string }[] = []; let progress = { done: 0, total: 0, message: '' };
let decisions: Decisions = { storeConfirmed: false, safetyStrategy: DEFAULT_SAFETY_STRATEGY };
let data: Derived | undefined; let attention = new Set<string>();
/** Every row as parsed, before the reviewer's edits; the review feedback compares against it. */
let originals = new Map<string, UsageRow | StockRow>(); let reviewPage = 0; let errorMessage = '';
/** The last review record sent (without its send time), and what the page says about the send. */
let feedbackSent = ''; let feedbackStatus = '';
// generation is the review revision; any change to sources, rows or decisions bumps it and drops every PDF.
let generation = 0; let outputs: Partial<Record<ListKind, Output>> = {}; let generating = false;
const selected: Record<ListKind, boolean> = { safety: false, dead: false, empty: false };
let fontBytes: Promise<Uint8Array> | undefined;
const busy = () => adding || parsing || generating;

app.innerHTML = `
  <header class="topbar"><a class="brand" href="${import.meta.env.BASE_URL}" aria-label="樹懶的管理，返回樹懶的工作主目錄">${icon('chart')}<span>樹懶的管理<span class="brand-sub">← 返回主目錄</span></span></a><a class="inventory-home" href="${import.meta.env.BASE_URL}">← 主目錄</a><span class="local-badge"><i></i>檔案留在你的裝置</span></header>
  <main>
    <section class="intro"><div><div class="eyebrow">STOCK LEVELS, MADE CLEAR</div><h1>越資深，<br class="mobile-break">越極簡。</h1><p>客人因為短欠而流失？欠貨區塞滿？還是廠商突襲般的斷貨讓你手忙腳亂？<br>看看你的客人都吃什麼主菜，進行 80-20 重點準備。聰明，才有資格懶。</p></div><div class="paper-mark"><span>A4</span><i></i><i></i><i></i><b>COUNT · RANK · PLAN</b></div></section>
    <nav class="steps" aria-label="處理步驟"><div data-step="1" class="active"><span>01</span>匯入報表</div><div data-step="2"><span>02</span>核對來源</div><div data-step="3"><span>03</span>產生清單</div></nav>
    <div class="workspace mg-inputs">
      ${KINDS.map(kind => `<section class="card"><div class="section-heading"><h2>${KIND_LABEL[kind]}</h2><span class="small-label">${kind === 'inventory' ? '可加入多份、分次補頁' : '一次匯入一份'}</span></div>
        <input id="input-${kind}" type="file" accept="application/pdf" ${kind === 'inventory' ? 'multiple' : ''} hidden>
        <div id="drop-${kind}" data-kind="${kind}" class="drop-zone mg-drop" role="button" tabindex="0" aria-label="選擇或拖放${KIND_LABEL[kind]} PDF"><div class="upload-icon">${icon('upload')}</div><h3>把${KIND_LABEL[kind]}拖到這裡</h3><p>或點選，從裝置選擇 PDF${kind === 'inventory' ? '（可多選）' : ''}</p><span class="file-types">系統列印的 PDF</span></div>
        <ol id="files-${kind}" class="file-list" aria-label="${KIND_LABEL[kind]}檔案" hidden></ol>
        <div class="import-note"><span>${kind === 'inventory' ? '如何取得庫存簡表？' : '如何取得調劑數量統計表？'}</span><p>${kind === 'inventory' ? '在樺穎的 IM1C1 設定簡表範圍後「列印至 PDF」。主檔之外另印的補件簡表可一起匯入，同六碼同儲位重疊的列只計一次，以較晚列印的為準。要產生呆藥與空位清單時，範圍須涵蓋要評估的全部儲位，否則空位清單會不完整；條件不必排除零庫存品項。' : '依統計期間列印醫品調劑數量統計表至 PDF，給付方式選「全部」。統計期間須大於 2.5 個月，才能產生呆藥與空位清單；空位另須庫存為零、儲位不空白，且期間內未調劑。'}</p></div>
      </section>`).join('')}
    </div>
    <section class="card mg-start"><div id="start-row" class="start-row"><span id="queue-summary" aria-live="polite"></span><button id="clear-all" class="button quiet">全部移除</button><button id="start" class="button primary"><span id="start-label">開始解析</span>${icon('arrow')}</button></div>
      <div id="progress" class="mg-progress" hidden><div class="progress-line"><strong id="progress-title"></strong><span id="progress-counter"></span></div><div class="progress-track"><div id="progress-bar"></div></div><p id="progress-description" aria-live="polite"></p><button id="cancel" class="button quiet">取消解析</button></div>
      <div id="error" role="alert" class="error-box" hidden></div>
      <div class="import-note"><span>合計最多 ${MAX_PAGES} 頁・200 MB</span><p>只接受系統直接列印、沒有圖片的 PDF（掃描檔請改用原系統重新列印）。每頁都須印有表頭、門市、頁次；調劑表另須印有統計期間與給付方式。系統先讀每份檔案的第一頁核對報表與門市，再讀其餘頁面。同一檔案不會重複加入；重複匯入的相同頁只計一次。</p></div></section>
    <section id="sources" class="card review-card" hidden></section>
    <section id="review" class="card review-card" hidden></section>
    <section id="lists" class="card export-card" hidden></section>
    <footer class="footer"><span>樹懶的管理 · 依調劑量規劃庫存。 <span id="app-version">${appVersion}</span></span><span>瀏覽器內解析 · 報表不上傳 · 不寫入撥補系統</span></footer>
  </main>
  <dialog id="ask-dialog"><div class="dialog-heading"><h2 id="ask-title"></h2></div><div id="ask-text" class="resolution-text"></div><label id="ask-input-label" class="mg-reason" hidden>理由<input id="ask-input" maxlength="120"></label><div class="resolution-actions"><button id="ask-cancel" class="button secondary"></button><button id="ask-continue" class="button primary"></button></div></dialog>
  <dialog id="trace-dialog"><div class="dialog-heading"><h2 id="trace-title">原圖對照</h2><button id="close-trace" class="icon-button" aria-label="關閉原圖">×</button></div><div id="trace-content"></div></dialog>
  <dialog id="pdf-dialog"><div class="dialog-heading"><h2 id="pdf-title">清單預覽</h2><button id="close-pdf" class="icon-button" aria-label="關閉預覽">×</button></div><p class="preview-note">列印時選擇 A4、原尺寸 100%。若未顯示預覽，可<a id="pdf-open-tab" href="#" target="_blank" rel="noopener">在新分頁開啟</a>或直接下載 PDF。</p><iframe id="pdf-frame" title="清單 PDF 預覽"></iframe><button id="dialog-download" class="button primary">下載 PDF</button></dialog>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function invalidate() {
  generation++;
  for (const output of Object.values(outputs)) URL.revokeObjectURL(output.url);
  outputs = {};
  const dialog = el<HTMLDialogElement>('pdf-dialog'); if (dialog.open) dialog.close(); el<HTMLIFrameElement>('pdf-frame').removeAttribute('src');
}
function showError(message: string) { errorMessage = message; el('error').hidden = !message; el('error').textContent = message; }
const fileName = (index: number) => entries[index]?.source.file.name ?? '';
const where = (origin: UsageRow['origin']) => `第 ${origin.file + 1} 份・檔案第 ${origin.filePage} 頁（報表第 ${origin.reportPage} 頁）`;
const pageCount = () => entries.reduce((total, entry) => total + entry.source.pages, 0);
const byteCount = () => entries.reduce((total, entry) => total + entry.source.file.size, 0);

function renderInputs() {
  for (const kind of KINDS) {
    const list = entries.map((entry, index) => ({ entry, index })).filter(item => item.entry.kind === kind);
    el(`files-${kind}`).hidden = !list.length;
    el(`files-${kind}`).innerHTML = list.map(({ entry, index }) => `<li class="file-details"><span class="file-index">${index + 1}</span>${icon('file')}<div><strong>${escape(entry.source.file.name)}</strong><span>${entry.source.pages} 頁・${(entry.source.file.size / 1024 / 1024).toFixed(1)} MB・SHA-256 ${entry.hash.slice(0, 12)}…</span></div><button type="button" class="text-button file-remove" data-remove="${index}" aria-label="移除 ${escape(entry.source.file.name)}">移除</button></li>`).join('');
    el(`drop-${kind}`).classList.toggle('disabled', busy());
  }
  const counts = KINDS.map(kind => entries.filter(entry => entry.kind === kind).length);
  el('queue-summary').textContent = entries.length ? `庫存簡表 ${counts[0]} 份、調劑表 ${counts[1]} 份・共 ${pageCount()} 頁` : '請在兩個區塊各加入至少一份 PDF。';
  el<HTMLButtonElement>('start').disabled = busy() || !counts.every(Boolean) || parsed;
  el<HTMLButtonElement>('clear-all').disabled = busy() || !entries.length;
  el('start-label').textContent = parsing ? '解析中…' : parsed ? '已完成解析' : '開始解析';
  document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.disabled = busy());
  el('progress').hidden = !parsing && !progress.total;
  el('progress-title').textContent = parsing ? '正在解析' : parsed ? '解析完成' : '解析中止';
  el('progress-counter').textContent = progress.total ? `${progress.done} / ${progress.total} 頁` : '';
  el('progress-bar').style.width = progress.total ? `${progress.done / progress.total * 100}%` : '0%';
  el('progress-description').textContent = progress.message; el('cancel').hidden = !parsing;
}

/** Changing the files after parsing discards the review; ask first. */
const confirmDiscard = () => !parsed && !pages.length ? Promise.resolve(true) : ask('清除目前結果？', '<p>加入或移除檔案會清除目前的解析與校對結果，之後需重新按「開始解析」。</p>', '保留目前結果', '清除並更新檔案');
function resetResults() {
  documentNumber++; cancelRequested = true; parsed = false; pages = []; rejected = []; data = undefined; attention = new Set(); originals = new Map(); feedbackStatus = ''; reviewPage = 0; progress = { done: 0, total: 0, message: '' };
  decisions = { storeConfirmed: false, safetyStrategy: decisions.safetyStrategy }; invalidate();
}
async function sha256(file: File) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join(''); }
let pendingFiles: { kind: ReportKind; file: File }[] = [];
async function addFiles(kind: ReportKind, files: File[]) {
  if (adding) { pendingFiles.push(...files.map(file => ({ kind, file }))); return; }
  if (busy() || !files.length || !(await confirmDiscard())) return;
  adding = true; pendingFiles = files.map(file => ({ kind, file })); showError(''); resetResults(); render(); const problems: string[] = [];
  try {
    while (pendingFiles.length) {
      const { kind, file } = pendingFiles.shift()!; let opened: DocumentSource | undefined;
      try {
        const usage = kind === 'usage' && entries.find(entry => entry.kind === 'usage');
        if (usage) throw new Error(`醫品調劑數量統計表一次只匯入一份；請先移除「${usage.source.file.name}」再加入。`);
        if (byteCount() + file.size > LIMITS.bytes) throw new Error('檔案合計超過 200 MB，請分批處理。');
        const hash = await sha256(file); const same = entries.find(entry => entry.hash === hash);
        if (same) throw new Error(`與已加入的「${same.source.file.name}」內容相同（SHA-256 一致），不重複加入。`);
        opened = await DocumentSource.open(file, MAX_PAGES);
        if (!opened.pdf) throw new Error('只接受系統列印的 PDF，不接受圖片檔。');
        if (pageCount() + opened.pages > MAX_PAGES) throw new Error(`檔案合計超過 ${MAX_PAGES} 頁，請分批處理。`);
        entries.push({ kind, source: opened, hash }); opened = undefined; renderInputs();
      } catch (error) { problems.push(`${file.name}：${error instanceof Error ? error.message : '無法開啟檔案。'}`); }
      finally { await opened?.dispose(); }
    }
  } finally { adding = false; }
  showError(problems.join('\n')); render();
}
async function removeFile(index: number) {
  if (busy() || !entries[index] || !(await confirmDiscard())) return;
  resetResults(); const [removed] = entries.splice(index, 1); await removed.source.dispose(); showError(''); render();
}
async function clearAll() {
  if (busy() || !(await confirmDiscard())) return;
  resetResults(); const old = entries; entries = []; await Promise.all(old.map(entry => entry.source.dispose())); showError(''); render();
}

/** First page of every file, store check, then the remaining pages. */
async function parseAll() {
  if (busy() || parsed) return;
  resetResults(); cancelRequested = false; parsing = true; showError(''); const docNo = documentNumber; const current = () => docNo === documentNumber && !cancelRequested;
  const order = [...entries.map((_, file) => ({ file, page: 1 })), ...entries.flatMap((entry, file) => Array.from({ length: entry.source.pages - 1 }, (_, i) => ({ file, page: i + 2 })))];
  progress = { done: 0, total: order.length, message: '讀取各檔案第一頁，核對報表與門市' }; render();
  try {
    for (const [step, { file, page }] of order.entries()) {
      if (!current()) return;
      const entry = entries[file]; const result = parsePage(await entry.source.textPage(page), entry.kind, file, page);
      if (!current()) return;
      progress.done = step + 1;
      if (result.ok) pages.push(result.page);
      else if (page === 1) { showError(`${entry.source.file.name}（${KIND_LABEL[entry.kind]}區）第 1 頁：${result.reason}。已停止解析，請移除或更換這份檔案。`); progress.message = '第一頁核對未通過'; return; }
      else rejected.push({ kind: entry.kind, reason: `第 ${file + 1} 份「${entry.source.file.name}」第 ${page} 頁：${result.reason}` });
      if (step === entries.length - 1) {
        const stop = await checkFirstPages(); if (!current()) return;
        if (stop) { showError(stop); progress.message = '門市核對未通過'; return; }
        progress.message = '讀取其餘頁面';
      }
      if (step % 4 === 0) { renderInputs(); await new Promise(resolve => setTimeout(resolve)); }
    }
    parsed = true; progress.message = `共讀取 ${pages.length} 頁${rejected.length ? `，${rejected.length} 頁無法使用` : ''}`; admit();
  } catch (error) { if (current()) showError(error instanceof Error ? error.message : '解析失敗，請重試。'); }
  finally { if (docNo === documentNumber) { parsing = false; render(); if(parsed)scrollToNextAction(); } }
}
/** Wait until rendered cards have their final layout before moving focus and the viewport. */
let navigationFrame = 0;
function scrollToCard(id: 'sources' | 'review' | 'lists') {
  cancelAnimationFrame(navigationFrame);
  const docNo = documentNumber;
  navigationFrame = requestAnimationFrame(() => {
    navigationFrame = requestAnimationFrame(() => {
      const card = el(id);
      if (docNo !== documentNumber || !parsed || card.hidden || document.querySelector('dialog[open]')) return;
      // Focus must leave the clicked button before scrolling, or browser focus restoration can undo the move.
      card.tabIndex = -1;
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  });
}
/** Move to the next card that needs a decision after parsing or review. */
function scrollToNextAction() {
  if(!data)return;
  const target=data.blockers.length||(data.storeMatch==='unsure'&&!decisions.storeConfirmed)?'sources':reviewItems().some(item=>!reviewOk(item))?'review':'lists';
  scrollToCard(target);
}
/** Confirmation and exclusion can finish the review without another parse. */
function advanceWhenReviewComplete() {
  if (parsed && !reviewItems().some(item => !reviewOk(item))) scrollToNextAction();
}
/** Files of different stores stop at once; titles that cannot be matched automatically are put to the user. */
async function checkFirstPages(): Promise<string | undefined> {
  const firsts = pages.filter(page => page.filePage === 1);
  const base = firsts.find(page => page.kind === 'usage') ?? firsts[0]; if (!base) return undefined;
  const list = firsts.map(page => ({ page, match: matchStores(base.facts.store, page.facts.store) }));
  const names = `<ul class="store-list">${list.map(({ page }) => `<li><span>第 ${page.file + 1} 份・${escape(fileName(page.file))}</span><strong>${escape(page.facts.store.label)}</strong></li>`).join('')}</ul>`;
  if (list.some(item => item.match === 'different')) return `各檔案的門市不同，已停止解析：${list.map(({ page }) => `「${fileName(page.file)}」${page.facts.store.label}`).join('、')}。請移除不屬於同一門市的檔案。`;
  if (list.every(item => item.match === 'same')) return undefined;
  const same = await ask('確認是同一門市', `<p>兩種報表的門市寫法不同，無法由門市編號與店名自動確認一致。請對照原始報表後決定。</p>${names}`, '不是，停止解析', '是同一門市，繼續');
  decisions.storeConfirmed = same; return same ? undefined : '已停止解析：未確認各檔案為同一門市。';
}
/** Rows that need a look stay in the review list after they are confirmed, so the decision can be seen and undone. */
function admit() {
  data = derive(pages, rejected, decisions);
  originals = new Map([...data.usageRows, ...data.stockRows].map(row => [row.id, { ...row, notes: [...row.notes] }]));
  for (const row of [...data.pendingUsage, ...data.pendingStock, ...data.summary.unitConflicts.flatMap(c => c.rows), ...data.duplicates.flat()]) attention.add(row.id);
  for (const row of [...data.usageRows, ...data.stockRows]) if (row.excluded) attention.add(row.id);
}

/** A two-button question; with `reason`, the answer is the typed reason (required). Escape or closing counts as cancel. */
function dialog(title: string, html: string, cancel: string, ok: string, reason: boolean): Promise<string | undefined> {
  const box = el<HTMLDialogElement>('ask-dialog'); el('ask-title').textContent = title; el('ask-text').innerHTML = html; el('ask-cancel').textContent = cancel; el('ask-continue').textContent = ok;
  el('ask-input-label').hidden = !reason; const input = el<HTMLInputElement>('ask-input'); input.value = '';
  return new Promise(resolve => {
    const done = (value: string | undefined) => { box.removeEventListener('close', onClose); if (box.open) box.close(); resolve(value); };
    const onClose = () => done(undefined); box.addEventListener('close', onClose);
    el('ask-continue').onclick = () => { const text = input.value.trim(); if (reason && !text) { input.focus(); return; } done(reason ? text : 'ok'); };
    el('ask-cancel').onclick = () => done(undefined); box.showModal(); (reason ? input : el<HTMLButtonElement>('ask-cancel')).focus();
  });
}
const ask = async (title: string, html: string, cancel: string, ok: string) => Boolean(await dialog(title, html, cancel, ok, false));

// ---- Rendering ---------------------------------------------------------------
/** `recompute: false` is for view-only changes (review page, list choice, feedback status): the derived data is reused. */
function render(recompute = true) {
  renderInputs();
  if (recompute || !data) data = parsed || pages.length ? derive(pages, rejected, decisions) : undefined;
  renderSources(); renderReview(); renderLists();
  const step = data?.ready ? 3 : data ? 2 : 1;
  document.querySelectorAll<HTMLElement>('[data-step]').forEach(item => item.classList.toggle('active', Number(item.dataset.step) === step));
  if (import.meta.env.DEV) { let qa = el('qa-state'); if (!qa) { qa = document.createElement('output'); qa.id = 'qa-state'; qa.hidden = true; document.body.append(qa); } qa.textContent = JSON.stringify(qaSnapshot()); }
}
function renderSources() {
  const section = el('sources'); section.hidden = !data;
  if (!data) return;
  const stale = (kind: ReportKind) => data!.stale.find(item => item.kind === kind);
  const printedOf = (f: ParsedPage['facts'], kind: ReportKind) => { const old = stale(kind); const day = f.printed;
    return (day ? `${day.y}/${day.m}/${day.d}` : '未印') + (old && day && formatDay(old.printed) === formatDay(day) ? `・<b class="mg-bad">距今 ${old.days} 天，結果可能失真</b>` : ''); };
  const pagesOf = (set: Derived['stock']) => `${set.pages.length} / ${Math.max(...set.totals)} 頁${set.missing.length ? `・<b class="mg-bad">缺第 ${set.missing.join('、')} 頁</b>` : '・齊全'}${set.duplicates.length ? `・重複匯入 ${set.duplicates.length} 頁已只計一次` : ''}`;
  const clock = (seconds?: number) => seconds === undefined ? '' : ` ${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}`;
  const facts = (kind: ReportKind) => { const set = kind === 'usage' ? data!.usage : data!.stock; const page = set.pages[0]; const rows = kind === 'usage' ? data!.usageRows : data!.stockRows;
    if (!page) return `<div class="mg-source"><h3>${KIND_LABEL[kind]}</h3><p class="issue-text">尚未取得可用頁面</p></div>`;
    const f = page.facts;
    return `<div class="mg-source"><h3>${KIND_LABEL[kind]}</h3><dl>
      <dt>門市</dt><dd>${escape(f.store.label)}${f.warehouse ? `（庫別 ${escape(f.warehouse)}）` : ''}</dd>
      ${kind === 'usage' ? `<dt>統計期間</dt><dd>${escape(data!.period ?? '')}${data!.months ? `・${formatFrac(data!.months)} 個月` : ''}</dd><dt>給付方式</dt><dd>${escape(f.payment ?? '')}</dd>` : ''}
      ${kind === 'inventory' && data!.stockReports.length > 1 ? data!.stockReports.map((report, i) => `<dt>第 ${i + 1} 份報表</dt><dd>${printedOf(report.pages[0].facts, kind)}${clock(report.pages[0].facts.printedTime)}・${pagesOf(report)}</dd>`).join('') + (data!.stockOverlap ? `<dt>合併</dt><dd>重疊 ${data!.stockOverlap} 列（同六碼同儲位）只計一次</dd>` : '')
        : `<dt>列印日期</dt><dd>${printedOf(f, kind)}</dd><dt>頁面</dt><dd>${pagesOf(kind === 'usage' ? set : data!.stockReports[0])}</dd>`}
      <dt>明細</dt><dd>${rows.length} 列${rows.filter(r => r.excluded).length ? `（排除 ${rows.filter(r => r.excluded).length} 列）` : ''}${kind === 'usage' ? `・${data!.summary.items.length} 個六碼` : `・零庫存 ${data!.zeroRows} 列`}</dd></dl></div>`; };
  const storeAsk = data.storeMatch === 'unsure' ? `<label class="checkbox-label mg-confirm"><input id="store-confirm" type="checkbox" ${decisions.storeConfirmed ? 'checked' : ''}>我已對照原始報表，確認「${escape(data.usage.pages[0]?.facts.store.label ?? '')}」與「${escape(data.stock.pages[0]?.facts.store.label ?? '')}」是同一門市</label>` : '';
  section.innerHTML = `<div class="section-heading"><div><span class="eyebrow">SOURCE CHECK</span><h2>來源核對</h2></div><span class="small-label">${data.storeMatch === 'same' ? '門市編號與店名一致' : ''}</span></div>
    <div class="mg-sources">${facts('inventory')}${facts('usage')}</div>
    ${data.blockers.length ? `<div class="error-box">${data.blockers.map(escape).join('\n')}</div>` : ''}${storeAsk}
    ${data.warnings.length ? `<div class="mg-warning${data.stale.length ? ' mg-stale-warning' : ''}">${data.warnings.map(escape).join('\n')}</div>` : ''}`;
}
type ReviewItem = { kind: 'usage'; row: UsageRow } | { kind: 'stock'; row: StockRow };
function reviewItems(): ReviewItem[] {
  if (!data) return [];
  const usage = data.usageRows.filter(row => attention.has(row.id) && !row.excluded).map(row => ({ kind: 'usage' as const, row }));
  const stock = data.stockRows.filter(row => attention.has(row.id) && !row.excluded).map(row => ({ kind: 'stock' as const, row }));
  return [...stock, ...usage];
}
function rowProblems(item: ReviewItem): { errors: string[]; notes: string[] } {
  if (item.kind === 'usage') {
    const conflict = data!.summary.unitConflicts.find(c => c.sku === item.row.sku);
    return { errors: [...usageErrors(item.row), ...(conflict ? [`同一六碼出現不同單位（${conflict.units.join('、')}），請依原始資料修正單位與數量，不能直接相加`] : [])], notes: item.row.notes };
  }
  const duplicate = data!.duplicates.find(list => list.includes(item.row));
  return { errors: [...stockErrors(item.row), ...(duplicate ? ['同一六碼同一儲位出現多次：重複來源請附理由排除；真實分庫請在儲位加上可辨識的分庫標記後確認'] : [])], notes: item.row.notes };
}
const reviewOk = (item: ReviewItem) => item.row.reviewed && !rowProblems(item).errors.length;
function renderReview() {
  const section = el('review'); const items = reviewItems(); const excluded = data ? [...data.stockRows, ...data.usageRows].filter(row => row.excluded) : [];
  section.hidden = !data || !parsed;
  if (section.hidden || !data) return;
  const pagesTotal = Math.max(1, Math.ceil(items.length / PER_PAGE)); reviewPage = Math.min(reviewPage, pagesTotal - 1);
  const shown = items.slice(reviewPage * PER_PAGE, (reviewPage + 1) * PER_PAGE); const open = items.filter(item => !reviewOk(item)).length;
  const input = (row: string, field: string, value: string, labelText: string, cls = '') => `<input data-row="${row}" data-field="${field}" value="${escape(value)}" aria-label="${labelText}" class="${cls}">`;
  const body = shown.map(item => {
    const { errors, notes } = rowProblems(item); const r = item.row; const status = reviewOk(item) ? '<span class="status-pill green">已確認</span>' : '<span class="status-pill amber">待確認</span>';
    const fields = item.kind === 'usage'
      ? `<td>${input(r.id, 'sku', r.sku, '醫品編號', 'sku-input')}</td><td><span class="mg-name">${escape(r.rawName) || '（空白）'}</span><span class="source-label">調劑表・${where(r.origin)}</span></td><td class="mg-cols">${input(r.id, 'unit', (r as UsageRow).unit, '單位')}${input(r.id, 'count', (r as UsageRow).count, '次數', 'qty-input')}${input(r.id, 'quantity', (r as UsageRow).quantity, '數量', 'qty-input')}</td>`
      : `<td>${input(r.id, 'sku', r.sku, '商品代號', 'sku-input')}</td><td>${input(r.id, 'name', (r as StockRow).name, '清理後名稱')}<span class="source-label">庫存簡表・${where(r.origin)}・原名稱 ${escape(r.rawName)}</span></td><td class="mg-cols">${input(r.id, 'location', (r as StockRow).location, '儲位')}${input(r.id, 'qty', (r as StockRow).qty, '庫存量', 'qty-input')}</td>`;
    return `<tr class="${errors.length ? 'flagged strong' : reviewOk(item) ? '' : 'flagged'}"><td class="mg-row-confirm"><label class="checkbox-label"><input type="checkbox" data-confirm="${r.id}" ${r.reviewed ? 'checked' : ''} ${errors.length ? 'disabled' : ''}>確認</label></td>${fields}<td>${status}${[...errors, ...notes].length ? `<span class="issue-text">${escape([...errors, ...notes].join('；'))}</span>` : ''}</td>
      <td class="mg-actions"><button class="text-button" data-trace="${r.id}">原圖</button><button class="text-button" data-exclude="${r.id}">排除</button></td></tr>`;
  }).join('');
  section.innerHTML = `<div class="section-heading"><div><span class="eyebrow">CHECK BEFORE CALCULATING</span><h2>校對資料</h2></div><button id="clear-results" class="button quiet">清除這次資料</button></div>
    <div class="stats"><div><strong>${data.stockRows.length}</strong><span>庫存列</span></div><div><strong>${data.usageRows.length}</strong><span>調劑明細</span></div><div><strong>${open}</strong><span>待確認</span></div><div><strong>${excluded.length}</strong><span>排除紀錄</span></div><div><strong>${data.missing.length}</strong><span>庫存缺碼</span></div></div>
    <p class="preview-note">兩份報表都直接讀 PDF 文字，不經 OCR。下列只顯示需要確認的列；有錯誤的列須修正或附理由排除，不能直接勾選放行。修改任何欄位都會重新計算，已產生的 PDF 隨即失效。</p>
    <div class="table-scroll"><table class="review-table mg-table mg-review-table"><thead><tr><th class="mg-row-confirm" scope="col">確認</th><th>六碼</th><th>名稱與來源</th><th>單位／次數／數量・儲位／庫存量</th><th>狀態</th><th>操作</th></tr></thead><tbody>${body || '<tr><td colspan="6" class="empty-table">沒有需要校對的列。</td></tr>'}</tbody></table></div>
    ${items.length > PER_PAGE ? `<div class="mg-pager"><button class="button secondary" data-review-page="${reviewPage - 1}" ${reviewPage ? '' : 'disabled'}>上一頁</button><span>${reviewPage + 1} / ${pagesTotal}</span><button class="button secondary" data-review-page="${reviewPage + 1}" ${reviewPage + 1 < pagesTotal ? '' : 'disabled'}>下一頁</button><button class="text-button" id="confirm-shown">確認本頁沒有錯誤的列</button></div>` : shown.length ? '<div class="mg-pager"><button class="text-button" id="confirm-shown">確認本頁沒有錯誤的列</button></div>' : ''}
    ${excluded.length ? `<details class="mg-details" ${excluded.some(row => !autoExclusion(row.sku)) ? 'open' : ''}><summary>排除紀錄 ${excluded.length} 列（不計入品項數 N 與任何清單）</summary><table class="review-table mg-table"><thead><tr><th>代號</th><th>名稱與來源</th><th>排除理由</th><th>操作</th></tr></thead><tbody>${excluded.map(row => `<tr><td>${input(row.id, 'sku', row.sku, '代號', 'sku-input')}</td><td><span class="mg-name">${escape(row.rawName)}</span><span class="source-label">${'unit' in row ? '調劑表' : '庫存簡表'}・${where(row.origin)}</span></td><td><span class="issue-text">${escape(row.excluded!)}</span></td><td class="mg-actions"><button class="text-button" data-trace="${row.id}">原圖</button><button class="text-button" data-restore="${row.id}" ${SIX.test(row.sku) ? '' : 'disabled title="代號須先改為六碼"'}>恢復此列</button></td></tr>`).join('')}</tbody></table></details>` : ''}`;
}
function renderLists() {
  const section = el('lists'); section.hidden = !data || !parsed;
  if (section.hidden || !data) return;
  const strategy = decisions.safetyStrategy ?? DEFAULT_SAFETY_STRATEGY;
  const strategyCards = (Object.keys(SAFETY_STRATEGIES) as SafetyStrategy[]).map(key => {
    const option = SAFETY_STRATEGIES[key];
    return `<label class="mg-strategy-card">
      <input id="strategy-${key}" type="radio" name="safety-strategy" value="${key}" ${strategy === key ? 'checked' : ''} aria-labelledby="strategy-name-${key}" aria-describedby="strategy-range-${key} strategy-detail-${key}">
      <span class="mg-strategy-body"><span class="mg-strategy-heading"><span class="mg-strategy-symbol" aria-hidden="true">${option.symbol}</span><strong id="strategy-name-${key}">${option.name}</strong><span class="mg-strategy-check" aria-hidden="true">✓</span></span>
        <span class="mg-strategy-focus">${option.focus}</span><span id="strategy-range-${key}" class="mg-strategy-range">係數 <b>${safetyStrategyRange(key)}</b><small>個月用量</small></span>
        <span id="strategy-detail-${key}" class="mg-strategy-detail"><span><b>主要優勢</b>${option.advantage}</span><span><b>主要需求</b>${option.need}</span></span>
      </span></label>`;
  }).join('');
  // Only a store judged to have a partner clinic gets this card; the basic mask is already on, widening it is optional.
  const partnerOptions = data.partner ? `<div class="mg-partner"><div class="mg-warning">判定此門市有合作診所，已啟用基本遮罩：本店無庫存，或庫存不足 ${formatFrac(PARTNER_COVERS.standard)} 個月用量（含負）的六碼，視為主要由合作診所供應；安全量清單將略過這些品項並由後一位遞補。</div>
    <label class="checkbox-label mg-confirm"><input id="partner-wide" type="checkbox" ${decisions.partnerCover === 'wide' ? 'checked' : ''} ${busy() ? 'disabled' : ''}>放寬合作診所遮罩：庫存不足 ${formatFrac(PARTNER_COVERS.wide)} 個月用量（約 6 天）即視為合作診所供應，讓更多品項向前遞補（預設 ${formatFrac(PARTNER_COVERS.standard)} 個月，約 3 天）</label>
    ${decisions.partnerCover === 'wide' ? `<div class="mg-warning">已放寬遮罩：本店自己庫存偏低、確實需要採購的品項，也可能因不足 ${formatFrac(PARTNER_COVERS.wide)} 個月而被略過，不會出現在安全量清單。請另行留意這些品項的採購需求。</div>` : ''}</div>` : '';
  const strategyOptions = `<div id="safety-options" class="mg-list-options"><fieldset class="mg-strategies" aria-describedby="strategy-help" ${busy() ? 'disabled' : ''}><legend>安全量策略</legend>
    <p id="strategy-help" class="preview-note">依供貨穩定度與儲存空間，選擇適合門市的備貨方式。預設為平衡派。</p>
    <div class="mg-strategy-grid">${strategyCards}</div>
    <p class="preview-note">三種策略皆依本清單的用藥頻率排名：前 1/3 採最高係數，其餘逐步降至最低係數；同頻率採相同係數。名稱尾綴含「(管3)」或「(管4)」的管制藥，係數 × ${formatFrac(CONTROLLED_FACTOR)}；品名保有「缺貨」前綴的品項，係數再 +1（管制藥又缺貨時先 × ${formatFrac(CONTROLLED_FACTOR)} 再 +1）；保有「冷藏」前綴的品項，因冷藏空間固定不容超量，係數再 × ${formatFrac(COLD_FACTOR)}。</p>
    </fieldset>${partnerOptions}<p id="strategy-status" class="mg-strategy-status" role="status">目前採用：${SAFETY_STRATEGIES[strategy].name}（係數 ${safetyStrategyRange(strategy)}），本清單與 PDF 依此計算。</p></div>`;
  const descriptions: Record<ListKind, string> = {
    safety: '預防常用藥物臨時缺貨，建議您的安全及採購量',
    dead: '找出停滯並應釋放回倉的醫療資源',
    empty: '清理無效儲位，減少盤點干擾',
  };
  const s = data.safety;
  const block = (kind: ListKind) => {
    const available = data!.available[kind]; const chosen = available && selected[kind];
    // A chosen list builds its rows once, through its spec; the others only need the count.
    const spec = chosen ? listSpec(kind, data!, context()) : undefined; const rows = spec?.rows ?? listRows(kind, data!); const output = outputs[kind];
    let preview = '';
    if (spec) {
      const alerts = spec.alerts ?? [];
      const body = rows.slice(0, 8).map((cells, row) => `<tr>${cells.map((cell, i) => `<td class="${spec.columns[i].align === 'right' ? 'num' : ''}${alerts[row]?.[i] ? ' mg-alert' : ''}">${escape(cell).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('');
      preview = `<details class="mg-list-preview"><summary>查看資料預覽・${rows.length} 筆</summary><div class="table-scroll"><table class="review-table mg-preview"><thead><tr>${spec.columns.map(c => `<th class="${c.align === 'right' ? 'num' : ''}">${escape(c.label)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${spec.columns.length}" class="empty-table">${escape(spec.empty)}</td></tr>`}</tbody></table></div>${rows.length > 8 ? `<p class="preview-note">只顯示前 8 筆，PDF 列出全部 ${rows.length} 筆。</p>` : ''}</details>`;
    }
    return `<article class="mg-list ${available ? chosen ? 'mg-selected' : '' : 'mg-disabled'} ${kind === 'safety' && chosen ? 'mg-list-expanded' : ''}" aria-labelledby="list-title-${kind}">
      <label class="mg-list-choice"><input type="checkbox" data-select="${kind}" ${chosen ? 'checked' : ''} ${available && !busy() ? '' : 'disabled'} aria-describedby="list-description-${kind} list-state-${kind}" ${kind === 'safety' && chosen ? 'aria-controls="safety-options"' : ''}>
        <span class="mg-list-copy"><strong id="list-title-${kind}">${LIST_TITLE[kind]}</strong><span id="list-description-${kind}" class="mg-list-description">${descriptions[kind]}</span></span><span class="mg-list-state">${available ? chosen ? '已選擇' : '可選擇' : '無法產生'}</span></label>
      <p id="list-state-${kind}" class="mg-list-meta">${available ? `${rows.length} 筆${kind === 'safety' && chosen ? `・${SAFETY_STRATEGIES[strategy].name}・係數 ${safetyStrategyRange(strategy)}` : kind === 'dead' && data!.selfPay.length ? `（另附自費品 ${data!.selfPay.length} 筆）` : ''}` : escape(data!.reasons[kind])}</p>
      ${kind === 'safety' && chosen ? strategyOptions : ''}${preview}
      ${kind === 'dead' && chosen && data!.selfPay.length ? `<p class="preview-note">PDF 另以灰字在清單末附上 ${data!.selfPay.length} 筆偵測為自費品的品項（名稱前綴含「自費」、庫存不為 0），不計入呆藥筆數，請過目。</p>` : ''}
      ${output && chosen ? `<div class="mg-output"><button class="button secondary" data-preview="${kind}">預覽 PDF</button><button class="button primary" data-download="${kind}">${icon('file')}下載</button><small>${output.pages} 頁・版本 ${output.version}</small></div>` : ''}</article>`;
  };
  const anySelected = LISTS.some(kind => selected[kind] && data!.available[kind]);
  section.innerHTML = `<div class="section-heading"><div><span class="eyebrow">READY TO PLAN</span><h2>產生清單</h2></div><span class="small-label">A4 直式・可各自勾選</span></div>
    <div class="stats"><div><strong>${data.months ? formatFrac(data.months) : '—'}</strong><span>統計月數</span></div><div><strong>${s?.n ?? 0}</strong><span>品項數 N</span></div><div><strong>${s?.limit ?? 0}</strong><span>前 10%</span></div><div><strong>${s?.eligible ?? 0}</strong><span>A &gt; 8</span></div><div><strong>${s?.k ?? 0}</strong><span>安全量筆數 K</span></div></div>
    ${data.stale.length ? `<div class="mg-warning mg-stale-warning">${data.stale.map(item => `${KIND_LABEL[item.kind]}列印於 ${formatDay(item.printed)}，距今已 ${item.days} 天`).join('；')}。以下清單與 PDF 的輸出結果可能失真；PDF 第一頁會附上警語。建議重新列印最新報表後再匯入。</div>` : ''}
    <p class="preview-note">勾選要產生的清單；選擇安全量清單後，可在卡片內設定備貨策略。</p>
    <div class="mg-list-grid">${LISTS.map(block).join('')}</div>
    <div class="export-bottom"><div><p id="export-hint">${generating ? '正在產生 PDF，請稍候。' : !data.ready ? escape(data.reasons.safety) : anySelected ? '按「產生勾選的 PDF」輸出清單。資料、策略或勾選變更後，舊的 PDF 會失效。' : LISTS.some(kind => data!.available[kind]) ? '請先勾選要產生的清單。' : '目前資料不足以產生清單，請依卡片提示補齊資料或確認。'}</p>${FEEDBACK_ENDPOINT ? `<p class="preview-note mg-feedback-note">產生 PDF 時，會一併送出這次的校對修改紀錄供開發者改進判讀規則：名稱修正、提示後未修改即確認的列、排除理由、所選策略與門市編號。<b>不送出報表檔案、店名、統計期間，也不送出任何次數、數量、庫存量的數值。</b>${feedbackStatus ? `<br>${escape(feedbackStatus)}` : ''}</p>` : ''}</div><div class="export-actions"><button id="generate" class="button primary" ${!anySelected || generating ? 'disabled' : ''}>${icon('file')}產生勾選的 PDF</button></div></div>`;
}
const context = () => ({ files: { usage: entries.filter(e => e.kind === 'usage').map(e => e.source.file.name), inventory: entries.filter(e => e.kind === 'inventory').map(e => e.source.file.name) }, version: generation, appVersion,
  time: new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()) });

// ---- Actions -----------------------------------------------------------------
const findRow = (id: string) => data ? [...data.usageRows, ...data.stockRows].find(row => row.id === id) : undefined;
function changed() { invalidate(); render(); }
function edit(id: string, field: string, value: string) {
  const row = findRow(id); if (!row) return;
  const text = value.normalize('NFKC').trim();
  if (field === 'sku') row.sku = text;
  else if ('unit' in row && (field === 'unit' || field === 'count' || field === 'quantity')) row[field] = text;
  else if (!('unit' in row) && (field === 'name' || field === 'location' || field === 'qty')) (row as StockRow)[field] = value.trim();
  row.reviewed = false; attention.add(id); changed();
}
async function exclude(id: string) {
  const row = findRow(id); if (!row) return;
  const reason = await dialog('排除這一列', `<p>${escape(row.sku)}・${escape(row.rawName)}<br>排除後不計入品項數 N 與任何清單，紀錄會保留並可恢復。請寫下理由（例如：重複匯入的來源、非藥品列）。</p>`, '取消', '排除', true);
  if (!reason) return; row.excluded = `使用者排除：${reason}`; changed(); advanceWhenReviewComplete();
}
function restore(id: string) { const row = findRow(id); if (!row || !SIX.test(row.sku)) return; row.excluded = undefined; row.reviewed = false; attention.add(id); changed(); }
function confirmRow(id: string, checked: boolean) {
  const row = findRow(id); if (!row) return;
  const item: ReviewItem = 'unit' in row ? { kind: 'usage', row } : { kind: 'stock', row: row as StockRow };
  row.reviewed = checked && !rowProblems(item).errors.length; changed(); if(checked)advanceWhenReviewComplete();
}
async function showTrace(id: string) {
  const row = findRow(id); if (!row) return; const page = pages.find(p => p.file === row.origin.file && p.filePage === row.origin.filePage); const entry = entries[row.origin.file]; if (!page || !entry) return;
  el('trace-title').textContent = `${row.sku || '（無代號）'}・${where(row.origin)}`; el('trace-content').innerHTML = '<p class="loading-text">正在載入原圖…</p>'; el<HTMLDialogElement>('trace-dialog').showModal();
  try {
    const original = await entry.source.render(row.origin.filePage, 200); const upright = rotateCanvas(original, page.rotation);
    const top = Math.max(0, row.origin.top - .012); const bottom = Math.min(1, row.origin.bottom + .012);
    const strip = cropCanvas(upright, { x: 0, y: top * upright.height, width: upright.width, height: (bottom - top) * upright.height });
    const url = strip.toDataURL('image/png'); for (const canvas of new Set([original, upright, strip])) canvas.width = canvas.height = 1;
    const values = 'unit' in row ? `醫品編號 ${row.sku}・單位 ${row.unit || '（空白）'}・次數 ${row.count || '（空白）'}・數量 ${row.quantity || '（空白）'}` : `商品代號 ${row.sku}・儲位 ${(row as StockRow).location || '（空白）'}・庫存量 ${formatQuantity((row as StockRow).qty)}`;
    el('trace-content').innerHTML = `<div class="trace-image"><img alt="這一列的原始報表影像" src="${url}"></div><p class="preview-note">${escape(fileName(row.origin.file))}・原名稱：${escape(row.rawName)}<br>${escape(values)}</p>`;
  } catch (error) { el('trace-content').textContent = error instanceof Error ? error.message : '無法載入原圖。'; }
}
async function generate() {
  if (busy() || !data) return; const version = generation; const kinds = LISTS.filter(kind => selected[kind] && data!.available[kind]); if (!kinds.length) return;
  generating = true; render();
  // Every URL made here is either handed over to `outputs` (whose previous batch is then revoked) or revoked on failure.
  const results: Partial<Record<ListKind, Output>> = {};
  try {
    fontBytes ??= fetch((import.meta.env.BASE_URL ?? '/') + 'assets/fonts/NotoSansTC-PDF.ttf').then(async response => { if (!response.ok) throw new Error('無法載入 PDF 中文字型。'); return new Uint8Array(await response.arrayBuffer()); });
    // pdf-lib and fontkit (~1 MB) load on the first PDF, not with the page.
    const [font, { generateListPDF }] = await Promise.all([fontBytes, import('./management-pdf')]); const frozen = data; const ctx = context();
    for (const kind of kinds) {
      const result = await generateListPDF(listSpec(kind, frozen, ctx), font);
      results[kind] = { bytes: result.bytes, url: URL.createObjectURL(new Blob([result.bytes.slice().buffer], { type: 'application/pdf' })), version, pages: result.pageCount, rows: result.rowCount };
    }
    if (version !== generation) throw new Error('產生 PDF 期間資料或設定已變更，請重新產生。');
    for (const output of Object.values(outputs)) URL.revokeObjectURL(output.url);
    outputs = results; void submitFeedback();
  } catch (error) { for (const output of Object.values(results)) URL.revokeObjectURL(output.url); fontBytes = undefined; showError(error instanceof Error ? error.message : 'PDF 產生失敗。'); }
  finally { generating = false; render(); }
}
const pdfName = (kind: ListKind) => `${data?.storeLabel || '門市'}_${LIST_TITLE[kind]}${kind === 'safety' ? `_${SAFETY_STRATEGIES[data?.safety?.strategy ?? DEFAULT_SAFETY_STRATEGY].name}` : ''}.pdf`;
function current(kind: ListKind): Output {
  const output = outputs[kind]; if (!output || output.version !== generation || !data?.available[kind]) throw new Error('清單已因資料修改而失效，請重新產生。');
  return output;
}
function save(kind: ListKind) { const output = current(kind); const link = document.createElement('a'); link.href = output.url; link.download = pdfName(kind); document.body.append(link); link.click(); link.remove(); }
let previewKind: ListKind | undefined;
/** Sends the review record once per distinct review after lists are generated; a failed send never blocks the PDFs. */
async function submitFeedback() {
  if (!FEEDBACK_ENDPOINT || !data) return;
  const store = data.usage.pages[0]?.facts.store.number;
  const record = feedbackRecord({ originals, usageRows: data.usageRows, stockRows: data.stockRows, safetyStrategy: decisions.safetyStrategy ?? DEFAULT_SAFETY_STRATEGY,
    partnerClinic: Boolean(data.partner), partnerCover: decisions.partnerCover ?? 'standard', app: appVersion, store, sent: new Date().toISOString() });
  const key = feedbackKey(record); if (!worthSending(record) || key === feedbackSent) return;
  feedbackSent = key;
  try { await sendFeedback(record, FEEDBACK_ENDPOINT); feedbackStatus = '已送出這次的校對紀錄，謝謝。'; }
  catch { feedbackSent = ''; feedbackStatus = '校對紀錄未能送出（網路問題），不影響清單；下次產生 PDF 時會再試。'; }
  render(false);
}

for (const kind of KINDS) {
  const zone = el(`drop-${kind}`); const input = el<HTMLInputElement>(`input-${kind}`);
  zone.addEventListener('click', () => { if (!busy()) input.click(); });
  zone.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!busy()) input.click(); } });
  input.addEventListener('change', () => { const files = [...input.files ?? []]; input.value = ''; void addFiles(kind, files); });
  zone.addEventListener('dragover', event => { event.preventDefault(); if (!busy()) zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('dragging'); if (!busy()) void addFiles(kind, [...event.dataTransfer?.files ?? []]); });
  el(`files-${kind}`).addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]'); if (button) void removeFile(Number(button.dataset.remove)); });
}
el('start').addEventListener('click', () => void parseAll());
el('clear-all').addEventListener('click', () => void clearAll());
el('cancel').addEventListener('click', () => { cancelRequested = true; parsing = false; progress.message = '已取消解析，可重新開始'; pages = []; rejected = []; render(); });
document.addEventListener('change', event => {
  const target = event.target as HTMLInputElement;
  if (target.name === 'safety-strategy' && target.checked) {
    if (busy() || !Object.hasOwn(SAFETY_STRATEGIES, target.value) || target.value === decisions.safetyStrategy) return;
    decisions.safetyStrategy = target.value as SafetyStrategy; changed();
    el<HTMLInputElement>(`strategy-${target.value}`).focus({ preventScroll: true }); return;
  }
  if (target.dataset.row && target.dataset.field) return edit(target.dataset.row, target.dataset.field, target.value);
  if (target.dataset.confirm) return confirmRow(target.dataset.confirm, target.checked);
  if (target.dataset.select) {
    const kind = target.dataset.select as ListKind;
    if (busy() || !data?.available[kind]) return;
    selected[kind] = target.checked; invalidate(); render(false);
    document.querySelector<HTMLInputElement>(`[data-select="${kind}"]`)?.focus({ preventScroll: true }); return;
  }
  if (target.id === 'store-confirm') { decisions.storeConfirmed = target.checked; changed(); if(target.checked)scrollToNextAction(); return; }
  if (target.id === 'partner-wide') { decisions.partnerCover = target.checked ? 'wide' : 'standard'; changed(); el<HTMLInputElement>('partner-wide')?.focus({ preventScroll: true }); return; }
});
document.addEventListener('keydown', event => { const target = event.target as HTMLInputElement; if (event.key === 'Enter' && !event.isComposing && target.dataset?.row) { event.preventDefault(); target.blur(); } });
document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
  const d = target.dataset;
  if (d.trace) void showTrace(d.trace); else if (d.exclude) void exclude(d.exclude); else if (d.restore) restore(d.restore);
  else if (d.reviewPage !== undefined) { reviewPage = Number(d.reviewPage); render(false); }
  else if (target.id === 'confirm-shown') { const items = reviewItems().slice(reviewPage * PER_PAGE, (reviewPage + 1) * PER_PAGE); for (const item of items) if (!rowProblems(item).errors.length) item.row.reviewed = true; changed(); advanceWhenReviewComplete(); }
  else if (target.id === 'clear-results') { void clearAll(); }
  else if (target.id === 'generate') void generate();
  else if (d.download) { try { save(d.download as ListKind); } catch (error) { showError(error instanceof Error ? error.message : 'PDF 已失效。'); render(); } }
  else if (d.preview) { try { const kind = d.preview as ListKind; const output = current(kind); previewKind = kind; el('pdf-title').textContent = `${LIST_TITLE[kind]}預覽`; el<HTMLIFrameElement>('pdf-frame').src = output.url; el<HTMLAnchorElement>('pdf-open-tab').href = output.url; el<HTMLDialogElement>('pdf-dialog').showModal(); } catch (error) { showError(error instanceof Error ? error.message : 'PDF 已失效。'); } }
});
el('close-trace').addEventListener('click', () => el<HTMLDialogElement>('trace-dialog').close());
el<HTMLDialogElement>('trace-dialog').addEventListener('close', () => { el('trace-content').innerHTML = ''; });
el('close-pdf').addEventListener('click', () => el<HTMLDialogElement>('pdf-dialog').close());
el('dialog-download').addEventListener('click', () => { try { if (previewKind) save(previewKind); } catch (error) { el<HTMLDialogElement>('pdf-dialog').close(); showError(error instanceof Error ? error.message : 'PDF 已失效。'); } });
function qaSnapshot() {
  return { parsed, parsing, error: errorMessage, generation, pages: pages.length, rejected, blockers: data?.blockers, warnings: data?.warnings, partner: data?.partner, ready: data?.ready, available: data?.available, reasons: data?.reasons,
    safetyStrategy: data?.safety?.strategy, months: data?.months && formatFrac(data.months), n: data?.safety?.n, k: data?.safety?.k, eligible: data?.safety?.eligible, missing: data?.missing.length, review: reviewItems().length,
    lists: data && Object.fromEntries(LISTS.map(kind => [kind, listRows(kind, data!)])), outputs: Object.fromEntries(Object.entries(outputs).map(([kind, output]) => [kind, { pages: output.pages, rows: output.rows, version: output.version, bytes: output.bytes.length }])) };
}
if (import.meta.env.DEV) Object.defineProperty(window, 'managementQA', { get: qaSnapshot });
render();
