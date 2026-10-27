import './arithmetic.css';
import { autoCalculate, rangeDays, sameOutcome, shortDate, taiwanToday, dayNumber, type AutoInput, type DateRange, type Scenario } from './arithmetic-model';
import { parsePrescription, parsePrescriptionSlip, type PrescriptionQR } from './prescription-qr';
import { addPrescription } from './slip-ui';

declare const __APP_VERSION__: string;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = element<HTMLFormElement>('prescription-form');
const date = element<HTMLInputElement>('prescription-date');
const days = element<HTMLSelectElement>('days');
const count = element<HTMLSelectElement>('count');
const visit = element<HTMLSelectElement>('visit');
const previous = element<HTMLInputElement>('previous-date');
const result = element('result');
const status = element('qr-status');
const datePicker = element<HTMLInputElement>('date-picker');
const grid = element('calculator-grid');
/** 試算 accepts a typed date; 憑單 needs every QR field, so it takes scans only and shows the slip instead of the result. */
let mode: 'calc' | 'slip' = 'calc';
let calcDate = '';
let scanBuffer = '';
let scanTimer: ReturnType<typeof setTimeout> | undefined;
/** When the input method last composed in the entry field; a page cannot switch the IME, so a scan typed through it is dropped. */
let imeAt = -Infinity;
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
  previous.max = today;
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
  // A window recalculated from a late pickup (today's, or the previous one) and clamped by expiry leaves fewer days than the normal 10.
  const recalculated = value.state === 'late' || !!value.shift;
  const show = (text: string, range: DateRange) => {
    const span = rangeDays(range);
    const compressed = recalculated && span < 10;
    box.classList.toggle('compressed', compressed);
    label.textContent = `${text}${compressed ? `僅有${span}天` : ''}`;
    dates.textContent = rangeText(range);
  };
  const moved = value.shift ? `依前次 ${shortDate(value.shift.previous)} 逾期領藥順延 · ` : '';
  if (value.state === 'early') show(`${moved}本次可領藥區間`, value.schedule[visit - 1]);
  else if (value.next) show(`${value.state === 'late' ? '延遲後修正 · ' : moved}${visit === count ? '下次回診區間' : '下次領藥區間'}`, value.next);
  else {
    // A late pickup that leaves no further window is as urgent as a compressed one.
    box.classList.toggle('compressed', value.state === 'late');
    label.textContent = value.state === 'late' ? '請回診 · 建議最早日期' : `${moved}本次為最後一次 · 最早回診日`;
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
        inferred.textContent = `依${input.previous ? '前次領藥日' : '今日'}判斷：第 ${scenario.visit} 次領藥${merged ? '（可調劑 2 或 3 次結果相同）' : ''}`;
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
    // Only where it could mislead: a refill "in the original window" right after a late pickup the tool was not told about.
    const live = shown.filter(s => s.result.state !== 'invalid');
    const reminder = !input.previous ? (live.some(s => s.visit >= 2 && s.result.state === 'normal') ? '前次如逾期領藥，請填前次逾期領藥日重算。' : '')
      : live.length && live.every(s => !s.result.shift) ? '前次領藥日未造成順延，時程不變。' : '';
    if (reminder) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = reminder;
      result.append(hint);
    }
    if (!live.length) return;
    const longest = scenarios.at(-1)!.result;
    const table = document.createElement('table');
    table.className = 'schedule';
    const caption = table.createCaption();
    caption.textContent = longest.shift ? '時程（依前次領藥日順延）' : '原定時程';
    const body = table.createTBody();
    const suffix = (s: Scenario) => scenarios.length > 1 ? `（可調劑 ${s.count} 次）` : '';
    // Moved rows show the new dates first and the prescription's own dates after them.
    const was = (now: string, before?: string) => before && before !== now ? `原 ${before}` : '';
    const short = (range: DateRange) => range.start === range.end ? shortDate(range.start) : `${shortDate(range.start)}～${shortDate(range.end)}`;
    for (const [label, dates, before] of [
      ...(longest.shift?.original ?? longest.schedule).map((range, i) => {
        const now = longest.schedule[i];
        return [`第 ${i + 1} 次領藥`, now ? rangeText(now) : '已無（前次逾期）', longest.shift ? was(now ? short(now) : '', short(range)) : ''];
      }),
      ...scenarios.flatMap(s => [[`最早回診日${suffix(s)}`, fullDate(s.result.earliestReturn), was(shortDate(s.result.earliestReturn), s.result.shift && shortDate(s.result.shift.originalReturn))],
        [`處方失效日${suffix(s)}`, fullDate(s.result.expiry), '']]),
    ]) {
      const row = body.insertRow();
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = label;
      row.append(heading);
      const cell = row.insertCell();
      cell.textContent = dates;
      if (before) {
        const span = document.createElement('span');
        span.className = 'was';
        span.textContent = before;
        cell.append(span);
      }
      if (label.startsWith('處方失效日')) cell.className = 'expiry-date';
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
  previous.value = '';
  emptyResult();
  status.textContent = `已帶入 ${fullDate(data.date)}、${data.days} 天，並依今日判斷本次次數。請核對日期；如需指定可調劑次數或本次次數，請手動選擇。`;
  submit(false);
  // Stay on the entry field so the next prescription can be scanned right away.
  if (moveFocus) date.focus();
}
const imeWarning = () => `目前是中文輸入模式，掃碼內容會被輸入法攔截。請按 Shift 切換成英數後${mode === 'slip' ? '重新掃碼' : '重新掃碼或輸入日期'}。`;
function finishScan(moveFocus = true) {
  const value = scanBuffer;
  clearScan();
  if (!value) return;
  // Keys the IME let through between compositions are only part of the QR.
  if (performance.now() - imeAt < 1000) {
    date.value = '';
    status.textContent = imeWarning();
    if (moveFocus) date.focus();
    return;
  }
  // The keyboard scanner provides text, never raw bytes. Reject corrupted text.
  // Remove only CR/LF scanner suffixes, preserving prescription spaces and fields.
  const text = value.replace(/[\r\n]+$/, '');
  if (mode === 'slip') {
    date.value = '';
    let next: HTMLElement | undefined;
    try {
      const added = addPrescription(parsePrescriptionSlip(text));
      status.textContent = added.message;
      next = added.focus;
    }
    catch (error) { status.textContent = `${(error as Error).message} 請重新掃碼。`; }
    // An added prescription goes on to its refill count; a rejected or repeated scan stays here for the next try.
    if (moveFocus) (next ?? date).focus();
    return;
  }
  date.value = '';
  datePicker.value = '';
  days.value = '';
  count.value = '';
  visit.value = '';
  previous.value = '';
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
// Composition only happens with the Chinese IME on: drop what it composes and say how to switch to 英數.
date.addEventListener('compositionstart', () => {
  imeAt = performance.now();
  clearScan();
  status.textContent = imeWarning();
});
date.addEventListener('compositionend', () => {
  imeAt = performance.now();
  clearScan();
  date.value = '';
  status.textContent = imeWarning();
});
date.addEventListener('input', event => {
  if ((event as InputEvent).isComposing) return;
  date.setCustomValidity('');
  datePicker.value = '';
  // An input that only empties the field (as after a composition) keeps the IME warning.
  if (!date.value) return;
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
  // An Enter that commits a composition belongs to the IME, not to the scan.
  if (event.isComposing || event.key !== 'Enter' && event.key !== 'Tab') return;
  if (scanBuffer || date.value.includes(';')) {
    event.preventDefault();
    if (!scanBuffer) scanBuffer = date.value;
    finishScan();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    // The scanner's closing Enter after the IME took the QR keeps the IME warning.
    if (performance.now() - imeAt < 1000) { status.textContent = imeWarning(); return; }
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
  // Blank count or visit means "infer" (QR codes carry neither): from the previous pickup date when given, else from today.
  render({ date: normalizeDate(date.value), days: Number(days.value), count: Number(count.value) || undefined, visit: Number(visit.value) || undefined,
    previous: previous.value || undefined });
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
