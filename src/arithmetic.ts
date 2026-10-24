import './arithmetic.css';
import { autoCalculate, rangeDays, sameOutcome, taiwanToday, dayNumber, type AutoInput, type DateRange, type Scenario } from './arithmetic-model';
import { parsePrescription, parsePrescriptionSlip, type PrescriptionQR } from './prescription-qr';
import { addPrescription } from './slip-ui';

declare const __APP_VERSION__: string;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = element<HTMLFormElement>('prescription-form');
const date = element<HTMLInputElement>('prescription-date');
const days = element<HTMLSelectElement>('days');
const count = element<HTMLSelectElement>('count');
const visit = element<HTMLSelectElement>('visit');
const result = element('result');
const status = element('qr-status');
const datePicker = element<HTMLInputElement>('date-picker');
const grid = element('calculator-grid');
/** 試算 accepts a typed date; 憑單 needs every QR field, so it takes scans only and shows the slip instead of the result. */
let mode: 'calc' | 'slip' = 'calc';
let calcDate = '';
let scanBuffer = '';
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let today = taiwanToday();
let lastInput: AutoInput | undefined;
element('version').textContent = __APP_VERSION__;

const fullDate = (value: string) => value.replaceAll('-', '/');
const rangeText = (range: DateRange) => range.start === range.end ? fullDate(range.start) : `${fullDate(range.start)} ～ ${fullDate(range.end)}`;
function emptyResult() {
  lastInput = undefined;
  result.replaceChildren();
  const p = document.createElement('p');
  p.className = 'empty-result';
  p.textContent = '完成欄位後按「試算領藥日期」，查看最新建議。';
  result.append(p);
}
function refreshDate() {
  const nextToday = taiwanToday();
  const changed = nextToday !== today;
  today = nextToday;
  datePicker.max = today;
  if (changed && lastInput) render(lastInput);
}
refreshDate();
setInterval(refreshDate, 15_000);
document.addEventListener('visibilitychange', refreshDate);
window.addEventListener('pageshow', refreshDate);

function recommendation(scenario: Scenario, prefix: string): HTMLElement[] {
  const { result: value, visit, count } = scenario;
  const state = document.createElement('p');
  state.className = 'result-status';
  state.dataset.state = value.state;
  state.textContent = prefix + value.message;
  if (value.state === 'invalid') return [state];
  const box = document.createElement('div');
  box.className = 'recommended';
  const label = document.createElement('p');
  const dates = document.createElement('strong');
  if (value.state === 'early') {
    label.textContent = '本次可領藥區間';
    dates.textContent = rangeText(value.schedule[visit - 1]);
  } else if (value.next) {
    // A late recalculation clamped by expiry leaves fewer days than a normal 10-day window.
    const span = rangeDays(value.next);
    const compressed = value.state === 'late' && span < 10;
    box.classList.toggle('compressed', compressed);
    label.textContent = `${value.state === 'late' ? '延遲後修正 · ' : ''}${visit === count ? '下次回診區間' : '下次領藥區間'}${compressed ? `僅有${span}天` : ''}`;
    dates.textContent = rangeText(value.next);
  } else {
    label.textContent = value.state === 'late' ? '請回診 · 建議最早日期' : '本次為最後一次 · 最早回診日';
    dates.textContent = fullDate(value.returnDate!);
  }
  box.append(label, dates);
  return [state, box];
}
function render(input: AutoInput) {
  result.replaceChildren();
  try {
    const scenarios = autoCalculate(input, today);
    lastInput = input;
    const merged = scenarios.length === 2 && sameOutcome(scenarios[0], scenarios[1]);
    const shown = merged ? [scenarios[1]] : scenarios;
    for (const scenario of shown) {
      if (scenario.inferred) {
        const inferred = document.createElement('p');
        inferred.className = 'inferred';
        inferred.textContent = `依今日判斷：第 ${scenario.visit} 次領藥${merged ? '（可調劑 2 或 3 次結果相同）' : ''}`;
        result.append(inferred);
      }
      const countPrefix = !input.count && !merged ? `若可調劑 ${scenario.count} 次：` : '';
      result.append(...recommendation(scenario, countPrefix));
      if (scenario.note) {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = scenario.note;
        result.append(note);
      }
    }
    if (shown.every(s => s.result.state === 'invalid')) return;
    const longest = scenarios.at(-1)!.result;
    const table = document.createElement('table');
    table.className = 'schedule';
    const caption = table.createCaption();
    caption.textContent = '原定時程';
    const body = table.createTBody();
    const suffix = (s: Scenario) => scenarios.length > 1 ? `（可調劑 ${s.count} 次）` : '';
    for (const [label, dates] of [
      ...longest.schedule.map((range, i) => [`第 ${i + 1} 次領藥`, rangeText(range)]),
      ...scenarios.flatMap(s => [[`最早回診日${suffix(s)}`, fullDate(s.result.earliestReturn)], [`處方失效日${suffix(s)}`, fullDate(s.result.expiry)]]),
    ]) {
      const row = body.insertRow();
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = label;
      row.append(heading);
      row.insertCell().textContent = dates;
    }
    result.append(table);
  } catch (error) {
    lastInput = undefined;
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = error instanceof Error ? error.message : '請核對輸入資料。';
    result.append(p);
  }
}
function clearScan() {
  clearTimeout(scanTimer);
  scanBuffer = '';
  date.placeholder = mode === 'slip' ? '掃描處方 QR' : '掃碼或選擇日期';
}
function normalizeDate(value: string): string {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
  if (!match) throw new Error('請選擇日期，或輸入西元年／月／日。');
  const normalized = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  dayNumber(normalized);
  return normalized;
}
function applyQR(data: PrescriptionQR, moveFocus = true) {
  clearScan();
  date.value = fullDate(data.date);
  datePicker.value = data.date;
  date.setCustomValidity('');
  days.value = String(data.days);
  count.value = '';
  visit.value = '';
  emptyResult();
  status.textContent = `已帶入 ${fullDate(data.date)}、${data.days} 天，並依今日判斷本次次數。請核對日期；如需指定可調劑次數或本次次數，請手動選擇。`;
  submit(false);
  // Stay on the entry field so the next prescription can be scanned right away.
  if (moveFocus) date.focus();
}
function finishScan(moveFocus = true) {
  const value = scanBuffer;
  clearScan();
  if (!value) return;
  // The keyboard scanner provides text, never raw bytes. Reject corrupted text.
  // Remove only CR/LF scanner suffixes, preserving prescription spaces and fields.
  const text = value.replace(/[\r\n]+$/, '');
  if (mode === 'slip') {
    date.value = '';
    try { status.textContent = addPrescription(parsePrescriptionSlip(text)); }
    catch (error) { status.textContent = `${(error as Error).message} 請重新掃碼。`; }
    if (moveFocus) date.focus();
    return;
  }
  date.value = '';
  datePicker.value = '';
  days.value = '';
  count.value = '';
  visit.value = '';
  emptyResult();
  try { applyQR(parsePrescription(text), moveFocus); }
  catch (error) {
    status.textContent = `${(error as Error).message} 請重新掃碼，或選擇日期。`;
    if (moveFocus) date.focus();
  }
}
function validateManualDate() {
  if (!date.value) { datePicker.value = ''; return; }
  try {
    const normalized = normalizeDate(date.value);
    date.value = fullDate(normalized);
    datePicker.value = normalized;
    date.setCustomValidity('');
  } catch (error) {
    datePicker.value = '';
    date.setCustomValidity((error as Error).message);
  }
}
date.addEventListener('focus', () => date.select());
date.addEventListener('input', () => {
  date.setCustomValidity('');
  datePicker.value = '';
  status.textContent = '';
  if (scanBuffer || date.value.includes(';')) {
    scanBuffer += date.value;
    date.value = '';
    date.placeholder = '正在讀取掃碼…';
    clearTimeout(scanTimer);
    if (scanBuffer.length > 32_768) {
      clearScan();
      status.textContent = '掃碼內容過長，請確認掃到處方 QR。';
      return;
    }
    scanTimer = setTimeout(() => finishScan(), 400);
  }
});
date.addEventListener('paste', event => {
  const value = event.clipboardData?.getData('text') ?? '';
  if (!value.includes(';')) return;
  event.preventDefault();
  clearScan();
  scanBuffer = value;
  finishScan();
});
date.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== 'Tab') return;
  if (scanBuffer || date.value.includes(';')) {
    event.preventDefault();
    if (!scanBuffer) scanBuffer = date.value;
    finishScan();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (mode === 'slip') { status.textContent = '憑單需要掃描處方 QR；只有日期時請切換到「試算」。'; return; }
    validateManualDate();
    if (date.reportValidity()) days.focus();
  }
});
date.addEventListener('blur', () => {
  if (scanBuffer) finishScan(false);
  else if (mode === 'calc') validateManualDate();
});
datePicker.addEventListener('click', event => {
  if (typeof datePicker.showPicker === 'function') {
    event.preventDefault();
    try { datePicker.showPicker(); } catch { /* Native picker remains available. */ }
  }
});
datePicker.addEventListener('change', () => {
  clearScan();
  date.value = datePicker.value ? fullDate(datePicker.value) : '';
  date.setCustomValidity('');
  status.textContent = '';
  emptyResult();
});
function submit(report = true) {
  refreshDate();
  validateManualDate();
  if (!(report ? form.reportValidity() : form.checkValidity())) return;
  // Blank count or visit means "infer from today" (QR codes carry neither).
  render({ date: normalizeDate(date.value), days: Number(days.value), count: Number(count.value) || undefined, visit: Number(visit.value) || undefined });
  if (matchMedia('(max-width: 700px)').matches) result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
form.addEventListener('submit', event => {
  event.preventDefault();
  if (scanBuffer) { finishScan(); return; }
  submit();
});
// Scans in 憑單 mode pass through the shared entry field; they must not clear the 試算 result.
form.addEventListener('input', () => { if (mode === 'calc') emptyResult(); });
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=mode]')) radio.addEventListener('change', () => {
  mode = radio.value === 'slip' ? 'slip' : 'calc';
  grid.dataset.mode = mode;
  clearScan();
  status.textContent = '';
  // Each mode keeps its own state; the shared entry field is empty for scanning in 憑單 mode.
  if (mode === 'slip') { calcDate = date.value; date.value = ''; date.setCustomValidity(''); }
  else date.value = calcDate;
  date.focus();
});
// Cancel before blur so a partial scan cannot move the reset button mid-click.
form.querySelector<HTMLButtonElement>('button[type=reset]')!.addEventListener('pointerdown', clearScan);
form.addEventListener('reset', () => {
  clearScan();
  date.setCustomValidity('');
  status.textContent = '';
  emptyResult();
  queueMicrotask(() => date.focus());
});
window.addEventListener('pagehide', () => { clearScan(); date.value = ''; });
