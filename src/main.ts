import './style.css';
import { inventoryImportGuide } from './inventory-import-guide';
declare const __APP_VERSION__: string;
const appVersion = __APP_VERSION__;
import { barcodeFontText, generatePDF, scanTestRows, type RowHeight } from './pdf';
import { admit, canExport, canonicalQuantity, cleanProductName, compareStores, formatQuantity, hasDoubt, inventoryWarning, isNegativeQuantity, isZeroQuantity, LIMITS, mergeRows, needsIndividualReview, sortRows, validationErrors, type InventoryRow, type MergeResult, type PageReport, type SortMode } from './model';
import { formatDay, today } from './report-date';
import { DocumentSource, MIN_SCAN_DPI } from './source';
import { SourceSet } from './sourceset';
import { OCREngine } from './ocr';
import { InventoryJob } from './job';
import { POOR_LOCATION, POOR_NAME } from './parser';
import { cropCanvas, rotateCanvas } from './geometry';

const app = document.querySelector<HTMLDivElement>('#app')!;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const icon = (name: 'box'|'upload'|'file'|'arrow') => {
  const paths = { box:'<path d="m4 7 8-4 8 4v10l-8 4-8-4V7Z"/><path d="m4 7 8 4 8-4M12 11v10M8 5l8 4"/>', upload:'<path d="M12 16V4m-5 5 5-5 5 5M4 15v5h16v-5"/>', file:'<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h5"/>', arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>' };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
// queue: files added and not yet cleared, in reading order. source: the queue as read by the current job.
let queue: DocumentSource[] = []; let adding = false; const forcedRotations = new Map<DocumentSource, number>(); let storeNote = '';
let source: SourceSet | undefined; let job: InventoryJob | undefined; let rows: InventoryRow[] = []; let pages: PageReport[] = [];
let selectedPage = 1; let filterIssues = true; let sortMode: SortMode = 'sku'; let rowHeight: RowHeight = 22.6;
let storeName = ''; let processingMessage = ''; let pdfUrl = ''; let pdfBytes: Uint8Array | undefined;
let generating = false; let retrying = false; let activeDialogCanvas: HTMLCanvasElement | undefined; let currentTrace: InventoryRow | undefined; let generation = 0;
// Cache only within one Taipei calendar day, so a later download gets the current source-age warning.
let pdfRevision = -1; let pdfDay = ''; let documentNumber = 0;
let startedAt = 0; let elapsedSeconds = 0; let timer: ReturnType<typeof setInterval> | undefined;
const stats = { renderedPages:0, peakOCRCanvases:0 };
const busy = () => job?.running || generating || retrying || adding;
app.innerHTML = `
  <header class="topbar"><a class="brand" href="${import.meta.env.BASE_URL}" aria-label="樹懶的盤點，返回樹懶的工作主目錄">${icon('box')}<span>樹懶的盤點<span class="brand-sub">← 返回主目錄</span></span></a><a class="inventory-home" href="${import.meta.env.BASE_URL}">← 主目錄</a><span class="local-badge"><i></i>檔案留在你的裝置</span></header>
  <main>
    <section class="intro"><div><div class="eyebrow">INVENTORY, MADE CLEAR</div><h1>Chill, see.<br class="mobile-break"> 告別手動維護。</h1><p>庫存簡表直接轉換，想漏點都漏不了。<br>按儲位輸出，藥師能方便校正儲位，高效預盤及調帳。<br>按六編碼輸出，方便盤點小組作業及覆盤核對。</p></div><div class="paper-mark"><span>A4</span><i></i><i></i><i></i><b>SCAN · CHECK · COUNT</b></div></section>
    <nav class="steps" aria-label="處理步驟"><div data-step="1" class="active"><span>01</span>匯入與辨識</div><div data-step="2"><span>02</span>校對資料</div><div data-step="3"><span>03</span>下載盤點表</div></nav>
    <div class="workspace">
      <section class="upload-card card"><div class="section-heading"><h2>匯入庫存表</h2><span class="small-label">可加入多份檔案</span></div>
        <input id="file-input" type="file" accept="application/pdf,image/jpeg,image/png" multiple hidden>
        <div id="drop-zone" class="drop-zone" role="button" tabindex="0" aria-label="選擇或拖放庫存檔案，可多份"><div class="upload-icon">${icon('upload')}</div><h3>把檔案拖到這裡</h3><p>或點選，從裝置選擇檔案（可多選）</p><span class="file-types">PDF / JPG / PNG</span></div>
        <ol id="file-list" class="file-list" aria-label="待辨識的檔案" hidden></ol>
        <div id="start-row" class="start-row" hidden><span id="queue-summary" aria-live="polite"></span><button id="clear-queue" class="button quiet">全部移除</button><button id="start" class="button primary"><span id="start-label">開始辨識</span>${icon('arrow')}</button></div>
        <div id="error" role="alert" class="error-box" hidden></div>
        <div id="progress-panel" hidden><div class="progress-line"><strong id="progress-title"></strong><span id="progress-counter"></span></div><div class="progress-track"><div id="progress-bar"></div></div><p id="progress-description" aria-live="polite"></p><div class="job-controls"><button id="pause" class="button secondary">暫停</button><button id="resume" class="button secondary" hidden>繼續辨識</button><button id="cancel" class="button quiet">取消辨識</button></div></div>
        <div class="import-note"><span>合計最多 200 頁・200 MB</span><p>可分次加入多份庫存表，全部加入後按「開始辨識」。多份檔案會先確認是同一門市，再合併資料、刪除重複品項。大檔會逐頁處理，請保持頁面開啟；重新整理後，這次資料會清除。</p></div>
        ${inventoryImportGuide}
      </section>
      <aside class="guide-card card"><span class="eyebrow">BEFORE THE COUNT</span><h2>年度盤點小提醒</h2><ol class="reminder-list"><li>預盤時應同時整理儲位，避免藥品錯置與分散，並補上新入庫藥品的儲位。</li><li>歸屬於內場項目、卻不屬於第 9 類品項（處方藥品）者，如針頭、試紙等，應訂一儲位大項。匯入製作本盤點表時，可作為第二份補充文件（第一份文件即設定第 9 類品項）。</li><li>預盤及正式盤點前，應對預包處方（含欠藥區）做全面檢查，避免調劑錯誤被計算成盤差，並留意預包區間內都已完成「預包給藥」（扣帳）。</li><li>300 顆以上已拆封的罐裝藥品，應做預點及貼封，加快當日整理速度。</li><li>應確認有無尚不可驗收的盤商貨單。如無急迫，可整份不歸入庫存，或實際盤點量填寫歸入前的總量。</li><li>應確認有無「已批價但客人尚未取走的冷藏藥或客訂品」。</li></ol><button id="scan-test" class="text-button">下載掃描器測試頁 ${icon('arrow')}</button></aside>
    </div>
    <section id="review" class="card review-card" hidden><div class="section-heading"><div><span class="eyebrow">CHECK BEFORE PRINT</span><h2>校對辨識結果</h2></div><button id="clear" class="button quiet">清除這次資料</button></div><div class="stats"><div><strong id="stat-rows">0</strong><span>擷取品項</span></div><div><strong id="stat-skipped-zero">0</strong><span>略過帳量 0</span></div><div><strong id="stat-pending">0</strong><span>待確認品項</span></div><div><strong id="stat-pages">0</strong><span>來源頁面</span></div><div id="stat-duplicates-box" hidden><strong id="stat-duplicates">0</strong><span>刪除重複</span></div></div>
      <div class="review-toolbar"><label id="page-picker">來源頁 <select id="page-select" aria-label="來源頁"></select></label><label class="checkbox-label"><input id="issues-only" type="checkbox" checked>只看有疑義</label><button id="view-page" class="text-button">查看原頁</button></div>
      <div id="page-error" class="error-box" hidden></div><div id="retry-controls" class="retry-controls" hidden><span>確認方向後，重試這一頁：</span><button class="button secondary" data-rotate="0">0°</button><button class="button secondary" data-rotate="90">90°</button><button class="button secondary" data-rotate="180">180°</button><button class="button secondary" data-rotate="270">270°</button></div>
      <div class="table-scroll"><table class="review-table"><thead><tr><th>六編碼</th><th>清理後名稱</th><th>儲位</th><th>帳量</th><th>原圖 / 確認</th></tr></thead><tbody id="review-body"></tbody></table></div>
      <p id="keyboard-hint" class="keyboard-hint">有疑義的項目請對照原圖、調整後逐筆勾選確認；修改欄位後需重新確認。Enter 移到下一列，← → 可手動換頁。</p>
    </section>
    <section id="export" class="card export-card" hidden><div class="section-heading"><div><span class="eyebrow">READY TO COUNT</span><h2>產生盤點表</h2></div><span class="small-label">A4 直式 · 五欄</span></div><div class="export-options"><label>門市名稱<input id="store-name" type="text" placeholder="可自行填寫門市名稱" maxlength="80"></label><label>排序方式<select id="sort"><option value="location">儲位（適合預盤與儲位修訂）</option><option value="sku" selected>六編碼（適合盤點當日輸出）</option></select></label><label>最低列高<select id="row-height"><option value="22.6">22.6 mm · 緊湊</option><option value="25.8">25.8 mm · 增加間距</option><option value="29">29 mm · 更寬鬆</option></select></label></div><div id="report-warning" class="report-warning" role="status" hidden></div><div id="output-preview" class="output-preview"></div><div class="export-bottom"><div><p id="export-hint"></p></div><div class="export-actions"><button id="preview-pdf" class="button secondary" disabled>預覽 PDF</button><button id="download-pdf" class="button primary" disabled>${icon('file')}下載盤點 PDF</button></div></div></section>
    <footer class="footer"><span>樹懶的盤點 · 每次盤點，清楚一點。 <span id="app-version">${appVersion}</span></span><span>瀏覽器內 OCR · 不上傳 · 不保存庫存資料</span></footer>
  </main>
  <dialog id="ask-dialog"><div class="dialog-heading"><h2 id="ask-title"></h2></div><div id="ask-text" class="resolution-text"></div><div class="resolution-actions"><button id="ask-cancel" class="button secondary"></button><button id="ask-continue" class="button primary"></button></div></dialog>
  <dialog id="trace-dialog"><div class="dialog-heading"><h2 id="trace-title">原圖校對</h2><button id="close-trace" class="icon-button" aria-label="關閉原圖">×</button></div><div id="trace-content"></div></dialog>
  <dialog id="pdf-dialog"><div class="dialog-heading"><h2>盤點表預覽</h2><button id="close-pdf" class="icon-button" aria-label="關閉預覽">×</button></div><p class="preview-note">列印時選擇 A4、原尺寸 100%，關閉印表機的縮放。若未顯示預覽，可<a id="pdf-open-tab" href="#" target="_blank" rel="noopener">在新分頁開啟</a>或直接下載 PDF。</p><iframe id="pdf-frame" title="盤點 PDF 預覽"></iframe><button id="dialog-download" class="button primary">下載 PDF</button></dialog>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function invalidatePDF(){generation++;pdfBytes=undefined;pdfRevision=-1;pdfDay='';if(pdfUrl)URL.revokeObjectURL(pdfUrl);pdfUrl='';
  // A preview left open must not keep showing (or downloading) an outdated PDF.
  const dialog=el<HTMLDialogElement>('pdf-dialog');if(dialog.open)dialog.close();el<HTMLIFrameElement>('pdf-frame').removeAttribute('src');}
function showError(message:string){el('error').hidden=!message;el('error').textContent=message;}
function updateProgress(){
  const state=job?.state ?? 'idle';el('progress-panel').hidden=state==='idle';
  const titles={idle:'',loading:'準備辨識',running:'正在辨識',paused:'已暫停',cancelled:'辨識已取消',complete:'辨識完成，請校對',error:'辨識中止'};
  el('progress-title').textContent=titles[state];el('progress-counter').textContent=source?`${job?.completed??0} / ${source.pages} 頁`:'';
  el('progress-bar').style.width=source?`${((job?.completed??0)/source.pages)*100}%`:'0%';
  const where=job?.current&&source&&source.files.length>1?`${pageLabel(job.current)}：`:'';
  el('progress-description').textContent=`${where}${processingMessage}${elapsedSeconds?` · 已用 ${Math.floor(elapsedSeconds/60)} 分 ${elapsedSeconds%60} 秒`:''}`;
  el('pause').hidden=state!=='running';el<HTMLButtonElement>('pause').disabled=job?.pauseRequested??false;
  el('pause').textContent=job?.pauseRequested?'完成目前頁後暫停':'暫停';el('resume').hidden=state!=='paused';
  el('cancel').hidden=!['loading','running','paused'].includes(state);
  el('drop-zone').classList.toggle('disabled',Boolean(busy()));el<HTMLButtonElement>('clear').disabled=generating;
  // Recognition starts only from the button, after every file is added; a finished job is kept until the files change.
  el('start-row').hidden=!queue.length;el<HTMLButtonElement>('start').disabled=Boolean(busy())||state==='complete';el<HTMLButtonElement>('clear-queue').disabled=Boolean(busy());
  el('start-label').textContent=job?.running?'辨識中…':state==='complete'?'已完成辨識':state==='error'||state==='cancelled'?'重新開始辨識':'開始辨識';
  document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button=>button.disabled=Boolean(busy()));
  el('queue-summary').textContent=queue.length?`${queue.length} 份檔案・共 ${queue.reduce((total,file)=>total+file.pages,0)} 頁${storeNote?`・${storeNote}`:''}`:'';
}
function renderQueue(){
  el('file-list').hidden=!queue.length;
  el('file-list').innerHTML=queue.map((file,i)=>`<li class="file-details"><span class="file-index">${i+1}</span>${icon('file')}<div><strong>${escape(file.file.name)}</strong><span>${file.pages} 頁 · ${(file.file.size/1024/1024).toFixed(1)} MB</span></div><button type="button" class="text-button file-remove" data-remove="${i}" aria-label="移除 ${escape(file.file.name)}">移除</button></li>`).join('');
  updateProgress();
}
/** "第 3 頁"; with several files "第 2 份・第 3 頁", the page number inside that file. */
const pageLabel=(page:number)=>source&&source.files.length>1?`第 ${source.fileIndex(page)+1} 份・第 ${source.localPage(page)} 頁`:`第 ${page} 頁`;
const fileOf=(row:InventoryRow)=>source?.fileIndex(row.page)??0;
/** Admits one page's rows: a line already read from another file is dropped, a different quantity for it is flagged on both rows. */
function admitPage(report:PageReport,pageRows:InventoryRow[]){
  const merged=mergeRows(rows,admit(pageRows),fileOf);rows=merged.rows;report.duplicates=merged.duplicates;flagConflicts(merged.conflicts);
}
function flagConflicts(conflicts:MergeResult['conflicts']){
  for(const [a,b] of conflicts)for(const [row,other] of [[a,b],[b,a]]){
    row.issues.push(`與${pageLabel(other.page)}同代號同儲位，帳量卻是 ${formatQuantity(other.bookQty)}，請確認；兩筆帳量改成一致時只輸出一筆`);row.attention=true;row.reviewed=false;
  }
}
/** What the PDF prints: no zero quantities, and a line read equally from two files only once. */
function printable(from:InventoryRow[]){
  const nonzero=from.filter(row=>!isZeroQuantity(row.bookQty));const merged=mergeRows([],nonzero,fileOf);
  return {rows:merged.rows,zero:pages.reduce((total,page)=>total+page.skippedZero,0)+from.length-nonzero.length,duplicates:pages.reduce((total,page)=>total+(page.duplicates??0),0)+merged.duplicates};
}
// Shows the scanned cell and one button per candidate for a number the vote could not settle.
function doubtPicker(row:InventoryRow,field:'sku'|'bookQty'){
  const doubt=row.numberDoubts?.[field];if(!doubt)return '';
  const label=field==='sku'?'代號':'帳量';
  return `<div class="doubt"><img src="${doubt.image}" alt="原圖中的${label}"><span class="doubt-buttons">${doubt.candidates.map(value=>`<button type="button" class="pick" data-pick="${field}" data-value="${escape(value)}" aria-label="${label}選 ${escape(value)}">${escape(field==='bookQty'?formatQuantity(value):value)}</button>`).join('')}</span></div>`;
}
const doubtIssue={sku:/^代號多次辨識不一致/,bookQty:/^庫存量多次辨識不一致/};
const flagged = hasDoubt;
const byPageAndId = (a: InventoryRow, b: InventoryRow) => a.page - b.page || a.id.localeCompare(b.id, undefined, { numeric: true });
const attentionRows = () => rows.filter(row => row.attention).sort(byPageAndId);
function scrollToNextAction(){
  const rejected=pages.find(page=>page.status==='rejected');
  if(rejected){filterIssues=false;selectedPage=rejected.page;el<HTMLInputElement>('issues-only').checked=false;updateReview();}
  const target=exportReady()?'export':'review';
  el(target).scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
function showPage(page:number){selectedPage=page;updateReview();el('review').scrollIntoView({block:'start'});}
function stepPage(direction:1|-1){const list=pages.map(p=>p.page);const i=list.indexOf(selectedPage);const next=list[i+direction];if(next!==undefined)showPage(next);}
/** The next pending row after the given one on the shown page, for keyboard review. */
/** Moves to the same field of the next shown row, like a spreadsheet. */
function focusNextRow(afterId:string,field:string){
  const shown=[...document.querySelectorAll<HTMLElement>('#review-body tr[data-row]')];const i=shown.findIndex(tr=>tr.dataset.row===afterId);
  shown[i+1]?.querySelector<HTMLInputElement>(`[data-field="${field}"]`)?.focus();
}
function updateReview(){
  if(import.meta.env.DEV){let qa=el('qa-state');if(!qa){qa=document.createElement('output');qa.id='qa-state';qa.hidden=true;document.body.append(qa);}qa.textContent=JSON.stringify({state:job?.state,completed:job?.completed,total:source?.pages,rows:rows.length,elapsedSeconds,stats,results:rows,pages,headers:job?.engine.headerDebug});}
  const aggregate=filterIssues; const doubts=attentionRows(); const report=pages.find(page=>page.page===selectedPage);
  const pageRows=rows.filter(row=>row.page===selectedPage); const visible=aggregate?doubts:pageRows;
  const rejected=pages.filter(page=>page.status==='rejected'); const skippedZero=pages.reduce((total,page)=>total+page.skippedZero,0);
  el('review').hidden=!source;el('export').hidden=!rows.length;
  el('stat-rows').textContent=String(rows.length);el('stat-skipped-zero').textContent=String(skippedZero);el('stat-pending').textContent=String(rows.filter(row=>!row.reviewed||validationErrors(row).length).length);
  el('stat-pages').textContent=`${pages.length}${source?` / ${source.pages}`:''}`;
  el('stat-duplicates-box').hidden=!(source&&source.files.length>1);el('stat-duplicates').textContent=String(pages.reduce((total,page)=>total+(page.duplicates??0),0));
  const perPage=new Map<number,number>();for(const row of rows)perPage.set(row.page,(perPage.get(row.page)??0)+1);
  el<HTMLSelectElement>('page-select').innerHTML=pages.map(page=>`<option value="${page.page}" ${page.page===selectedPage?'selected':''}>${pageLabel(page.page)} · ${page.status==='accepted'?(perPage.get(page.page)??0)+' 筆 · 略過 '+page.skippedZero+' 筆帳量 0'+(page.duplicates?' · 重複 '+page.duplicates+' 筆':''):'無法辨識'}${page.mode==='text'?' · PDF 文字':''}</option>`).join('');
  el('page-picker').hidden=aggregate;el('view-page').hidden=aggregate;el('retry-controls').hidden=aggregate||report?.status!=='rejected'||Boolean(busy());
  if(aggregate&&rejected.length){el('page-error').hidden=false;el('page-error').textContent=`${source&&source.files.length>1?rejected.map(page=>pageLabel(page.page)).join('、'):`第 ${rejected.map(page=>page.page).join('、')} 頁`}無法辨識。取消勾選「只看有疑義」，選擇該頁，再用方向按鈕重試。`;}
  else {el('page-error').hidden=report?.status!=='rejected';el('page-error').textContent=report?.reason??'';}
  el('review-body').innerHTML=visible.length?visible.map(row=>{
    const invalid=validationErrors(row);const notes=[...(invalid.length?invalid:row.issues),...(isZeroQuantity(row.bookQty)?['帳量為 0，不會輸出']:[])];
    return `<tr data-row="${row.id}" class="${flagged(row)?needsIndividualReview(row)||invalid.length?'flagged strong':'flagged':''}"><td><input aria-label="${row.id} 商品代號" data-field="sku" inputmode="numeric" value="${escape(row.sku)}" maxlength="6" class="sku-input">${doubtPicker(row,'sku')}</td><td><input aria-label="${row.id} 清理後名稱" data-field="name" value="${escape(row.name)}" class="name-input${row.issues.includes(POOR_NAME)?' doubtful':''}"><span class="source-label">${pageLabel(row.page)}${row.rawName===row.name?'':' · 已清理前後綴'}</span>${notes.length?`<span class="issue-text">${escape(notes.join('；'))}</span>`:''}</td><td><input aria-label="${row.id} 儲位" data-field="location" value="${escape(row.location)}" class="location-input${row.issues.includes(POOR_LOCATION)?' doubtful':''}" placeholder="原表空白"></td><td><input aria-label="${row.id} 帳量" data-field="bookQty" inputmode="decimal" value="${escape(row.bookQty)}" class="qty-input">${doubtPicker(row,'bookQty')}</td><td><button class="text-button trace-button" data-id="${row.id}" aria-label="對照 ${row.sku} 原圖">對照</button>${row.attention?`<label class="row-confirm checkbox-label"><input type="checkbox" data-confirm-row aria-label="確認 ${escape(row.sku)} ${escape(row.name)}" ${row.reviewed?'checked':''} ${invalid.length||busy()?'disabled':''}>已確認</label>`:''}</td></tr>`;
  }).join(''):`<tr><td colspan="5" class="empty-table">${aggregate?'沒有疑義項目，可直接到下方產生盤點表。':report?.status==='rejected'?'這一頁無法確認格式，修正方向後可重試。':'辨識結果會在這裡顯示。'}</td></tr>`;
  updateExport();
}
function updateExport(){
  const warning=inventoryWarning(pages);el('report-warning').hidden=!warning;el('report-warning').textContent=warning;
  const ready=canExport(rows,pages,job?.state==='complete'&&pages.length===source?.pages);
  const pending=rows.filter(r=>!r.reviewed||validationErrors(r).length).length;const rejected=pages.filter(p=>p.status==='rejected').length;
  el<HTMLButtonElement>('preview-pdf').disabled=!ready||generating;el<HTMLButtonElement>('download-pdf').disabled=!ready||generating;
  el('export-hint').textContent=retrying?'正在重新辨識這一頁，請稍候。':generating?'正在產生 PDF，請稍候。':rejected?`${rejected} 頁無法確認格式，修正前不能輸出。`:job?.state!=='complete'||pages.length!==source?.pages?'整份辨識完成後才能輸出。':pending?`還有 ${pending} 筆待確認；請調整後逐筆勾選確認。`:'全部資料已確認，可以產生 PDF。';
  const output=printable(rows);const preview=sortRows(output.rows,sortMode).slice(0,3);const negatives=output.rows.filter(row=>isNegativeQuantity(row.bookQty)).length;
  el('output-preview').innerHTML=preview.map(row=>`<div class="preview-row"><div class="preview-code"><span class="barcode-font" aria-hidden="true">${escape(barcodeFontText(row.sku))}</span><span>${escape(row.sku)}</span></div><span>${escape(row.name)}</span><span>${escape(row.location)||'—'}</span><span>${escape(formatQuantity(row.bookQty))}</span><span class="handwriting-preview"></span></div>`).join('')+`<p>輸出 ${output.rows.length} 筆${negatives?` · 負數帳量 ${negatives} 筆排在最前`:''} · 略過帳量 0 共 ${output.zero} 筆${output.duplicates?` · 刪除重複 ${output.duplicates} 筆`:''} · 名稱依長度換行 · 實量欄留白供手寫</p>`;
  document.querySelectorAll<HTMLElement>('[data-step]').forEach(step=>step.classList.toggle('active',Number(step.dataset.step)===(ready?3:rows.length?2:1)));
}
/** Drops recognition and review results; the queued files stay. */
async function resetResults(){
  documentNumber++;await job?.cancel();if(timer)clearInterval(timer);timer=undefined;source=undefined;job=undefined;rows=[];pages=[];storeName='';storeNote='';selectedPage=1;filterIssues=true;processingMessage='';elapsedSeconds=0;stats.renderedPages=stats.peakOCRCanvases=0;invalidatePDF();
  el<HTMLInputElement>('issues-only').checked=true;el<HTMLInputElement>('store-name').value='';
}
async function clear(){
  await resetResults();const files=queue;queue=[];forcedRotations.clear();await Promise.all(files.map(file=>file.dispose()));
  el<HTMLInputElement>('file-input').value='';showError('');renderQueue();updateReview();
}
function startJob(){
  if(!queue.length)return;const set=new SourceSet([...queue]);source=set;const docNo=++documentNumber;const engine=new OCREngine(message=>{processingMessage=message;updateProgress();});
  // A file whose first page was retried by hand keeps that orientation.
  set.files.forEach((file,i)=>{const rotation=forcedRotations.get(file);if(rotation!==undefined)engine.fileLayout(i).rotation=rotation;});
  rows=[];pages=[];storeNote='';selectedPage=1;filterIssues=true;el<HTMLInputElement>('issues-only').checked=true;invalidatePDF();
  // Callbacks from a job of an earlier document must never write into this one.
  const current=()=>docNo===documentNumber;
  job=new InventoryJob(engine,set,{state:()=>{if(!current())return;updateProgress();updateReview();if(job?.state==='complete'||job?.state==='error'||job?.state==='cancelled'){if(timer)clearInterval(timer);timer=undefined;}if(job?.state==='complete'||job?.state==='error')scrollToNextAction();},
    page:(report,pageRows)=>{if(!current())return;admitPage(report,pageRows);pages.push(report);pages.sort((a,b)=>a.page-b.page);stats.renderedPages++;stats.peakOCRCanvases=Math.max(stats.peakOCRCanvases,engine.peakCanvases);
      if(report.storeName&&!storeName){storeName=report.storeName;el<HTMLInputElement>('store-name').value=storeName;}
      invalidatePDF();updateProgress();updateReview();},
    error:(message,page)=>{if(current())showError(page!==undefined&&set.files.length>1?`${pageLabel(page)}（${set.files[set.fileIndex(page)].file.name}）：${message}`:message);},
    checkpoint:()=>checkStores(set,current)});
  if(timer)clearInterval(timer);startedAt=Date.now();timer=setInterval(()=>{elapsedSeconds=Math.round((Date.now()-startedAt)/1000);updateProgress();},1000);updateReview();void job.run();
}
/**
 * Several files are merged only when they are reports of one store. Runs after
 * the first page of every file is read, before the remaining pages.
 */
async function checkStores(set:SourceSet,current:()=>boolean):Promise<string|undefined>{
  if(!current())return undefined;processingMessage='確認各檔案是否為同一門市';updateProgress();
  const files=set.files.map((file,i)=>{const report=pages.find(page=>page.page===set.starts[i]);return {name:file.file.name,storeName:report?.storeName??'',exact:report?.mode==='text'};});
  const check=compareStores(files);const unread='未能辨識門市名稱';
  if(check.result==='same'){storeNote=`同一門市「${check.name}」`;updateProgress();return undefined;}
  const stop='請移除不屬於同一門市的檔案，再按「重新開始辨識」。';
  if(check.result==='different')return `各檔案的門市不同，已停止辨識：${files.map((file,i)=>`第 ${i+1} 份 ${file.name}「${file.storeName||unread}」`).join('、')}。${stop}`;
  const list=`<ul class="store-list">${files.map((file,i)=>`<li><span>第 ${i+1} 份 · ${escape(file.name)}</span><strong>${escape(file.storeName||unread)}</strong></li>`).join('')}</ul>`;
  const same=await ask('確認是同一門市',`<p>多份庫存表必須是同一門市才能合併。下列門市名稱無法自動確認一致（掃描辨識的文字可能有誤），請對照原始報表後決定。</p>${list}`,'不是，停止辨識','是同一門市，繼續');
  if(!current())return undefined;
  if(same){storeNote='已人工確認為同一門市';updateProgress();return undefined;}
  return `已停止辨識：未確認各檔案為同一門市。${stop}`;
}
/** A two-button question. Escape or closing counts as cancel. */
function ask(title:string,html:string,cancel:string,ok:string):Promise<boolean>{
  const dialog=el<HTMLDialogElement>('ask-dialog');el('ask-title').textContent=title;el('ask-text').innerHTML=html;el('ask-cancel').textContent=cancel;el('ask-continue').textContent=ok;
  return new Promise(resolve=>{
    const done=(value:boolean)=>{dialog.removeEventListener('close',onClose);if(dialog.open)dialog.close();resolve(value);};
    const onClose=()=>done(false);dialog.addEventListener('close',onClose);
    el('ask-continue').onclick=()=>done(true);el('ask-cancel').onclick=()=>done(false);
    dialog.showModal();el<HTMLButtonElement>('ask-cancel').focus();
  });
}
/** Asks whether to add a low-resolution scan. */
function confirmLowResolution(name:string,dpi:number,estimated:boolean):Promise<boolean>{
  return ask('掃描解析度偏低',`<p>${escape(name)}：這份掃描${estimated?'估計':'約'}為 ${dpi} dpi，低於建議的 ${MIN_SCAN_DPI} dpi。解析度越低，代號、帳量與名稱的辨識錯誤越多，需要更多人工校對（實測 200 dpi 的掃描：名稱完全正確只有 7/61 筆，帳量讀錯 2 筆；600 dpi 為 0 筆）。建議以 ${MIN_SCAN_DPI} dpi 以上、灰階重新掃描。${estimated?'圖片檔以整張 A4 估算，若只拍到部分頁面，實際解析度可能較高。':''}</p>`,'不加入，重新掃描','仍要加入');
}
/** Changing the files after a finished job discards its results; ask first so review work is not lost by accident. */
const confirmDiscard=()=>job?.state!=='complete'?Promise.resolve(true):ask('清除目前結果？','<p>加入或移除檔案會清除目前的辨識與校對結果，之後需重新按「開始辨識」。</p>','保留目前結果','清除並更新檔案');
const sameFile=(a:File,b:File)=>a.name===b.name&&a.size===b.size&&a.lastModified===b.lastModified;
/** Adds files to the queue only; recognition waits for the start button. Files chosen while others are still opening join them. */
let pendingFiles:File[]=[];
async function addFiles(files:File[]){
  if(adding){pendingFiles.push(...files);return;}
  if(busy()||!files.length||!(await confirmDiscard()))return;
  adding=true;pendingFiles=[...files];showError('');await resetResults();updateProgress();updateReview();const problems:string[]=[];
  try{
    while(pendingFiles.length){const file=pendingFiles.shift()!;
      if(queue.some(item=>sameFile(item.file,file))){problems.push(`${file.name} 已在清單中。`);continue;}
      if(queue.reduce((total,item)=>total+item.file.size,0)+file.size>LIMITS.bytes){problems.push(`${file.name}：檔案合計超過 200 MB，請分批處理。`);continue;}
      let opened:DocumentSource|undefined;
      try{
        opened=await DocumentSource.open(file);
        if(queue.reduce((total,item)=>total+item.pages,0)+opened.pages>LIMITS.pages)throw new Error('檔案合計超過 200 頁，請分批處理。');
        // A 300 dpi scan can measure a little under 300; only clearly lower scans ask first.
        const dpi=await opened.scanDpi();
        if(dpi!==undefined&&dpi<MIN_SCAN_DPI*.97&&!(await confirmLowResolution(file.name,dpi,!opened.pdf)))throw new Error(`已略過（掃描約 ${dpi} dpi）。請以 ${MIN_SCAN_DPI} dpi 以上重新掃描後再加入。`);
        queue.push(opened);opened=undefined;renderQueue();
      }catch(error){problems.push(`${file.name}：${error instanceof Error?error.message:'無法開啟檔案。'}`);}
      finally{await opened?.dispose();}
    }
  }finally{adding=false;}
  showError(problems.join('\n'));renderQueue();updateReview();
}
async function removeFile(index:number){
  if(busy()||!queue[index]||!(await confirmDiscard()))return;
  await resetResults();const [removed]=queue.splice(index,1);forcedRotations.delete(removed);await removed.dispose();showError('');renderQueue();updateReview();
}
async function start(){
  if(busy()||!queue.length||job?.state==='complete')return;
  await resetResults();showError('');startJob();renderQueue();
}
el('drop-zone').addEventListener('click',()=>{if(!busy())el<HTMLInputElement>('file-input').click();});
el('drop-zone').addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();if(!busy())el<HTMLInputElement>('file-input').click();}});
el<HTMLInputElement>('file-input').addEventListener('change',event=>{const input=event.target as HTMLInputElement;const files=[...input.files??[]];input.value='';void addFiles(files);});
el('drop-zone').addEventListener('dragover',event=>{event.preventDefault();if(!busy())el('drop-zone').classList.add('dragging');});
el('drop-zone').addEventListener('dragleave',()=>el('drop-zone').classList.remove('dragging'));
el('drop-zone').addEventListener('drop',event=>{event.preventDefault();el('drop-zone').classList.remove('dragging');if(busy())return;void addFiles([...event.dataTransfer?.files??[]]);});
el('file-list').addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');if(button)void removeFile(Number(button.dataset.remove));});
el('start').addEventListener('click',()=>void start());
el('clear-queue').addEventListener('click',async()=>{if(!busy()&&await confirmDiscard())void clear();});
el('pause').addEventListener('click',()=>{job?.pause();updateProgress();});el('resume').addEventListener('click',()=>job?.resume());el('cancel').addEventListener('click',()=>void job?.cancel());el('clear').addEventListener('click',()=>void clear());
el<HTMLSelectElement>('page-select').addEventListener('change',event=>{selectedPage=Number((event.target as HTMLSelectElement).value);updateReview();});
el<HTMLInputElement>('issues-only').addEventListener('change',event=>{filterIssues=(event.target as HTMLInputElement).checked;updateReview();});
el('review-body').addEventListener('input',event=>{
  const input=event.target as HTMLInputElement;const id=input.closest<HTMLElement>('[data-row]')?.dataset.row;const row=rows.find(r=>r.id===id);
  if(!row||!input.dataset.field)return;
  const field=input.dataset.field as 'sku'|'name'|'location'|'bookQty';row[field]=input.value.trim();row.attention=true;row.reviewed=false;invalidatePDF();
  el('stat-pending').textContent=String(rows.filter(r=>!r.reviewed||validationErrors(r).length).length);const check=input.closest('tr')?.querySelector<HTMLInputElement>('[data-confirm-row]');if(check)check.checked=false;updateExport();
});
el('review-body').addEventListener('keydown',event=>{
  const input=event.target as HTMLInputElement;if(event.key!=='Enter'||event.isComposing||input.type==='checkbox'||!input.dataset.field)return;
  event.preventDefault();const id=input.closest<HTMLElement>('[data-row]')?.dataset.row;const field=input.dataset.field;
  input.dispatchEvent(new Event('change',{bubbles:true}));if(id)focusNextRow(id,field);
});
el('review-body').addEventListener('change',event=>{
  const input=event.target as HTMLInputElement;const id=input.closest<HTMLElement>('[data-row]')?.dataset.row;const row=rows.find(r=>r.id===id);if(!row)return;
  if(input.matches('[data-confirm-row]')){
    if(busy())return;
    invalidatePDF();row.reviewed=input.checked&&validationErrors(row).length===0;
    if(row.reviewed)delete row.numberDoubts;
    updateReview();if(exportReady())scrollToNextAction();return;
  }
  if(!input.dataset.field)return;
  invalidatePDF();const field=input.dataset.field as 'sku'|'name'|'location'|'bookQty';row[field]=input.value.trim();if(field==='bookQty')row.bookQty=canonicalQuantity(row.bookQty)??row.bookQty;row.attention=true;row.reviewed=false;
  updateReview();
});
el('review-body').addEventListener('click',event=>{
  const pick=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-pick]');
  if(pick){const id=pick.closest<HTMLElement>('[data-row]')?.dataset.row;const row=rows.find(r=>r.id===id);if(!row)return;
    const field=pick.dataset.pick as 'sku'|'bookQty';row[field]=pick.dataset.value!;delete row.numberDoubts?.[field];row.issues=row.issues.filter(i=>!doubtIssue[field].test(i));
    invalidatePDF();row.attention=true;row.reviewed=false;updateReview();return;}const id=(event.target as HTMLElement).closest<HTMLElement>('.trace-button')?.dataset.id;if(id){const row=rows.find(r=>r.id===id);if(row)void showTrace(row);}});
// ← → change the review page unless the user is typing or a dialog is open.
document.addEventListener('keydown',event=>{
  if(filterIssues||!['ArrowLeft','ArrowRight'].includes(event.key)||el('review').hidden||document.querySelector('dialog[open]'))return;
  const target=event.target as HTMLElement;if(target.closest?.('input:not([type="checkbox"]),textarea,select,[contenteditable="true"]'))return;
  event.preventDefault();stepPage(event.key==='ArrowRight'?1:-1);
});
el('view-page').addEventListener('click',()=>void showTrace());
el('close-trace').addEventListener('click',()=>el<HTMLDialogElement>('trace-dialog').close());
el<HTMLDialogElement>('trace-dialog').addEventListener('close',()=>{if(activeDialogCanvas)activeDialogCanvas.width=activeDialogCanvas.height=1;activeDialogCanvas=undefined;currentTrace=undefined;el('trace-content').innerHTML='';});
async function showTrace(row?:InventoryRow){
  if(!source)return;const page=row?.page??selectedPage;const report=pages.find(p=>p.page===page);if(!report)return;
  currentTrace=row;el('trace-title').textContent=row?`${row.sku} · ${pageLabel(page)}原圖`:`${pageLabel(page)}原圖`;
  el('trace-content').innerHTML='<p class="loading-text">正在載入原圖…</p>';el<HTMLDialogElement>('trace-dialog').showModal();
  try {
    const original=await source.render(page);let canvas=rotateCanvas(original,report.rotation);if(report.deskew){const adjusted=rotateCanvas(canvas,report.deskew);if(canvas!==original)canvas.width=canvas.height=1;canvas=adjusted;}
    if(row){const boxes=Object.values(row.boxes);const top=Math.max(0,Math.min(...boxes.map(b=>b.y))-.006);const bottom=Math.min(1,Math.max(...boxes.map(b=>b.y+b.height))+.006);const strip=cropCanvas(canvas,{x:0,y:top*canvas.height,width:canvas.width*.86,height:(bottom-top)*canvas.height});if(canvas!==original)canvas.width=canvas.height=1;canvas=strip;}
    if(canvas!==original)original.width=original.height=1;activeDialogCanvas=canvas;
    el('trace-content').innerHTML=`<div class="trace-image"><img alt="${row?'本筆資料':'來源頁'}原始掃描影像" src="${canvas.toDataURL('image/png')}"></div>${row?`<div class="trace-edit"><label>原名稱（含前綴）<textarea id="trace-raw" rows="3">${escape(row.rawName)}</textarea></label><label>清理後名稱<input id="trace-name" value="${escape(row.name)}"></label><p class="issue-text">${escape(row.issues.join('；'))}</p><button id="apply-trace" class="button primary">套用名稱修改</button></div>`:'<p class="preview-note">可使用瀏覽器放大檢視。店名只作為門市資訊，不是辨識條件。</p>'}`;
    el('apply-trace')?.addEventListener('click',()=>{if(!currentTrace)return;invalidatePDF();currentTrace.rawName=el<HTMLTextAreaElement>('trace-raw').value.trim();currentTrace.name=el<HTMLInputElement>('trace-name').value.trim();currentTrace.attention=true;currentTrace.reviewed=false;updateReview();el<HTMLDialogElement>('trace-dialog').close();});
    // Re-derive the cleaned name from the raw text only while the user has not typed in the name field.
    let nameEdited=false;el<HTMLInputElement>('trace-name')?.addEventListener('input',()=>{nameEdited=true;});
    el<HTMLTextAreaElement>('trace-raw')?.addEventListener('input',()=>{if(!nameEdited)el<HTMLInputElement>('trace-name').value=cleanProductName(el<HTMLTextAreaElement>('trace-raw').value).name;});
  }catch(error){el('trace-content').textContent=error instanceof Error?error.message:'無法載入原圖。';}
}
el('retry-controls').addEventListener('click',async event=>{
  const target=(event.target as HTMLElement).closest<HTMLElement>('[data-rotate]');if(!target||!source||busy())return;const rotation=Number(target.dataset.rotate);
  const set=source;const page=selectedPage;const file=set.fileIndex(page);const learnt=job?.engine.files.get(file);
  // The job stops when the first page of a file is not recognised, so a later-page retry
  // could never complete it: read again with that file turned this way.
  if(job?.state==='error'||(!learnt?.layout&&!learnt?.textLayout)){showError('');forcedRotations.set(set.files[file],rotation);startJob();return;}
  retrying=true;updateProgress();updateReview();const docNo=documentNumber;const engine=new OCREngine(message=>{processingMessage=message;updateProgress();});
  // Later pages reuse the columns of their own file only.
  engine.fileLayout(file).layout=learnt.layout;
  try{await engine.initialize();const result=await engine.extract(set,page,rotation);
    if(docNo===documentNumber){rows=rows.filter(r=>r.page!==page);pages=pages.map(p=>p.page===page?result.report:p);admitPage(result.report,result.rows);invalidatePDF();}
  }catch(error){showError(error instanceof Error?error.message:'重試失敗。');}finally{await engine.terminate();retrying=false;updateProgress();updateReview();}
});
el<HTMLInputElement>('store-name').addEventListener('input',event=>{storeName=(event.target as HTMLInputElement).value.trim();invalidatePDF();updateExport();});
el<HTMLSelectElement>('sort').addEventListener('change',event=>{sortMode=(event.target as HTMLSelectElement).value as SortMode;invalidatePDF();updateExport();});
el<HTMLSelectElement>('row-height').addEventListener('change',event=>{rowHeight=Number((event.target as HTMLSelectElement).value) as RowHeight;invalidatePDF();updateExport();});
const exportReady=()=>canExport(rows,pages,job?.state==='complete'&&pages.length===source?.pages);
const pdfName=()=>`${storeName||'門市'}_盤點表_${sortMode==='sku'?'六編碼':'儲位'}.pdf`;
async function preparePDF(){
  if(!exportReady())throw new Error('請先完成全部資料與格式校對。');
  const day=today();const date=formatDay(day);
  if(pdfBytes&&pdfRevision===generation&&pdfDay===date)return;generating=true;updateProgress();updateExport();const version=generation;
  // Build from a frozen copy so the PDF is exactly the data confirmed at this revision.
  const output=printable(structuredClone(rows));const snapshot=output.rows;const time=new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
  const names=source?.files.map(file=>file.file.name)??[];
  const sourceLabel=`來源 ${names.length>1?`${names[0]} 等 ${names.length} 個檔案`:names[0]??''} · 輸出 ${snapshot.length} 筆${output.duplicates?` · 刪除重複 ${output.duplicates} 筆`:''} · 校對版本 ${version} · ${time} 產生`;
  try{const result=await generatePDF(snapshot,{storeName,sortMode,rowHeight,source:sourceLabel,warning:inventoryWarning(pages,day)});
    if(version!==generation)throw new Error('產生 PDF 期間資料或設定已變更，請重新確認修改的項目後再下載。');
    if(date!==formatDay(today()))throw new Error('日期已變更，請重新下載以更新庫存時效警語。');
    const url=URL.createObjectURL(new Blob([result.bytes.slice().buffer],{type:'application/pdf'}));if(pdfUrl)URL.revokeObjectURL(pdfUrl);
    pdfBytes=result.bytes;pdfRevision=version;pdfDay=date;pdfUrl=url;
    if(el<HTMLDialogElement>('pdf-dialog').open){el<HTMLIFrameElement>('pdf-frame').src=url;el<HTMLAnchorElement>('pdf-open-tab').href=url;}}
  finally{generating=false;updateProgress();updateExport();}
}
function currentPDF():Uint8Array{
  if(!pdfBytes||pdfRevision!==generation||pdfDay!==formatDay(today())||!exportReady())throw new Error('盤點表資料或日期已變更，請重新產生。');
  return pdfBytes;
}
function saveBytes(bytes:Uint8Array,name:string){const url=URL.createObjectURL(new Blob([bytes.slice().buffer],{type:'application/pdf'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function downloadPDF(){if(generating)return;try{await preparePDF();saveBytes(currentPDF(),pdfName());}catch(error){if(el<HTMLDialogElement>('pdf-dialog').open)el<HTMLDialogElement>('pdf-dialog').close();showError(error instanceof Error?error.message:'PDF 產生失敗。');}}
el('download-pdf').addEventListener('click',()=>void downloadPDF());
el('preview-pdf').addEventListener('click',async()=>{try{await preparePDF();currentPDF();el<HTMLIFrameElement>('pdf-frame').src=pdfUrl;el<HTMLAnchorElement>('pdf-open-tab').href=pdfUrl;el<HTMLDialogElement>('pdf-dialog').showModal();}catch(error){showError(error instanceof Error?error.message:'PDF 產生失敗。');}});
el('close-pdf').addEventListener('click',()=>el<HTMLDialogElement>('pdf-dialog').close());el('dialog-download').addEventListener('click',()=>void downloadPDF());
el('scan-test').addEventListener('click',async()=>{try{const result=await generatePDF(scanTestRows(),{storeName:'掃描器實機驗收',sortMode:'sku',rowHeight:22.6,title:'相鄰條碼掃讀測試',note:'請以原尺寸 100% 列印，掃描每列，確認六碼與前導零。'});saveBytes(result.bytes,'條碼掃讀測試_A4.pdf');}catch(error){showError(error instanceof Error?error.message:'測試頁產生失敗。');}});
renderQueue();updateReview();
if(import.meta.env.DEV){Object.defineProperty(window,'inventoryQA',{get:()=>({state:job?.state,completed:job?.completed,total:source?.pages,rows:rows.length,pending:rows.filter(r=>!r.reviewed).length,rejected:pages.filter(p=>p.status==='rejected').length,elapsedSeconds,stats,results:rows,pages,headers:job?.engine.headerDebug})});}
