/** Calendar arithmetic uses UTC day numbers; the current calendar date is Taiwan's. */
const DAY = 86_400_000;
export function taiwanToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function dayNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('請輸入有效日期。');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('請輸入有效日期。');
  return ms / DAY;
}
export function addDays(value: string, days: number): string {
  return new Date((dayNumber(value) + days) * DAY).toISOString().slice(0, 10);
}
export function shortDate(value: string): string {
  return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}
export function rocDate(value: string): string {
  if (!/^\d{7}$/.test(value) || Number(value.slice(0, 3)) < 1) throw new Error('QR 就醫日期須為有效的民國七碼日期。');
  const date = `${Number(value.slice(0, 3)) + 1911}-${value.slice(3, 5)}-${value.slice(5, 7)}`;
  dayNumber(date);
  return date;
}
/** ROC year/month/day, e.g. 2026-10-14 → 115/10/14. */
export function rocText(value: string): string {
  return `${Number(value.slice(0, 4)) - 1911}/${value.slice(5, 7)}/${value.slice(8, 10)}`;
}
/** Inclusive day count of a range. */
export function rangeDays(range: DateRange): number {
  return dayNumber(range.end) - dayNumber(range.start) + 1;
}
/** previous: the actual date of the previous pickup, when it may have been late. */
export interface PrescriptionInput { date: string; days: number; count: number; visit: number; previous?: string }
export interface DateRange { start: string; end: string }
/** A late previous pickup restarts its medication period, moving this and later windows; original keeps the prescription's own dates. */
export interface Shift { previous: string; original: DateRange[]; originalReturn: string }
export interface Calculation {
  state: 'normal' | 'early' | 'late' | 'invalid';
  message: string;
  schedule: DateRange[];
  expiry: string;
  earliestReturn: string;
  next?: DateRange;
  returnDate?: string;
  shift?: Shift;
}
/** The last 10 days of the period that starts at anchor and runs `periods` periods, never past expiry. */
function windowAfter(anchor: string, days: number, periods: number, expiry: string): DateRange {
  const end = addDays(anchor, days * periods - 1);
  return { start: addDays(anchor, days * periods - 10), end: end > expiry ? expiry : end };
}
export function calculate(input: PrescriptionInput, today = taiwanToday()): Calculation {
  const { date, days, count, visit, previous } = input;
  const current = dayNumber(today), origin = dayNumber(date);
  // The visit after the last one is only asked for with a previous pickup date: it answers when to return.
  if (![28, 29, 30].includes(days) || ![2, 3].includes(count) || !(visit >= 1 && visit <= (previous ? count + 1 : 3))) throw new Error('請完成給藥日份與領藥次數。');
  if (previous) dayNumber(previous);
  const expiry = addDays(date, days * count);
  const schedule = Array.from({ length: count }, (_, index) => index === 0 ? { start: date, end: date } : windowAfter(date, days, index, expiry));
  let base: Omit<Calculation, 'state' | 'message'> = { schedule, expiry, earliestReturn: addDays(expiry, -10) };
  const invalid = (message: string): Calculation => ({ ...base, state: 'invalid', message });
  if (current < origin) return invalid('處方日期尚未到，請核對日期。');
  if (visit > count && !previous) return invalid('本次領藥次數超過處方可調劑次數。');
  if (today > expiry) return invalid(`處方已於${rocText(expiry)}失效，請回診。`);
  if (previous) {
    const prior = schedule[visit - 2];
    if (!prior) return invalid('第 1 次領藥沒有前次，請清除前次領藥日。');
    if (previous > today) return invalid('前次領藥日不能晚於今天。');
    if (previous < prior.start) return invalid(`前次領藥日早於第 ${visit - 1} 次可領藥區間（${rocText(prior.start)} 起），請核對日期或本次次數。`);
    // Inside its window the previous pickup keeps its period; a late one restarts it on the pickup date, as the late rule below does.
    if (previous > addDays(date, days * (visit - 2))) {
      const windows: DateRange[] = [];
      let periods = 1;
      for (; visit - 1 + periods <= count; periods++) {
        const moved = windowAfter(previous, days, periods, expiry);
        if (moved.start >= expiry) break;
        windows.push(moved);
      }
      base = { schedule: [...schedule.slice(0, visit - 1), ...windows], expiry, earliestReturn: addDays(previous, days * periods - 10),
        shift: { previous, original: schedule, originalReturn: base.earliestReturn } };
    }
    const returnDate = base.earliestReturn;
    if (visit > count) return { ...invalid(`前次已是最後一次（第 ${count} 次）領藥，請回診，建議最早${rocText(returnDate)}。`), returnDate };
    if (!base.schedule[visit - 1]) return { ...invalid(`前次逾期領藥後已無第 ${visit} 次，請回診，建議最早${rocText(returnDate)}。`), returnDate };
  }
  const range = base.schedule[visit - 1];
  if (today < range.start) return { ...base, state: 'early', message: '尚未到領藥區間，請預包。' };
  if (today > range.end) {
    const start = addDays(today, days - 10);
    // Same strict boundary as the source sheet's H12: start must precede expiry.
    if (start >= expiry) return { ...base, state: 'late', message: '本次領藥延遲，下次請回診。', returnDate: start };
    return { ...base, state: 'late', message: '本次領藥延遲，請使用修正日期。', next: windowAfter(today, days, 1, expiry) };
  }
  const next = base.schedule[visit];
  return { ...base, state: 'normal', message: base.shift ? '本次在順延後的領藥區間內，可領藥。' : '本次在原定領藥日期內，可領藥。',
    ...(next ? { next } : { returnDate: base.earliestReturn }) };
}

/** QR codes omit the refill count and visit number; blank selections are inferred from the previous pickup date, else from today. */
export interface AutoInput { date: string; days: number; count?: number; visit?: number; previous?: string }
export interface Scenario { count: number; visit: number; inferred: boolean; note?: string; result: Calculation }
/** fix: how the note tells the user to pick the late earlier visit instead. */
export function inferVisit(date: string, days: number, count: number, today: string, fix = '手動選擇'): { visit: number; note?: string } {
  const elapsed = dayNumber(today) - dayNumber(date);
  if (elapsed <= 0) return { visit: 1 };
  // Each window's first day is the first allowed day: today is inside a window, late for the last visit, or early.
  for (let visit = 1; visit < count; visit++) {
    const nextStart = days * visit - 10;
    if (elapsed >= nextStart && elapsed <= days * visit - 1) return { visit: visit + 1 };
    // Before the next window opens, the usual case is a prescription handed in early for pre-processing.
    if (elapsed < nextStart) return { visit: visit + 1, note: `今日尚未到第 ${visit + 1} 次領藥區間，判斷為病患提前交付處方預處理；若實際為第 ${visit} 次延遲領藥，請${fix}第 ${visit} 次。` };
  }
  return { visit: count };
}
/** The visit after a pickup on `previous`. Pickups are never early, so that one was the last visit whose window had opened; count + 1 means it was the last. */
export function visitAfter(date: string, days: number, count: number, previous: string): number {
  const elapsed = dayNumber(previous) - dayNumber(date);
  let visit = 1;
  while (visit < count && elapsed >= days * visit - 10) visit++;
  return visit + 1;
}
export function autoCalculate(input: AutoInput, today = taiwanToday()): Scenario[] {
  const counts = input.count ? [input.count] : [2, 3];
  const scenarios = counts.filter(count => !input.visit || input.visit <= count).map(count => {
    const { visit, note } = input.visit ? { visit: input.visit, note: undefined }
      : input.previous ? { visit: visitAfter(input.date, input.days, count, input.previous), note: undefined } : inferVisit(input.date, input.days, count, today);
    return { count, visit, inferred: !input.visit, note, result: calculate({ date: input.date, days: input.days, count, visit, previous: input.previous }, today) };
  });
  // A chosen visit beyond every candidate count still reports the source sheet's invalid message.
  return scenarios.length ? scenarios : [{ count: input.count ?? 2, visit: input.visit!, inferred: false, result: calculate({ date: input.date, days: input.days, count: input.count ?? 2, visit: input.visit! }, today) }];
}
export function sameOutcome(a: Scenario, b: Scenario): boolean {
  const range = (r?: DateRange) => r ? `${r.start}~${r.end}` : '';
  return a.visit === b.visit && (a.visit === a.count) === (b.visit === b.count) && a.note === b.note && a.result.state === b.result.state && a.result.message === b.result.message
    && range(a.result.next) === range(b.result.next) && a.result.returnDate === b.result.returnDate
    // A moved window is cut by each count's own expiry.
    && range(a.result.schedule[a.visit - 1]) === range(b.result.schedule[b.visit - 1]);
}

/** One position of the dial: today picks up `visit`, or (idle) only asks and picks up nothing, which leaves the inferred visit pending. */
export interface DialSlot { kind: 'visit' | 'idle'; visit: number; rows: Scenario[]; counts: number[] }
/** inferred: each live refill count's result for the visit inferred for today; dead: one invalid result for each count no visit can satisfy (not yet valid, expired, previous date after today). */
export interface Dial { slots: DialSlot[]; start: number; inferred: Scenario[]; dead: Scenario[] }
/** With the date, days and refill count fixed, today's result depends only on which visit today is, if any: every outcome, in time order. */
export function dial(input: Omit<AutoInput, 'visit'>, today = taiwanToday()): Dial {
  const { date, days, previous } = input;
  const counts = input.count ? [input.count] : [2, 3];
  // After a previous pickup the first visit is gone, and the visit after the last one answers when to return.
  const first = previous ? 2 : 1, extra = previous ? 1 : 0;
  const dead: Scenario[] = [], live: { count: number; guess: number; rows: Scenario[] }[] = [];
  for (const count of counts) {
    const { visit: guess, note } = previous ? { visit: visitAfter(date, days, count, previous), note: undefined } : inferVisit(date, days, count, today, '往上轉到');
    const all = Array.from({ length: count + extra - first + 1 }, (_, i) => first + i).map(visit =>
      ({ count, visit, inferred: visit === guess, note: visit === guess ? note : undefined, result: calculate({ date, days, count, visit, previous }, today) }));
    // An invalid result without a return date means the visit contradicts the input, as a previous pickup before that visit's window.
    const rows = all.filter(row => row.result.state !== 'invalid' || row.result.returnDate);
    if (rows.length) live.push({ count, guess, rows });
    else dead.push(all.find(row => row.inferred) ?? all[0]);
  }
  if (!live.length) return { slots: [], start: 0, inferred: [], dead };
  const slots: DialSlot[] = [];
  const merge = (rows: Scenario[]) => rows.length === 2 && sameOutcome(rows[0], rows[1]) ? [{ ...rows[1], inferred: rows.some(r => r.inferred) }] : rows;
  const guesses = live.map(c => c.guess), inferred = live.map(c => c.rows.find(row => row.inferred)!);
  for (let visit = first; visit <= Math.max(...live.map(c => c.count)) + extra; visit++) {
    const rows = live.flatMap(c => c.rows.filter(row => row.visit === visit));
    if (rows.length) slots.push({ kind: 'visit', visit, rows: merge(rows), counts: rows.map(row => row.count) });
    // Not picking up today follows the visit inferred for today; with two inferences, the later one.
    if (visit === Math.max(...guesses)) slots.push({ kind: 'idle', visit, rows: mergeIdle(inferred), counts: inferred.map(row => row.count) });
  }
  return { slots, start: slots.findIndex(slot => slot.kind === 'visit' && slot.visit === Math.min(...guesses)), inferred, dead };
}
/** Without a pickup today only the inferred visit's window and state matter, not what follows it. */
function mergeIdle(rows: Scenario[]): Scenario[] {
  const key = (s: Scenario) => { const range = s.result.schedule[s.visit - 1]; return [s.visit, s.result.state, s.result.message, range?.start, range?.end].join(); };
  return rows.length === 2 && key(rows[0]) === key(rows[1]) ? [rows[1]] : rows;
}
