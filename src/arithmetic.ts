import './arithmetic.css';
import { dial, rangeDays, shortDate, taiwanToday, dayNumber, type DateRange, type DialSlot, type Scenario } from './arithmetic-model';
import { parsePrescription, parsePrescriptionDrugs, parsePrescriptionSlip, type PrescriptionQR } from './prescription-qr';
import { addDrugs, addPrescription } from './slip-ui';

declare const __APP_VERSION__: string;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = element<HTMLFormElement>('prescription-form');
const date = element<HTMLInputElement>('prescription-date');
const days = element<HTMLSelectElement>('days');
const count = element<HTMLSelectElement>('count');
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
type DialInput = Parameters<typeof dial>[0];
let lastInput: DialInput | undefined;
/** The actual date of the last opened visit's pickup, given on the idle slot; it belongs to the input it was given for, and a day change keeps it. */
let previousDate = '';
element('version').textContent = __APP_VERSION__;

const fullDate = (value: string) => value.replaceAll('-', '/');
const rangeText = (range: DateRange) => range.start === range.end ? fullDate(range.start) : `${fullDate(range.start)} ～ ${fullDate(range.end)}`;
function emptyResult() {
  lastInput = undefined;
  result.replaceChildren();
  const p = document.createElement('p');
  p.className = 'empty-result';
  p.textContent = '填好處方日期與給藥日份，結果就會出現在這裡。';
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
/** Not picking up today: the last opened visit was picked up already, so book the next one, or after the last one, see the doctor again. */
function idleRecommendation(scenario: Scenario, prefix: string): HTMLElement[] {
  const { result: value, visit } = scenario;
  // A previous pickup date that cannot be right says so as before.
  if (value.state !== 'early' && !value.returnDate) return recommendation(scenario, prefix);
  const state = document.createElement('p');
  state.className = 'result-status';
  state.dataset.state = value.state;
  const box = document.createElement('div');
  box.className = 'recommended';
  const label = document.createElement('p');
  const dates = document.createElement('strong');
  if (value.returnDate) {
    state.textContent = prefix + value.message;
    label.textContent = '請回診 · 建議最早日期';
    dates.textContent = fullDate(value.returnDate);
  } else {
    // Expiry can cut a window moved by a late previous pickup short.
    const range = value.schedule[visit - 1], span = rangeDays(range), compressed = !!value.shift && span < 10;
    state.textContent = `${prefix}第 ${visit - 1} 次已領，預約第 ${visit} 次。`;
    box.classList.toggle('compressed', compressed);
    label.textContent = `${value.shift ? `依前次 ${shortDate(value.shift.previous)} 逾期領藥順延 · ` : ''}第 ${visit} 次可領藥區間${compressed ? `僅有${span}天` : ''}`;
    dates.textContent = rangeText(range);
  }
  box.append(label, dates);
  return [state, box];
}
interface DialEntry { tick: string; title: string; badge: string; body: HTMLElement[] }
/** A meter-style dial: one result in a fixed window, its neighbours peeking above and below, turned by the wheel, arrow keys, ▲▼ or a swipe. */
function createDial(entries: DialEntry[], start: number, onMove: (index: number) => void): HTMLElement {
  const root = document.createElement('div');
  root.className = 'dial';
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-roledescription', '轉盤');
  root.setAttribute('aria-label', '今日領藥結果，以滑鼠滾輪或上下方向鍵轉動');
  const ticks = document.createElement('ol');
  ticks.className = 'dial-ticks';
  const frame = document.createElement('div');
  frame.className = 'dial-frame';
  const view = document.createElement('div');
  view.className = 'dial-window';
  const track = document.createElement('div');
  track.className = 'dial-track';
  const step = (text: string, label: string, by: number) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => go(current + by));
    return button;
  };
  const up = step('▲', '上一格', -1), down = step('▼', '下一格', 1);
  const steps = document.createElement('div');
  steps.className = 'dial-steps';
  steps.append(up, down);
  const announce = document.createElement('p');
  announce.className = 'dial-live';
  announce.setAttribute('aria-live', 'polite');
  const items = entries.map((entry, index) => {
    const item = document.createElement('section');
    item.className = 'dial-item';
    const title = document.createElement('p');
    title.className = 'dial-title';
    title.textContent = entry.title;
    if (entry.badge) {
      const badge = document.createElement('span');
      badge.className = 'dial-badge';
      badge.textContent = entry.badge;
      title.append(badge);
    }
    item.append(title, ...entry.body);
    track.append(item);
    const tick = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.textContent = entry.tick;
    button.addEventListener('click', () => go(index));
    tick.append(button);
    ticks.append(tick);
    return item;
  });
  let current = start;
  function go(index: number) {
    const next = Math.max(0, Math.min(entries.length - 1, index));
    const moved = next !== current;
    current = next;
    items.forEach((item, i) => {
      item.style.setProperty('--offset', String(i - current));
      item.classList.toggle('current', i === current);
      item.inert = i !== current;
    });
    for (const [i, tick] of [...ticks.querySelectorAll('button')].entries()) tick.toggleAttribute('aria-current', i === current);
    up.disabled = current === 0;
    down.disabled = current === entries.length - 1;
    if (moved) announce.textContent = entries[current].title;
    onMove(current);
  }
  // A notch of the wheel, or a trackpad swipe's worth of deltas, turns one step; at either end the page scrolls as usual.
  let travel = 0, settle = 0;
  root.addEventListener('wheel', event => {
    const direction = Math.sign(event.deltaY);
    if (!direction || current + direction < 0 || current + direction >= entries.length) { travel = 0; return; }
    event.preventDefault();
    if (event.timeStamp < settle) return;
    travel += event.deltaMode ? direction * 40 : event.deltaY;
    if (Math.abs(travel) < 40) return;
    travel = 0;
    settle = event.timeStamp + 180;
    go(current + direction);
  }, { passive: false });
  root.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement) return;
    const to = { ArrowUp: current - 1, ArrowDown: current + 1, PageUp: current - 1, PageDown: current + 1, Home: 0, End: entries.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    go(to);
  });
  let touchY: number | undefined;
  view.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') touchY = event.clientY; });
  view.addEventListener('pointercancel', () => { touchY = undefined; });
  view.addEventListener('pointerup', event => {
    if (touchY === undefined) return;
    const distance = event.clientY - touchY;
    touchY = undefined;
    if (Math.abs(distance) > 30) go(current + (distance < 0 ? 1 : -1));
  });
  view.append(track);
  frame.append(view, steps);
  root.append(ticks, frame, announce);
  go(start);
  return root;
}
/** The schedule table: the prescription's own dates, or with a late previous pickup, the dates it moves (from the longest count). */
function scheduleTable(idleRows: Scenario[]): { table: HTMLTableElement; visitRows: HTMLTableRowElement[] } {
  const longest = idleRows.at(-1)!.result;
  const table = document.createElement('table');
  table.className = 'schedule';
  const caption = table.createCaption();
  caption.textContent = longest.shift ? '時程（依前次領藥日順延）' : '原定時程';
  const body = table.createTBody();
  const suffix = (s: Scenario) => idleRows.length > 1 ? `（可調劑 ${s.count} 次）` : '';
  // Moved rows show the new dates first and the prescription's own dates after them.
  const was = (now: string, before?: string) => before && before !== now ? `原 ${before}` : '';
  const short = (range: DateRange) => range.start === range.end ? shortDate(range.start) : `${shortDate(range.start)}～${shortDate(range.end)}`;
  const visitRows: HTMLTableRowElement[] = [];
  for (const [label, dates, before] of [
    ...(longest.shift?.original ?? longest.schedule).map((range, i) => {
      const now = longest.schedule[i];
      return [`第 ${i + 1} 次領藥`, now ? rangeText(now) : '已無（前次逾期）', longest.shift ? was(now ? short(now) : '', short(range)) : ''];
    }),
    ...idleRows.flatMap(s => [[`最早回診日${suffix(s)}`, fullDate(s.result.earliestReturn), was(shortDate(s.result.earliestReturn), s.result.shift && shortDate(s.result.shift.originalReturn))],
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
    if (label.endsWith('次領藥')) visitRows.push(row);
  }
  return { table, visitRows };
}
/** The actual date of the pickup made elsewhere, when it was late: only the idle slot asks for it, and it moves only that slot and the table. */
function previousField(visits: number[], min: string, onChange: () => void): HTMLElement {
  const field = document.createElement('div');
  field.className = 'dial-previous';
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'date';
  input.id = 'previous-date';
  input.min = min;
  input.max = today;
  input.value = previousDate;
  label.htmlFor = input.id;
  label.textContent = visits.length === 1 ? `第 ${visits[0] - 1} 次實際領藥日` : '前次實際領藥日';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = '清除';
  clear.hidden = !previousDate;
  const help = document.createElement('p');
  help.className = 'hint';
  help.textContent = '逾期才領時填處方箋背面的調劑日期，下一次依此順延。';
  const update = () => {
    // A date typed segment by segment passes through dates before the prescription; wait for a whole one.
    const value = input.validity.valid ? input.value : '';
    clear.hidden = !input.value;
    if (value === previousDate) return;
    previousDate = value;
    onChange();
  };
  input.addEventListener('input', update);
  clear.addEventListener('click', () => { input.value = ''; update(); input.focus(); });
  const row = document.createElement('div');
  row.append(input, clear);
  field.append(label, row, help);
  return field;
}
function render(input: DialInput) {
  result.replaceChildren();
  try {
    const { slots, start, dead } = dial(input, today, previousDate || undefined);
    lastInput = input;
    const prefix = (count: number) => input.count ? '' : `若可調劑 ${count} 次：`;
    for (const scenario of dead) result.append(...recommendation(scenario, prefix(scenario.count)));
    if (!slots.length) return;
    const draw = (slot: DialSlot) => {
      const show = slot.kind === 'idle' ? idleRecommendation : recommendation;
      const text = (parts: HTMLElement[]) => parts.map(part => part.textContent).join('\n');
      // Rows of both counts that read the same are shown once without a count; a row only one count has, or one of two that differ, names its count.
      const merged = slot.rows.length === 2 && text(show(slot.rows[0], '')) === text(show(slot.rows[1], ''));
      return { merged, body: merged ? show(slot.rows[1], '') : slot.rows.flatMap(row => show(row, prefix(row.count))) };
    };
    const idleSlot = slots.at(-1)!, done = [...new Set(idleSlot.rows.map(row => row.visit))];
    // The idle slot and the table are redrawn in place when its previous pickup date changes, so the date field keeps focus.
    const idleResult = document.createElement('div');
    const tableBox = document.createElement('div');
    let visitRows: HTMLTableRowElement[] = [], current = start;
    const mark = () => visitRows.forEach((row, i) => row.classList.toggle('current', i === (current < slots.length - 1 ? current : idleSlot.rows.at(-1)!.visit - 1)));
    const fill = (slot: DialSlot) => {
      const parts = draw(slot).body;
      if (previousDate && slot.rows.every(row => row.result.state !== 'invalid' && !row.result.shift)) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = '前次領藥日未造成順延，時程不變。';
        parts.push(hint);
      }
      idleResult.replaceChildren(...parts);
      const drawn = scheduleTable(slot.rows);
      visitRows = drawn.visitRows;
      tableBox.replaceChildren(drawn.table);
      mark();
    };
    const entries = slots.map((slot, index): DialEntry => {
      const guessed = slot.rows.filter(row => row.inferred);
      const { merged, body } = draw(slot);
      const badge = !guessed.length ? '' : `推算${idleSlot.rows.length === 2 && guessed.length === 1 && !merged ? `・可調劑 ${guessed[0].count} 次` : ''}`;
      if (slot.kind === 'visit') return { tick: `第 ${index + 1} 次`, title: `今日領第 ${index + 1} 次`, badge, body };
      const field = previousField(done, input.date, () => fill(dial(input, today, previousDate || undefined).slots.at(-1)!));
      return { tick: '不領', title: done.length === 1 ? `今日不領 · 第 ${done[0] - 1} 次已在別處領過` : '今日不領 · 已在別處領過', badge, body: [idleResult, field] };
    });
    fill(idleSlot);
    const guess = document.createElement('p');
    guess.className = 'inferred';
    guess.textContent = `依今日日期推算停在「${entries[start].title}」；轉動轉盤可看其他情況。`;
    const wheel = createDial(entries, start, index => { current = index; mark(); });
    result.append(guess, wheel, tableBox);
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
  emptyResult();
  status.textContent = `已帶入 ${fullDate(data.date)}、${data.days} 天，轉盤停在依今日推算的這次。請核對日期；可調劑次數已知時請選擇。`;
  submit(true);
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
      // A prescription with many drugs has a second QR of drugs only; it joins the prescription scanned before it.
      const more = parsePrescriptionDrugs(text);
      const added = more ? addDrugs(more) : addPrescription(parsePrescriptionSlip(text));
      status.textContent = added.message;
      next = added.focus;
    }
    catch (error) { status.textContent = `${(error as Error).message} 請重新掃碼。`; }
    // An added prescription goes on to its refill count; a rejected or repeated scan stays here for the next try.
    if (moveFocus) (next ?? date).focus();
    return;
  }
  // The dates are all in the first QR; a scan of the drugs-only second QR leaves the form as it is.
  let drugsOnly: boolean;
  try { drugsOnly = !!parsePrescriptionDrugs(text); } catch { drugsOnly = true; }
  if (drugsOnly) {
    date.value = '';
    status.textContent = '這張 QR 只有藥品，是處方的第 2 個 QR；試算只需要第 1 個 QR 的日期與天數。';
    if (moveFocus) date.focus();
    return;
  }
  date.value = '';
  datePicker.value = '';
  days.value = '';
  count.value = '';
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
    if (!date.reportValidity()) return;
    submit();
    days.focus();
  }
});
date.addEventListener('blur', () => {
  if (scanBuffer) finishScan(false);
  else if (mode === 'calc') submit();
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
  submit();
});
/** Results follow the fields as they change; there is no button. scroll: after a scan, bring the result into view on a phone. */
function submit(scroll = false) {
  refreshDate();
  validateManualDate();
  if (!form.checkValidity()) { emptyResult(); return; }
  // Blank count means "infer" (QR codes do not carry it); the dial covers every visit, so the visit is never asked.
  const input: DialInput = { date: normalizeDate(date.value), days: Number(days.value), count: Number(count.value) || undefined };
  // Leaving the date field unchanged (say, to click the dial) must not rebuild the dial under the pointer.
  if (lastInput && JSON.stringify(input) === JSON.stringify(lastInput)) return;
  previousDate = '';
  render(input);
  if (scroll && matchMedia('(max-width: 700px)').matches) result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
form.addEventListener('submit', event => {
  event.preventDefault();
  if (scanBuffer) { finishScan(); return; }
  submit();
});
// Scans in 憑單 mode pass through the shared entry field; they must not clear the 試算 result.
// A typed date is checked once finished (Enter or leaving the field), and the calendar on its change.
form.addEventListener('input', event => {
  if (mode !== 'calc' || event.target === datePicker) return;
  if (event.target === date) emptyResult();
  else submit();
});
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
