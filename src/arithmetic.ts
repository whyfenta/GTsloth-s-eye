import './arithmetic.css';
import { calculate, taiwanToday, dayNumber, type PrescriptionInput, type DateRange } from './arithmetic-model';
import { parsePrescription, type PrescriptionQR } from './prescription-qr';

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
let scanBuffer = '';
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let today = taiwanToday();
let lastInput: PrescriptionInput | undefined;
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

function render(input: PrescriptionInput) {
  result.replaceChildren();
  try {
    const value = calculate(input, today);
    lastInput = input;
    const state = document.createElement('p');
    state.className = 'result-status';
    state.dataset.state = value.state;
    state.textContent = value.message;
    result.append(state);
    if (value.state === 'invalid') return;
    const recommendation = document.createElement('div');
    recommendation.className = 'recommended';
    const label = document.createElement('p');
    const dates = document.createElement('strong');
    if (value.state === 'early') {
      label.textContent = '本次可領藥區間';
      dates.textContent = rangeText(value.schedule[input.visit - 1]);
    } else if (value.next) {
      label.textContent = `${value.state === 'late' ? '延遲後修正 · ' : ''}${input.visit === input.count ? '下次回診區間' : '下次領藥區間'}`;
      dates.textContent = rangeText(value.next);
    } else {
      label.textContent = value.state === 'late' ? '請回診 · 建議最早日期' : '本次為最後一次 · 最早回診日';
      dates.textContent = fullDate(value.returnDate!);
    }
    recommendation.append(label, dates);
    result.append(recommendation);
    const table = document.createElement('table');
    table.className = 'schedule';
    const caption = table.createCaption();
    caption.textContent = '原定時程';
    const body = table.createTBody();
    for (const [label, dates] of [
      ...value.schedule.map((range, i) => [`第 ${i + 1} 次領藥`, rangeText(range)]),
      ['最早回診日', fullDate(value.earliestReturn)], ['處方失效日', fullDate(value.expiry)],
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
  date.placeholder = '掃碼或選擇日期';
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
  status.textContent = `已帶入 ${fullDate(data.date)}、${data.days} 天。請核對日期，並選擇可調劑次數與本次次數。`;
  if (moveFocus) count.focus();
}
function finishScan(moveFocus = true) {
  const value = scanBuffer;
  clearScan();
  if (!value) return;
  // The keyboard scanner provides text, never raw bytes. Reject corrupted text.
  // Remove only CR/LF scanner suffixes, preserving prescription spaces and fields.
  date.value = '';
  datePicker.value = '';
  days.value = '';
  count.value = '';
  visit.value = '';
  emptyResult();
  try { applyQR(parsePrescription(value.replace(/[\r\n]+$/, '')), moveFocus); }
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
    validateManualDate();
    if (date.reportValidity()) days.focus();
  }
});
date.addEventListener('blur', () => {
  if (scanBuffer) finishScan(false);
  else validateManualDate();
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
form.addEventListener('submit', event => {
  event.preventDefault();
  if (scanBuffer) { finishScan(); return; }
  refreshDate();
  validateManualDate();
  if (!form.reportValidity()) return;
  render({ date: normalizeDate(date.value), days: Number(days.value), count: Number(count.value), visit: Number(visit.value) });
  if (matchMedia('(max-width: 700px)').matches) result.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
form.addEventListener('input', emptyResult);
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
