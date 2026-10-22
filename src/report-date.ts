/** Calendar dates printed on reports; age uses Taipei calendar days, not elapsed 24-hour periods. */
export type Day = { y: number; m: number; d: number };
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function parseDay(text: string): Day | null {
  const match = text.match(/^(\d{4})[/-]?(\d{2})[/-]?(\d{2})$/); if (!match) return null;
  const day = { y: +match[1], m: +match[2], d: +match[3] };
  return day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= daysInMonth(day.y, day.m) ? day : null;
}
export const formatDay = (day: Day) => `${day.y}/${String(day.m).padStart(2, '0')}/${String(day.d).padStart(2, '0')}`;
const serial = (day: Day) => Date.UTC(day.y, day.m - 1, day.d) / 86_400_000;
export const daysBetween = (a: Day, b: Day) => serial(b) - serial(a);
const taipei = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
export function today(now = new Date()): Day {
  const parts = taipei.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)!.value);
  return { y: part('year'), m: part('month'), d: part('day') };
}
/** Seconds after midnight of the printed time beside the printed date (24-hour, or 上午/下午); undefined when not printed. */
export function printedTime(text: string): number | undefined {
  const match = text.normalize('NFKC').match(/列\s*印\s*(?:時\s*間|日\s*期)\s*[:：]?\s*\d{4}\s*[/年.-]\s*\d{1,2}\s*[/月.-]\s*\d{1,2}日?\s+(?:(上午|下午)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return undefined;
  let hour = +match[2]; if (hour > 23 || +match[3] > 59 || +(match[4] ?? 0) > 59) return undefined;
  if (match[1] === '下午' && hour < 12) hour += 12; else if (match[1] === '上午' && hour === 12) hour = 0;
  return hour * 3600 + +match[3] * 60 + +(match[4] ?? 0);
}
/** Require the printed-date label so dates in product names are never treated as the report's date. */
export function printedDay(text: string): Day | undefined {
  const match = text.normalize('NFKC').match(/列\s*印\s*(?:時\s*間|日\s*期)\s*[:：]?\s*(\d{4})\s*[/年.-]\s*(\d{1,2})\s*[/月.-]\s*(\d{1,2})(?!\d)/);
  return match ? parseDay(`${match[1]}${match[2].padStart(2, '0')}${match[3].padStart(2, '0')}`) ?? undefined : undefined;
}
