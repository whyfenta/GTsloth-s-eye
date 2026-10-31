import './arithmetic.css';
import { addDays, dial, rangeDays, shortDate, taiwanToday, dayNumber, type DateRange, type DialPrevious, type DialSlot, type Scenario } from './arithmetic-model';
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
/** Per slot, the actual date of the pickup before it, when late; they belong to the input they were given for, and a day change keeps them. */
let previousDates: DialPrevious = {};
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

function dateBox(text: string, dates: string, compressed: boolean): HTMLElement {
  const box = document.createElement('div');
  box.className = 'recommended';
  box.classList.toggle('compressed', compressed);
  const label = document.createElement('p');
  label.textContent = text;
  const strong = document.createElement('strong');
  strong.textContent = dates;
  box.append(label, strong);
  return box;
}
/** recalculated: from a late pickup (today's, or the previous one), when expiry can clamp the window to fewer days than the normal 10. */
function windowBox(text: string, range: DateRange, recalculated: boolean): HTMLElement {
  const span = rangeDays(range), compressed = recalculated && span < 10;
  return dateBox(`${text}${compressed ? `僅有${span}天` : ''}`, rangeText(range), compressed);
}
function recommendation(scenario: Scenario, prefix: string): HTMLElement[] {
  const { result: value, visit, count } = scenario;
  const state = document.createElement('p');
  state.className = 'result-status';
  state.dataset.state = value.state;
  state.textContent = prefix + value.message;
  if (value.state === 'invalid') return [state];
  const recalculated = value.state === 'late' || !!value.shift;
  const moved = value.shift ? `依前次 ${shortDate(value.shift.previous)} 逾期領藥順延 · ` : '';
  if (value.state === 'early') return [state, windowBox(`${moved}本次可領藥區間`, value.schedule[visit - 1], recalculated)];
  // A late pickup that leaves no further window is as urgent as a compressed one.
  if (!value.next) return [state, dateBox(value.state === 'late' ? '請回診 · 建議最早日期' : `${moved}本次為最後一次 · 最早回診日`, fullDate(value.returnDate!), value.state === 'late')];
  if (value.state !== 'late' || visit === count) return [state, windowBox(`${value.state === 'late' ? '延遲後修正 · ' : moved}${visit === count ? '下次回診區間' : '下次領藥區間'}`, value.next, recalculated)];
  // A late pickup restarts every visit after it from today, not only the next one.
  const windows = [value.next, ...value.later ?? []];
  const boxes = windows.map((range, i) => windowBox(`延遲後修正 · 第 ${visit + 1 + i} 次領藥區間`, range, true));
  if (visit + windows.length < count) {
    const gone = document.createElement('p');
    gone.className = 'hint';
    gone.textContent = `延遲後在處方失效日前已無第 ${visit + windows.length + 1} 次，第 ${visit + windows.length} 次領完請回診。`;
    boxes.push(gone);
  }
  return [state, ...boxes];
}
/** Not picking up today: the last opened visit was picked up already, so book the next one, or after the last one, see the doctor again. */
function idleRecommendation(scenario: Scenario, prefix: string): HTMLElement[] {
  const { result: value, visit } = scenario;
  // A previous pickup date that cannot be right says so as before.
  if (value.state !== 'early' && !value.returnDate) return recommendation(scenario, prefix);
  const state = document.createElement('p');
  state.className = 'result-status';
  state.dataset.state = value.state;
  if (value.returnDate) {
    state.textContent = prefix + value.message;
    return [state, dateBox('請回診 · 建議最早日期', fullDate(value.returnDate), false)];
  }
  state.textContent = `${prefix}第 ${visit - 1} 次已領，預約第 ${visit} 次。`;
  // Expiry can cut a window moved by a late previous pickup short.
  return [state, windowBox(`${value.shift ? `依前次 ${shortDate(value.shift.previous)} 逾期領藥順延 · ` : ''}第 ${visit} 次可領藥區間`, value.schedule[visit - 1], !!value.shift)];
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
/** Was the previous pickup later than this day? A small dial of the days from the end of that visit's window (the default: on time,
 * nothing moves) to today. A later day is the actual pickup date; it moves only its own slot and the table. The wheel, arrow keys, ▲▼
 * or a swipe on it turn only this dial, not the one around it; at either end the wheel scrolls the page. */
function previousField(key: keyof DialPrevious, first: string, firstLabel: string, help: string, onChange: () => void): HTMLElement {
  const field = document.createElement('div');
  field.className = 'dial-previous';
  const caption = document.createElement('p');
  caption.className = 'dial-previous-label';
  caption.id = `previous-label-${key}`;
  caption.textContent = '前次領藥比這天晚嗎？';
  const dates = Array.from({ length: dayNumber(today) - dayNumber(first) + 1 }, (_, i) => addDays(first, i));
  const tag = (i: number) => [i ? `晚 ${i} 天` : firstLabel, ...dates[i] === today ? ['今天'] : []].join(' · ');
  const root = document.createElement('div');
  root.className = 'date-wheel';
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-roledescription', '轉盤');
  root.setAttribute('aria-labelledby', caption.id);
  const view = document.createElement('div');
  view.className = 'date-wheel-window';
  view.setAttribute('aria-hidden', 'true');
  const items = dates.map((value, i) => {
    const item = document.createElement('div');
    item.className = 'date-wheel-item';
    const small = document.createElement('small');
    small.textContent = tag(i);
    item.append(fullDate(value), small);
    item.addEventListener('click', () => go(i));
    view.append(item);
    return item;
  });
  const step = (text: string, label: string, by: number) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => go(index + by));
    return button;
  };
  const up = step('▲', '早一天', -1), down = step('▼', '晚一天', 1);
  const steps = document.createElement('div');
  steps.className = 'dial-steps';
  steps.append(up, down);
  const announce = document.createElement('p');
  announce.className = 'dial-live';
  announce.id = `previous-value-${key}`;
  announce.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-describedby', announce.id);
  // A date kept from before is always one of these days: render drops any other.
  let index = Math.max(0, dates.indexOf(previousDates[key] ?? ''));
  function go(to: number) {
    index = Math.max(0, Math.min(dates.length - 1, to));
    items.forEach((item, i) => {
      item.style.setProperty('--offset', String(i - index));
      item.classList.toggle('current', i === index);
    });
    up.disabled = index === 0;
    down.disabled = index === dates.length - 1;
    announce.textContent = `${fullDate(dates[index])}，${tag(index)}`;
    const value = index ? dates[index] : undefined;
    if (value === previousDates[key]) return;
    if (value) previousDates[key] = value;
    else delete previousDates[key];
    onChange();
  }
  // One day a notch, as fast as the wheel turns, so a long stretch of days is quick to cross.
  let travel = 0;
  root.addEventListener('wheel', event => {
    event.stopPropagation();
    const direction = Math.sign(event.deltaY);
    if (!direction || index + direction < 0 || index + direction >= dates.length) { travel = 0; return; }
    event.preventDefault();
    travel += event.deltaMode ? direction * 40 : event.deltaY;
    if (Math.abs(travel) < 40) return;
    travel = 0;
    go(index + direction);
  }, { passive: false });
  root.addEventListener('keydown', event => {
    const to = { ArrowUp: index - 1, ArrowDown: index + 1, PageUp: index - 7, PageDown: index + 7, Home: 0, End: dates.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    go(to);
  });
  let touchY: number | undefined;
  root.addEventListener('pointerdown', event => { event.stopPropagation(); if (event.pointerType === 'touch') touchY = event.clientY; });
  root.addEventListener('pointercancel', () => { touchY = undefined; });
  root.addEventListener('pointerup', event => {
    if (touchY === undefined) return;
    // A longer swipe turns more days.
    const turned = Math.trunc((touchY - event.clientY) / 30);
    touchY = undefined;
    if (turned) go(index + turned);
  });
  root.append(view, steps);
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = help;
  field.append(caption, root, announce, note);
  go(index);
  return field;
}
function render(input: DialInput) {
  result.replaceChildren();
  try {
    const { start, dead, ...computed } = dial(input, today, previousDates);
    let { slots } = computed;
    lastInput = input;
    const prefix = (count: number) => input.count ? '' : `若可調劑 ${count} 次：`;
    for (const scenario of dead) result.append(...recommendation(scenario, prefix(scenario.count)));
    if (!slots.length) return;
    const last = slots.length - 1, keyOf = (index: number): keyof DialPrevious => index === last ? 'idle' : index + 1;
    // A previous pickup is late after the end of its visit's window (the earlier one, when the two counts' previous visits differ).
    const onTime = slots.map(slot => slot.rows.map(row => (row.result.shift?.original ?? row.result.schedule)[row.visit - 2]?.end).filter(Boolean).sort()[0]);
    // A day change can move the idle slot on to a later visit, leaving a date kept for the one before it that its dial cannot show: drop it.
    const stale = slots.map((_, index) => keyOf(index)).filter((key, index) => previousDates[key] && !(onTime[index]! < previousDates[key]! && previousDates[key]! <= today));
    if (stale.length) {
      for (const key of stale) delete previousDates[key];
      slots = dial(input, today, previousDates).slots;
    }
    const draw = (slot: DialSlot) => {
      const show = slot.kind === 'idle' ? idleRecommendation : recommendation;
      const text = (parts: HTMLElement[]) => parts.map(part => part.textContent).join('\n');
      // Rows of both counts that read the same are shown once without a count; a row only one count has, or one of two that differ, names its count.
      const merged = slot.rows.length === 2 && text(show(slot.rows[0], '')) === text(show(slot.rows[1], ''));
      return { merged, body: merged ? show(slot.rows[1], '') : slot.rows.flatMap(row => show(row, prefix(row.count))) };
    };
    // Each slot's result and the table are redrawn in place when a previous pickup date changes, so the date field keeps focus.
    const boxes = slots.map(() => document.createElement('div'));
    const tableBox = document.createElement('div');
    let visitRows: HTMLTableRowElement[] = [], current = start;
    const fill = (index: number) => {
      const slot = slots[index], { body } = draw(slot);
      if (previousDates[keyOf(index)] && slot.rows.every(row => row.result.state !== 'invalid' && !row.result.shift)) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = '前次領藥日未造成順延，時程不變。';
        body.push(hint);
      }
      boxes[index].replaceChildren(...body);
    };
    // The table follows the dial: each count's dates as the slot on show has them (a count it lacks, as the idle slot has them),
    // with the visit picked up today, or when not picking up, the one to book, marked.
    const table = () => {
      const rows = slots[last].rows.map(idle => slots[current].rows.find(row => row.count === idle.count) ?? idle);
      const drawn = scheduleTable(rows);
      visitRows = drawn.visitRows;
      tableBox.replaceChildren(drawn.table);
      const marked = current < last ? current : slots[last].rows.at(-1)!.visit - 1;
      visitRows.forEach((row, i) => row.classList.toggle('current', i === marked));
    };
    const changed = (index: number) => () => {
      slots = dial(input, today, previousDates).slots;
      fill(index);
      table();
    };
    // Only a window that ended before today can have been picked up late; the first visit has no previous one.
    const field = (index: number, previous: number | undefined, after: string) => {
      const first = onTime[index];
      if (!first || first >= today) return [];
      const which = previous ? `第 ${previous} 次` : '';
      return [previousField(keyOf(index), first, previous === 1 ? '第 1 次領藥日' : `${which}區間末日`,
        `${which}晚於這天才領時，轉到處方箋背面的調劑日期，${after}起依此順延。`, changed(index))];
    };
    const entries = slots.map((slot, index): DialEntry => {
      const guessed = slot.rows.filter(row => row.inferred);
      const { merged } = draw(slot);
      const badge = !guessed.length ? '' : `推算${slots[last].rows.length === 2 && guessed.length === 1 && !merged ? `・可調劑 ${guessed[0].count} 次` : ''}`;
      fill(index);
      if (slot.kind === 'visit') {
        const visit = index + 1;
        return { tick: `第 ${visit} 次`, title: `今日領第 ${visit} 次`, badge, body: [boxes[index], ...field(index, visit - 1, '本次')] };
      }
      const done = [...new Set(slot.rows.map(row => row.visit))];
      return { tick: '不領', title: done.length === 1 ? `今日不領 · 第 ${done[0] - 1} 次已在別處領過` : '今日不領 · 已在別處領過', badge,
        body: [boxes[index], ...field(index, done.length === 1 ? done[0] - 1 : undefined, '下一次')] };
    });
    table();
    const guess = document.createElement('p');
    guess.className = 'inferred';
    guess.textContent = `依今日日期推算停在「${entries[start].title}」；轉動轉盤可看其他情況。`;
    const wheel = createDial(entries, start, index => { current = index; table(); });
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
  previousDates = {};
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
