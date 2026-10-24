/** Pickup-slip rules. Nothing here touches the DOM, so every rule is unit-tested on its own. */
import { addDays, autoCalculate, type Calculation, type DateRange } from './arithmetic-model';

/** One scanned prescription. QR codes omit the refill count, so it must be chosen; a blank visit is inferred from today. */
export interface SlipEntry { date: string; days: number; count?: number; visit?: number; name: string; idNumber: string; birth: string; hospital: string }
/** A pickup trip: the window every prescription in it shares, and how many prescriptions it covers (the slip's "x1"). */
export interface Trip extends DateRange { prescriptions: number }
export interface SlipPlan { validUntil: string; second?: Trip; third?: Trip; notes: string[] }
export interface MissingItem { code: string; name: string; quantity: string; note: string }
export interface SlipForm { phone: string; sms: boolean; call: boolean; note: string; staff: string; missing: MissingItem[] }
export interface SlipData extends SlipPlan, SlipForm { openDate: string; names: string; hospitals: string; footer: string }
export interface Ahead { visit: number; result: Calculation; windows: { range: DateRange; visit: number }[]; validUntil: string; notes: string[] }
/** The printed table has four rows. */
export const MISSING_ROWS = 4;

const monthDay = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];

/** Windows still ahead of one prescription, each with its dispensing number. */
export function prescriptionAhead(entry: SlipEntry, today: string): Ahead {
  if (!entry.count) throw new Error('請選擇可調劑次數（QR 不含此資料）。');
  const [{ visit, count, note, result }] = autoCalculate({ date: entry.date, days: entry.days, count: entry.count, visit: entry.visit }, today);
  const notes = note ? [note] : [];
  if (result.state === 'invalid') return { visit, result, windows: [], validUntil: addDays(result.expiry, -1), notes };
  const schedule = result.schedule.map((range, index) => ({ range, visit: index + 1 }));
  // Handed in early: this visit is still ahead. Late: only the corrected next window is known until it is collected;
  // after the last visit that window is the return visit, which the slip does not print (such slips are for owed drugs).
  const windows = result.state === 'early' ? schedule.slice(visit - 1)
    : result.state === 'late' ? (result.next && visit < count ? [{ range: result.next, visit: visit + 1 }] : [])
    : schedule.slice(visit);
  if (!windows.length) notes.push('已無下次領藥，下次請回診。');
  else if (result.state === 'late' && visit + 1 < count) notes.push(`第 ${visit + 2} 次區間須待第 ${visit + 1} 次領藥後再算。`);
  // The source slip's 領藥最終有效時間 is the day before this tool's expiry (prescription 2026/09/24 × 28 days × 3 → 12/16).
  return { visit, result, windows, validUntil: addDays(result.expiry, -1), notes };
}

/** Trips are shared windows: the next one across every prescription, then the one after for those with visits left. */
export function planSlip(entries: SlipEntry[], today: string): SlipPlan {
  if (!entries.length) throw new Error('請先掃描處方 QR。');
  const notes: string[] = [];
  const all = entries.map((entry, index) => {
    const label = `第 ${index + 1} 張`;
    let ahead: Ahead;
    try { ahead = prescriptionAhead(entry, today); } catch (error) { throw new Error(`${label}${(error as Error).message}`); }
    if (ahead.result.state === 'invalid') throw new Error(`${label}：${ahead.result.message}`);
    notes.push(...ahead.notes.map(note => `${label}：${note}`));
    return ahead;
  });
  const trip = (k: number): Trip | undefined => {
    const members = all.flatMap((ahead, index) => ahead.windows.length > k ? [{ ...ahead.windows[k].range, index }] : []);
    if (!members.length) return undefined;
    const start = members.map(m => m.start).sort().at(-1)!;
    const end = members.map(m => m.end).sort()[0];
    if (start > end) throw new Error(`${k ? '再下次' : '下次'}找不到共同可領藥日（${members.map(m => `第 ${m.index + 1} 張 ${monthDay(m.start)}～${monthDay(m.end)}`).join('、')}），請移除部分處方，分開開立憑單。`);
    return { start, end, prescriptions: members.length };
  };
  const next = trip(0), after = trip(1);
  const validUntil = all.map(ahead => ahead.validUntil).sort()[0];
  if (after) return { validUntil, second: next, third: after, notes };
  // A single trip goes on the third-visit row only when it is everyone's third visit, as on the source slip.
  const third = next && all.every(ahead => !ahead.windows.length || ahead.windows[0].visit === 3);
  return { validUntil, ...(third ? { third: next } : { second: next }), notes };
}

export function buildSlip(entries: SlipEntry[], form: SlipForm, today: string): SlipData {
  const plan = planSlip(entries, today);
  const blank = entries.findIndex(entry => !entry.hospital.trim());
  if (blank >= 0) throw new Error(`第 ${blank + 1} 張請填寫醫院名稱。`);
  if (form.missing.length > MISSING_ROWS) throw new Error(`尚差品項最多 ${MISSING_ROWS} 列，其餘請寫在備註。`);
  // Family members handed in together: every name on the slip, every ID only on the store copy.
  const footer = unique(entries.filter(entry => entry.idNumber).map(entry => entry.birth ? `${entry.idNumber}.${entry.birth.replaceAll('-', '')}` : entry.idNumber));
  return { ...plan, ...form, openDate: today, names: unique(entries.map(entry => entry.name)).join('、'),
    hospitals: unique(entries.map(entry => entry.hospital)).join('、'), footer: footer.join('　') };
}
