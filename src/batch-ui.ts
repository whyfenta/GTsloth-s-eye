// 批次蒐集 on 樹懶的算數 (desktop only): the 收集頁's de-identified lines, scanned one after another at the end of a shift and
// sent to the sample sheet on 確認匯入, with no .txt. One patient's prescriptions are listed together and their 處方警示 checked
// as one before they go, and each line goes with what that combined check adds to it (合併多出), as a printed 憑單 sends it.
import { DEPARTMENTS } from './rx-check';
import { rxCheckOn } from './rx-check-config';
import { renderRxCheck } from './rx-check-ui';
import { loadRxData, type RxData } from './rx-data';
import { BatchLog, maskedName } from './batch-model';
import { postAppsScript } from './apps-script';
import { scanKey, type Recorded } from './prescription-sample';
import { lineFacts } from './rx-sample';
import { loadProducts } from './products';
import { splitFields } from './prescription-qr';
import { SAMPLE_ENDPOINT, samplesOn } from './sample-config';
import { SampleQueue } from './sample-queue';

declare const __APP_VERSION__: string;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const groupsList = element<HTMLOListElement>('batch-groups');
const empty = element('batch-empty');
const status = element('qr-status');
const importButton = element<HTMLButtonElement>('batch-import');
const clearButton = element<HTMLButtonElement>('batch-clear');

/** Needs the sample sheet's address: without it (or with ?samples=0) there is nowhere to import to, and the option is not offered. */
export const batchOn = samplesOn(location.search);
/** The de-identified lines only, so a closed tab does not lose the day's scans; the patients stay in page memory. */
const STORAGE = 'gtsloth-batch-samples';
const log = new BatchLog();
/** Scans are digested one after another and 確認匯入 waits for them, so nothing scanned before it is left out. */
const queue = new SampleQueue();
const rxOn = rxCheckOn(location.search);
let rxData: RxData | undefined;
let rxError = '';
let catalog: Map<string, unknown[]> | undefined;
let sending = false;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function say(text: string) { status.textContent = text; }
function save(): boolean {
  try {
    if (log.entries.length) localStorage.setItem(STORAGE, JSON.stringify(log.save()));
    else localStorage.removeItem(STORAGE);
    return true;
  } catch { return false; }
}
function load() {
  try { log.load(JSON.parse(localStorage.getItem(STORAGE) ?? 'null')); } catch { /* Start empty. */ }
}
/** The rule data and product lookup load on the first scan; a failed load is tried again on the next. */
function loadData() {
  if (!rxData) {
    rxError = '';
    loadRxData().then(loaded => { rxData = loaded; render(); }).catch((error: Error) => { if (!rxData) { rxError = error.message; render(); } });
  }
  if (!catalog) loadProducts().then(loaded => { catalog = loaded.index; }).catch(() => { /* Sent without 對照檔查無. */ });
}

const rocDate = (value: string) => /^\d{7}$/.test(value) ? `${value.slice(0, 3)}/${value.slice(3, 5)}/${value.slice(5, 7)}` : value || '日期不明';
/** One prescription as the list shows it: what the line keeps, read for checking that the right QR went in. */
function row(index: number, merged: string[]): HTMLLIElement {
  const entry = log.entries[index];
  const f = splitFields(entry.line);
  const dept = lineFacts(entry.line).dept;
  const li = make('li', 'batch-row');
  const text = [`院所 ${f[0]}`, `就醫 ${rocDate(f[7])}`, dept ? `${dept} ${DEPARTMENTS[dept] ?? ''}`.trim() : '科別未知',
    f[9] ? `${f[9]} 天` : '天數不明', `類型 ${f[1] || '—'}`, `${(f.length - 14) / 5} 個藥`, ...(entry.qrs > 1 ? [`${entry.qrs} 個 QR`] : []), f[5] || '年齡不明'];
  li.append(make('strong', '', `第 ${index + 1} 張`), make('span', '', text.join(' · ')));
  if (merged.length) li.append(make('span', 'batch-merged', `合併多出 ${merged.join('、')}`));
  if (log.isSent(entry)) li.append(make('span', 'batch-sent', '已匯入'));
  else li.append(removeButton(index));
  return li;
}
function removeButton(index: number): HTMLButtonElement {
  const button = make('button', 'batch-remove', '移除');
  button.type = 'button';
  button.addEventListener('click', () => {
    void queue.enqueue(() => {
      if (sending || !log.entries[index] || log.isSent(log.entries[index])) return;
      log.remove(index);
      const unsaved = save() ? '' : ' 瀏覽器無法保存這批，關閉分頁前請先匯入。';
      render();
      say(`已移除第 ${index + 1} 張，後面的往前遞補。${unsaved}`);
    });
  });
  return button;
}
function render(highlight?: number) {
  const groups = log.groups();
  const items: HTMLLIElement[] = groups.map((group, n) => {
    const li = make('li', 'batch-group');
    li.classList.toggle('flash', highlight !== undefined && group.includes(highlight));
    const first = log.entries[group[0]], person = log.person(first);
    const head = make('p', 'batch-group-head');
    head.append(make('strong', '', `病人 ${n + 1}`));
    const name = person ? maskedName(person.name) : '';
    if (name) head.append(make('span', 'batch-name', name));
    head.append(make('span', 'hint', [group.length > 1 ? `同一病人 ${group.length} 張處方，處方警示合併比對` : '',
      log.restored(first) ? '重新整理前收的，新刷的處方無法再和它合併' : ''].filter(Boolean).join('；')));
    const rows = make('ul', 'batch-rows');
    for (const index of group) rows.append(row(index, rxData && group.length > 1 ? log.merged(index, rxData, groups) : []));
    li.append(head, rows);
    if (rxOn) {
      const box = make('section', 'slip-rx-check');
      if (rxData) {
        const level = renderRxCheck(box, group.map(index => ({ rx: lineFacts(log.entries[index].line), names: [], label: `第 ${index + 1} 張` })), rxData, '匯入時附上判定摘要');
        if (level) li.dataset.rxLevel = level;
      } else box.append(make('p', rxError ? 'error' : 'hint', rxError || '處方警示資料載入中…'));
      li.append(box);
    }
    return li;
  });
  const failures = log.entries.flatMap((entry, i) => entry.ok ? [] : [i]);
  if (failures.length) {
    const li = make('li', 'batch-group batch-failures');
    li.classList.toggle('flash', highlight !== undefined && failures.includes(highlight));
    const rows = make('ul', 'batch-rows');
    for (const index of failures) {
      const item = make('li', 'batch-row');
      item.append(make('strong', '', `第 ${index + 1} 張`), make('span', '', log.entries[index].line));
      item.append(log.isSent(log.entries[index]) ? make('span', 'batch-sent', '已匯入') : removeButton(index));
      rows.append(item);
    }
    li.append(make('p', 'batch-group-head', `無法解析 ${failures.length} 次（只記原因與欄位數，匯入「失敗」分頁）`), rows);
    items.push(li);
  }
  groupsList.replaceChildren(...items);
  groupsList.hidden = !items.length;
  empty.hidden = !!items.length;
  const unsent = log.unsent;
  const several = groups.filter(group => group.length > 1).length;
  element('batch-collected').textContent = String(log.collected);
  element('batch-detail').textContent = [several ? `${several} 位病人有多張處方` : '', log.failed ? `失敗 ${log.failed} 次` : '',
    unsent.length < log.entries.length ? `已匯入 ${log.entries.length - unsent.length} 行` : ''].filter(Boolean).map(text => `，${text}`).join('');
  importButton.disabled = sending || !unsent.length;
  clearButton.disabled = sending || !log.entries.length;
  if (highlight !== undefined) groupsList.querySelector('.flash')?.scrollIntoView({ block: 'nearest' });
}

async function record(text: string, codes: number, isCurrent: () => boolean) {
  let result: Recorded;
  try {
    const key = await scanKey(text);
    if (!isCurrent()) return;
    result = log.scan(key, text, codes);
  } catch { if (isCurrent()) say('這個瀏覽器無法處理掃碼，請改用最新版 Chrome 或 Edge 開啟本頁。'); return; }
  const unsaved = save() ? '' : ' 瀏覽器無法保存這批，關閉分頁前請先匯入。';
  render(result.index);
  const at = `第 ${result.index + 1} 張`;
  const group = log.groups().find(members => members.includes(result.index)) ?? [];
  const same = group.length > 1 ? `與${group.filter(i => i !== result.index).map(i => `第 ${i + 1} 張`).join('、')}是同一病人，合併比對。` : '';
  if (result.state === 'added') say(`已加入${at}，共 ${log.collected} 張。${same}${unsaved}`);
  else if (result.state === 'appended') say(`這是只有藥品的第 2 個 QR，已把 ${result.drugs} 個藥接在${at}。它沒有病人與日期，只會接在上一張；接錯時請按該張的「移除」後重刷。${unsaved}`);
  else if (result.state === 'duplicate') say(`重複：這張處方已在${at}，不重複加入。${unsaved}`);
  else say(`無法解析，已在${at}記下原因與欄位數（不含原文），匯入時一併送出。請確認掃到的是處方 QR。${unsaved}`);
}
/** A scan in 批次蒐集; codes: how many linked QR codes (Structured Append) the text was joined from. */
export function batchScan(text: string, codes = 1) {
  if (sending) { say('正在匯入，請等匯入完成再刷下一張。'); return; }
  // A product barcode or stray typing is not a prescription QR and is not recorded as a failure.
  if (!text.includes(';')) { say('這不是處方 QR（沒有以分號分隔的欄位），沒有記錄。'); return; }
  loadData();
  void queue.enqueue(isCurrent => record(text, codes, isCurrent));
}
/** On entering 批次蒐集: what the browser kept from before, said once. */
export function batchEntered(): string {
  if (!log.entries.length) return '';
  loadData();
  return log.unsent.length ? `這台電腦還有上次未匯入的 ${log.unsent.length} 行，可接著刷，刷完一起按「確認匯入」。` : '';
}

async function importAll(isCurrent: () => boolean) {
  const unsent = log.unsent;
  if (!unsent.length) { say('沒有要匯入的處方。'); return; }
  const lines = unsent.filter(entry => entry.ok).length, failed = unsent.length - lines;
  const several = log.groups().filter(group => group.length > 1).length;
  if (!confirm(`匯入 ${lines} 張處方${failed ? `與 ${failed} 行失敗紀錄` : ''}到處方樣本試算表？${several ? `其中 ${several} 位病人有多張處方，已合併比對。` : ''}匯入後這一批會清空。`)) return;
  sending = true;
  render();
  say('匯入中…');
  try {
    let data = rxData;
    if (!data) try { data = rxData = await loadRxData(); } catch { /* Sent without the check summary. */ }
    if (!catalog) try { catalog = (await loadProducts()).index; } catch { /* Sent without 對照檔查無. */ }
    if (!isCurrent()) return;
    const requests = log.requests(data, catalog, `${__APP_VERSION__} 批次`, new Date().toISOString());
    let done = 0;
    for (const { record, entries } of requests) {
      try { await postAppsScript(SAMPLE_ENDPOINT, record); } catch { break; }
      log.markSent(entries);
      done += entries.filter(entry => entry.ok).length;
      save();
    }
    if (!log.unsent.length) {
      log.clear();
      save();
      say(`已匯入 ${lines} 張處方${failed ? `與 ${failed} 行失敗紀錄` : ''}到處方樣本試算表，這一批已清空。${data ? '' : '處方警示資料沒有載入，這批沒有附判定摘要。'}`);
    } else say(`網路問題，${done ? `已匯入 ${done} 張，其餘 ` : '這一批 '}${log.unsent.length} 行沒有送出，仍留在清單上；請確認網路後再按「確認匯入」。`);
  } finally {
    sending = false;
    render();
  }
}
importButton.addEventListener('click', () => { void queue.enqueue(importAll); });
clearButton.addEventListener('click', () => {
  const unsent = log.unsent.length;
  if (!confirm(unsent ? `確定要清空這一批？還有 ${unsent} 行沒有匯入，清空後無法復原。` : '確定要清空這一批？')) return;
  queue.cancel();
  log.clear();
  save();
  render();
  say('已清空這一批。');
});
// Two tabs would overwrite each other's batch; a tab with nothing scanned takes the other's instead.
window.addEventListener('storage', event => {
  if (event.key !== STORAGE) return;
  if (!log.entries.length) { load(); render(); return; }
  if (element('calculator-grid').dataset.mode === 'batch') say('這個頁面在另一個分頁也在批次蒐集，兩邊的清單會互相覆蓋。請關掉其中一個，只用一個分頁蒐集。');
});
if (batchOn) { load(); render(); }
