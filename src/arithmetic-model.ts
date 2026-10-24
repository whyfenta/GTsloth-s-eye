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
export interface PrescriptionInput { date: string; days: number; count: number; visit: number }
export interface DateRange { start: string; end: string }
export interface Calculation {
  state: 'normal' | 'early' | 'late' | 'invalid';
  message: string;
  schedule: DateRange[];
  expiry: string;
  earliestReturn: string;
  next?: DateRange;
  returnDate?: string;
}
export function calculate(input: PrescriptionInput, today = taiwanToday()): Calculation {
  const { date, days, count, visit } = input;
  const current = dayNumber(today), origin = dayNumber(date);
  if (![28, 29, 30].includes(days) || ![2, 3].includes(count) || ![1, 2, 3].includes(visit)) throw new Error('請完成給藥日份與領藥次數。');
  const expiry = addDays(date, days * count);
  const earliestReturn = addDays(expiry, -10);
  const schedule = Array.from({ length: count }, (_, index) => {
    const end = addDays(date, index === 0 ? 0 : days * index - 1);
    return { start: index === 0 ? date : addDays(end, -9), end };
  });
  const base = { schedule, expiry, earliestReturn };
  if (current < origin) return { ...base, state: 'invalid', message: '處方日期尚未到，請核對日期。' };
  if (visit > count) return { ...base, state: 'invalid', message: '本次領藥次數超過處方可調劑次數。' };
  if (today > expiry) return { ...base, state: 'invalid', message: '處方已失效，請回診。' };
  const range = schedule[visit - 1];
  if (today < range.start) return { ...base, state: 'early', message: '尚未到領藥區間，請預包。' };
  if (today > range.end) {
    const start = addDays(today, days - 10);
    // Same strict boundary as the source sheet's H12: start must precede expiry.
    if (start >= expiry) return { ...base, state: 'late', message: '本次領藥延遲，下次請回診。', returnDate: start };
    const end = addDays(today, days - 1);
    return { ...base, state: 'late', message: '本次領藥延遲，請使用修正日期。', next: { start, end: end > expiry ? expiry : end } };
  }
  return { ...base, state: 'normal', message: '本次在原定領藥日期內，可領藥。',
    ...(visit < count ? { next: schedule[visit] } : { returnDate: earliestReturn }) };
}

/** QR codes omit the refill count and visit number; blank selections are inferred from today. */
export interface AutoInput { date: string; days: number; count?: number; visit?: number }
export interface Scenario { count: number; visit: number; inferred: boolean; note?: string; result: Calculation }
export function inferVisit(date: string, days: number, count: number, today: string): { visit: number; note?: string } {
  const elapsed = dayNumber(today) - dayNumber(date);
  if (elapsed <= 0) return { visit: 1 };
  // Windows never overlap: visit k ends on day days*(k-1)-1, visit k+1 starts on day days*k-10.
  for (let visit = 1; visit < count; visit++) {
    const end = visit === 1 ? 0 : days * (visit - 1) - 1, nextStart = days * visit - 10;
    if (elapsed >= nextStart && elapsed <= days * visit - 1) return { visit: visit + 1 };
    if (elapsed < nextStart) {
      // Between two windows, pick the nearer one; ties count as a late current visit.
      const late = elapsed - end <= nextStart - elapsed;
      return late
        ? { visit, note: `今日介於第 ${visit}、${visit + 1} 次區間之間，較接近第 ${visit} 次，判斷為第 ${visit} 次延遲；若實際為第 ${visit + 1} 次提前，請手動選擇。` }
        : { visit: visit + 1, note: `今日介於第 ${visit}、${visit + 1} 次區間之間，較接近第 ${visit + 1} 次，判斷為第 ${visit + 1} 次提前；若實際為第 ${visit} 次延遲，請手動選擇。` };
    }
  }
  return { visit: count };
}
export function autoCalculate(input: AutoInput, today = taiwanToday()): Scenario[] {
  const counts = input.count ? [input.count] : [2, 3];
  const scenarios = counts.filter(count => !input.visit || input.visit <= count).map(count => {
    const { visit, note } = input.visit ? { visit: input.visit, note: undefined } : inferVisit(input.date, input.days, count, today);
    return { count, visit, inferred: !input.visit, note, result: calculate({ date: input.date, days: input.days, count, visit }, today) };
  });
  // A chosen visit beyond every candidate count still reports the source sheet's invalid message.
  return scenarios.length ? scenarios : [{ count: input.count ?? 2, visit: input.visit!, inferred: false, result: calculate({ ...input, count: input.count ?? 2, visit: input.visit! }, today) }];
}
export function sameOutcome(a: Scenario, b: Scenario): boolean {
  const range = (r?: DateRange) => r ? `${r.start}~${r.end}` : '';
  return a.visit === b.visit && (a.visit === a.count) === (b.visit === b.count) && a.note === b.note && a.result.state === b.result.state && a.result.message === b.result.message
    && range(a.result.next) === range(b.result.next) && a.result.returnDate === b.result.returnDate;
}
