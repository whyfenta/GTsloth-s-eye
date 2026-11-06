/** Pickup-slip rules. Nothing here touches the DOM, so every rule is unit-tested on its own. */
import { addDays, autoCalculate, type Calculation, type DateRange } from './arithmetic-model';
import { cleanProductName } from './model';
import type { MapEntry } from './sku-map';

/** One scanned prescription. QR codes omit the refill count, so it must be chosen; a blank visit is inferred from today. */
export interface SlipEntry { date: string; days: number; count?: number; visit?: number; name: string; idNumber: string; birth: string; hospital: string }
/** A pickup trip: the window every prescription in it shares, and how many prescriptions it covers (the slip's "x1"). */
export interface Trip extends DateRange { prescriptions: number }
export interface SlipPlan { validUntil: string; second?: Trip; third?: Trip; notes: string[] }
export interface MissingItem { code: string; name: string; quantity: string; note: string }
/**
 * A store product (六碼) for a prescribed 健保碼. name drops the package spec to fit the slip; full keeps it to tell packs apart.
 * replaced: the prescribed code belongs to a 六碼 now replaced by this one (改用六碼); sku is the original 六碼, code this
 * product's own, newer 健保碼.
 */
export interface Product { sku: string; name: string; full: string; replaced?: { sku: string; code: string } }
/** Pickup dates agreed with the patient in place of the calculated trip windows, which stay the default. */
export interface TripDates { second?: DateRange; third?: DateRange }
export interface SlipForm { phone: string; sms: boolean; call: boolean; note: string; staff: string; missing: MissingItem[]; trips?: TripDates }
export interface SlipData extends SlipPlan, SlipForm { openDate: string; names: string; hospitals: string; footer: string }
export interface Ahead { visit: number; result: Calculation; windows: { range: DateRange; visit: number }[]; validUntil: string; notes: string[] }
/** The printed table has four rows. */
export const MISSING_ROWS = 4;

/** What the 聯絡人與電話 field holds: a mobile number, another number, or no number yet. */
export type ContactKind = 'mobile' | 'phone' | '';
/** A Taiwan mobile number: 09 and 8 more digits, or +886 9 and 8 more, with any spaces, dots, dashes or brackets between digits. */
const MOBILE = /(?<!\d)(?:0|\+?886[\s-]*(?:\(0\))?[\s-]*)9(?:[\s.()-]*\d){8}(?!\d)/;
/**
 * The field may hold a contact name with the number (媽媽 0912-345-678), so a mobile number anywhere in it counts; any other digits
 * are another number. Full-width digits and signs typed with the Chinese IME count the same.
 */
export function contactKind(value: string): ContactKind {
  const text = value.normalize('NFKC');
  return MOBILE.test(text) ? 'mobile' : /\d/.test(text) ? 'phone' : '';
}

const monthDay = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const fullDate = (value: string) => value.replaceAll('-', '/');
const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];

/**
 * 健保碼 → the 六碼 products the map gives it, by 六碼. A 健保碼 can have several packs (瓶 and 盒); 無健保碼 rows have none.
 * A replaced 六碼 (改用六碼) is listed under its own, older 健保碼 as the product that replaced it.
 */
export function productIndex(entries: Iterable<Pick<MapEntry, 'sku' | 'code' | 'key' | 'replacedBy'>>): Map<string, Product[]> {
  const sorted = [...entries].sort((a, b) => a.sku.localeCompare(b.sku));
  const bySku = new Map(sorted.map(entry => [entry.sku, entry]));
  const index = new Map<string, Product[]>();
  for (const { sku, code, key, replacedBy } of sorted) {
    if (!code) continue;
    const target = replacedBy ? bySku.get(replacedBy) : undefined;
    const shown = target?.code ? target : { sku, code, key };
    const products = index.get(code) ?? [];
    if (products.some(product => product.sku === shown.sku)) continue;
    const product: Product = { sku: shown.sku, name: cleanProductName(shown.key, true).name || shown.key, full: shown.key };
    // Sharing one 健保碼 with its replacement, the old 六碼 simply shows as that product: there is no other code to name.
    products.push(target?.code && target.code !== code ? { ...product, replaced: { sku, code: target.code } } : product);
    index.set(code, products);
  }
  return index;
}

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

/** Who a prescription is for, as its first QR says (the name on the card can be edited; this is not). */
export type Person = Pick<SlipEntry, 'idNumber' | 'name' | 'birth'>;
/**
 * The same patient: the same ID number when both prescriptions have one (a different one is someone else, whatever the name);
 * without one, the same name and birth date. A name alone could be a namesake. An ID number a hospital masked with * (A128***212)
 * matches one whose shown characters are the same, and only with the same name, as the hidden digits could differ.
 */
export function samePerson(a: Person, b: Person): boolean {
  const id = (person: Person) => person.idNumber.trim().toUpperCase(), name = (person: Person) => person.name.replace(/\s+/g, '');
  const sameName = !!name(a) && name(a) === name(b);
  if (id(a) && id(b)) {
    if (!id(a).includes('*') && !id(b).includes('*')) return id(a) === id(b);
    return sameName && id(a).length === id(b).length && [...id(a)].every((char, i) => char === id(b)[i] || char === '*' || id(b)[i] === '*');
  }
  return sameName && !!a.birth && a.birth === b.birth;
}
/**
 * The slip's prescriptions by patient, as card indices in scan order; the groups in the order their first card was scanned.
 * A prescription joins a group only when it is the same patient as every card already in it.
 */
export function patientGroups(people: Person[]): number[][] {
  const groups: number[][] = [];
  people.forEach((person, index) => {
    const group = groups.find(members => members.every(member => samePerson(people[member], person)));
    if (group) group.push(index);
    else groups.push([index]);
  });
  return groups;
}

/** Agreed dates replace a trip's window, never its prescription count; they must stay within today and 領藥最終有效時間. */
function agreeTrips(plan: SlipPlan, trips: TripDates | undefined, today: string): SlipPlan {
  const agreed = { ...plan, notes: [...plan.notes] };
  for (const [row, label] of [['second', '第二次'], ['third', '第三次']] as const) {
    const dates = trips?.[row], computed = plan[row];
    if (!dates || !computed || (dates.start === computed.start && dates.end === computed.end)) continue;
    const name = `${label}預計領藥日`;
    if (dates.start > dates.end) throw new Error(`${name}的起日不能晚於訖日。`);
    if (dates.start < today) throw new Error(`${name}不能早於今天。`);
    if (dates.end > plan.validUntil) throw new Error(`${name}不能晚於領藥最終有效時間 ${fullDate(plan.validUntil)}。`);
    const outside = dates.start < computed.start || dates.end > computed.end;
    agreed.notes.push(`${name}依約定改為 ${monthDay(dates.start)}～${monthDay(dates.end)}（計算區間 ${monthDay(computed.start)}～${monthDay(computed.end)}${outside ? '，超出計算區間，請確認符合領藥規定' : ''}）。`);
    agreed[row] = { start: dates.start, end: dates.end, prescriptions: computed.prescriptions };
  }
  return agreed;
}

export function buildSlip(entries: SlipEntry[], form: SlipForm, today: string): SlipData {
  const plan = agreeTrips(planSlip(entries, today), form.trips, today);
  const blank = entries.findIndex(entry => !entry.hospital.trim());
  if (blank >= 0) throw new Error(`第 ${blank + 1} 張請填寫醫院名稱。`);
  if (form.missing.length > MISSING_ROWS) throw new Error(`尚差品項最多 ${MISSING_ROWS} 列，其餘請寫在備註。`);
  // Family members handed in together: every name on the slip, every ID only on the store copy.
  const footer = unique(entries.filter(entry => entry.idNumber).map(entry => entry.birth ? `${entry.idNumber}.${entry.birth.replaceAll('-', '')}` : entry.idNumber));
  return { ...plan, ...form, openDate: today, names: unique(entries.map(entry => entry.name)).join('、'),
    hospitals: unique(entries.map(entry => entry.hospital)).join('、'), footer: footer.join('　') };
}
