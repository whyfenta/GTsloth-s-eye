import './collect.css';
import { taiwanToday } from './arithmetic-model';
import { SampleLog, scanKey, type InstitutionCount, type Recorded } from './prescription-sample';
import { SampleQueue } from './sample-queue';

declare const __APP_VERSION__: string;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scan = element<HTMLInputElement>('scan');
const status = element('scan-status');
const list = element<HTMLOListElement>('lines');
const copy = element<HTMLButtonElement>('copy');
const download = element<HTMLButtonElement>('download');
const clear = element<HTMLButtonElement>('clear');
const multiBox = element('multi');
const multiList = element<HTMLUListElement>('multi-list');
const copyMulti = element<HTMLButtonElement>('copy-multi');
element('version').textContent = __APP_VERSION__;

/** Holds the de-identified lines only, so a closed tab does not lose a shift's work. The scanned text is never written anywhere. */
const STORAGE = 'gtsloth-qr-samples';
const log = new SampleLog();
let scanBuffer = '';
let scanTimer: ReturnType<typeof setTimeout> | undefined;
/** When the input method last composed in the scan field; a page cannot switch the IME, so a scan typed through it is dropped. */
let imeAt = -Infinity;
/** Scans are digested one after another, so a quick rescan is compared with the scan before it. */
const queue = new SampleQueue();

function say(text: string, tone: 'ok' | 'warn' | 'error' = 'ok') {
  status.textContent = text;
  status.dataset.tone = tone;
}
function save(): boolean {
  try {
    if (log.entries.length) localStorage.setItem(STORAGE, JSON.stringify({ version: 2, lines: log.lines(), qrs: log.qrs() }));
    else localStorage.removeItem(STORAGE);
    return true;
  } catch { return false; }
}
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
    // Version 1 has no QR counts: every line was then one QR.
    const lines = Array.isArray(saved?.lines) && saved.lines.every((line: unknown) => typeof line === 'string') ? saved.lines as string[] : undefined;
    const qrs = saved?.version === 2 && Array.isArray(saved.qrs) && saved.qrs.length === lines?.length && saved.qrs.every((n: unknown) => Number.isInteger(n) && (n as number) >= 1) ? saved.qrs as number[] : undefined;
    if (lines && (saved.version === 1 || qrs)) log.restore(lines, qrs);
  } catch { /* Start empty. */ }
}
const multiText = (count: InstitutionCount) => `醫事機構代碼 ${count.institution}：${count.multi} 張有第 2 個 QR（此院所共收 ${count.prescriptions} 張）`;
function render(highlight?: number) {
  list.replaceChildren(...log.entries.map((entry, i) => {
    const item = document.createElement('li');
    item.classList.toggle('failed', !entry.ok);
    item.classList.toggle('flash', i === highlight);
    const number = document.createElement('span');
    number.className = 'line-number';
    number.textContent = String(i + 1);
    const line = document.createElement('code');
    line.textContent = entry.line;
    item.append(number, line);
    return item;
  }));
  list.hidden = !log.entries.length;
  element('lines-empty').hidden = !!log.entries.length;
  element('collected').textContent = String(log.collected);
  element('failed').textContent = log.failed ? `，失敗 ${log.failed} 次` : '';
  const institutions = log.institutions();
  multiBox.hidden = !institutions.length;
  element('multi-total').textContent = String(log.multi);
  multiList.replaceChildren(...institutions.map(count => {
    const item = document.createElement('li');
    item.textContent = multiText(count);
    return item;
  }));
  for (const button of [copy, download, clear]) button.disabled = !log.entries.length;
  if (highlight !== undefined) list.children[highlight]?.scrollIntoView({ block: 'nearest' });
}
load();
render();
if (log.entries.length) say(`已還原這台電腦先前收的 ${log.collected} 張。重新整理前收的處方，重刷時只能用去識別化結果判斷重複。`);

function clearScan() {
  clearTimeout(scanTimer);
  scanBuffer = '';
  scan.placeholder = '點這裡，再用掃碼機刷處方 QR';
}
const imeWarning = '目前是中文輸入模式，掃碼內容會被輸入法攔截。請按 Shift 切換成英數後重新掃碼。';
async function record(text: string, isCurrent: () => boolean) {
  let result: Recorded;
  try {
    const key = await scanKey(text);
    if (!isCurrent()) return;
    result = log.record(key, text);
  }
  catch { if (isCurrent()) say('這個瀏覽器無法處理掃碼，請改用最新版 Chrome 或 Edge 開啟本頁。', 'error'); return; }
  const unsaved = save() ? '' : ' 瀏覽器無法保存結果，關閉分頁前請先下載。';
  render(result.index);
  const at = `第 ${result.index + 1} 行`;
  if (result.state === 'added') say(`已加入${at}，共 ${log.collected} 張。${unsaved}`, unsaved ? 'warn' : 'ok');
  else if (result.state === 'appended') say(`這是只有藥品的第 2 個 QR，已把 ${result.drugs} 個藥接在${at}。它沒有病人與日期，只會接在上一張；如果不是同一張處方，請記下第 ${result.index + 1} 行告知藥師。${unsaved}`, unsaved ? 'warn' : 'ok');
  else if (result.state === 'duplicate') say(`重複：這張處方已在${at}，不重複加入。${unsaved}`, 'warn');
  else say(`無法解析，已在${at}記下原因與欄位數（不含原文）。請確認掃到的是處方 QR。${unsaved}`, 'error');
}
function finishScan() {
  const value = scanBuffer;
  clearScan();
  if (!value) return;
  // Keys the IME let through between compositions are only part of the QR.
  if (performance.now() - imeAt < 1000) { say(imeWarning, 'warn'); return; }
  // Remove only CR/LF scanner suffixes, preserving prescription spaces and fields.
  const text = value.replace(/[\r\n]+$/, '');
  // A product barcode or stray typing is not a prescription QR and is not recorded as a failure.
  if (!text.includes(';')) { say('這不是處方 QR（沒有以分號分隔的欄位），沒有記錄。', 'warn'); return; }
  void queue.enqueue(isCurrent => record(text, isCurrent));
}
// Composition only happens with the Chinese IME on: drop what it composes and say how to switch to 英數.
scan.addEventListener('compositionstart', () => {
  imeAt = performance.now();
  clearScan();
  say(imeWarning, 'warn');
});
scan.addEventListener('compositionend', () => {
  imeAt = performance.now();
  clearScan();
  scan.value = '';
  say(imeWarning, 'warn');
});
scan.addEventListener('input', event => {
  if ((event as InputEvent).isComposing || !scan.value) return;
  // The QR never stays in the field: each keystroke moves into the buffer.
  scanBuffer += scan.value;
  scan.value = '';
  scan.placeholder = '正在讀取掃碼…';
  clearTimeout(scanTimer);
  if (scanBuffer.length > 32_768) {
    clearScan();
    say('掃碼內容過長，請確認掃到處方 QR。', 'error');
    return;
  }
  scanTimer = setTimeout(finishScan, 400);
});
scan.addEventListener('paste', event => {
  event.preventDefault();
  clearScan();
  scanBuffer = event.clipboardData?.getData('text') ?? '';
  finishScan();
});
scan.addEventListener('keydown', event => {
  // An Enter that commits a composition belongs to the IME, not to the scan; Tab moves on unless it ends a scan.
  if (event.isComposing || event.key !== 'Enter' && event.key !== 'Tab' || event.key === 'Tab' && !scanBuffer) return;
  event.preventDefault();
  finishScan();
});
scan.addEventListener('blur', () => { if (scanBuffer) finishScan(); });

copy.addEventListener('click', () => {
  finishScan();
  void queue.enqueue(async isCurrent => {
    try {
      await navigator.clipboard.writeText(log.text());
      if (isCurrent()) say(`已複製 ${log.entries.length} 行，可以貼到訊息或文件交給藥師。`);
    } catch { if (isCurrent()) say('無法複製，請改按「下載 .txt」。', 'error'); }
  });
  scan.focus();
});
download.addEventListener('click', () => {
  finishScan();
  void queue.enqueue(() => {
    const url = URL.createObjectURL(new Blob([log.text()], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `處方QR去識別化_${taiwanToday().replaceAll('-', '')}_${log.collected}張.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    say(`已下載 ${log.entries.length} 行。`);
  });
  scan.focus();
});
copyMulti.addEventListener('click', () => {
  finishScan();
  void queue.enqueue(async isCurrent => {
    const text = [`有第 2 個 QR 的處方 ${log.multi} 張（共收 ${log.collected} 張）`, ...log.institutions().map(multiText)].join('\n') + '\n';
    try {
      await navigator.clipboard.writeText(text);
      if (isCurrent()) say('已複製第 2 個 QR 的院所統計。');
    } catch { if (isCurrent()) say('無法複製統計，請直接抄寫畫面上的院所代碼。', 'error'); }
  });
  scan.focus();
});
clear.addEventListener('click', () => {
  if (confirm(`確定要清除全部 ${log.entries.length} 行？請先複製或下載；清除後無法復原。`)) {
    queue.cancel();
    clearScan();
    scan.value = '';
    log.clear();
    save();
    render();
    say('已清除。');
  }
  scan.focus();
});
// Two tabs would overwrite each other's saved lines.
window.addEventListener('storage', event => {
  if (event.key === STORAGE) say('這個頁面在另一個分頁也開著，兩邊的結果會互相覆蓋。請關掉其中一個，只用一個分頁收集。', 'error');
});
window.addEventListener('pagehide', () => { clearScan(); scan.value = ''; });
