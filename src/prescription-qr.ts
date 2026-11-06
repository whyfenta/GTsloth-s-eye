import { rocDate } from './arithmetic-model';
import { normCode, type RxFacts, type Sex } from './rx-check';

export interface PrescriptionQR { date: string; days: number; drugCount: number; encoding: string }
/**
 * Identifying fields printed on the pickup slip, and what the prescription check reads (diagnoses, 就醫科別, age band, sex, each
 * drug's frequency and route). They stay in page memory only: never stored, logged or sent.
 */
export interface SlipQR extends PrescriptionQR { institution: string; name: string; idNumber: string; birth: string; drugs: { code: string; total: string }[]; rx: RxFacts }
export function decodePrescriptionBytes(bytes: Uint8Array): { text: string; encoding: string } {
  for (const encoding of ['utf-8', 'big5']) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (!text.includes('�')) return { text, encoding };
    } catch { /* Try the next known sample encoding without replacement characters. */ }
  }
  throw new Error('無法完整解碼 QR，請重新掃描或改用手動輸入。');
}
/** Windows-1252 character → byte, for scanners that type each byte of the QR as one character. */
const cp1252 = new Map([...new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 128 }, (_, i) => i + 128))].map((char, i) => [char, i + 128]));
/** A scanner that types every byte of a Big5 or UTF-8 QR as its own character turns 測試 into ´ú¸Õ; map the characters back to bytes and decode them. Text that is not wholly such characters is left alone. */
function repairByteText(text: string, encoding: string): { text: string; encoding: string } {
  const chars = [...text];
  if (chars.every(char => char < '\x80') || !chars.every(char => char < '\x80' || cp1252.has(char))) return { text, encoding };
  try {
    const decoded = decodePrescriptionBytes(Uint8Array.from(chars, char => cp1252.get(char) ?? char.charCodeAt(0)));
    return { text: decoded.text, encoding: `逐位元組還原 ${decoded.encoding}` };
  } catch { return { text, encoding }; }
}
/** Fields of a scanned QR, one terminator removed; every other empty field is kept. */
export function splitFields(text: string): string[] {
  const fields = text.replace(/^﻿/, '').split(';');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}
const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
/**
 * A first QR's fields as 14 fixed ones and 5 per drug (code, dose, frequency, route, total), or undefined when they do not fit.
 * Field 14 is a note, and a hospital can list the allergies there with the ; that also separates fields (ASPIRIN;NSAID;PENTOXIFYLLINE),
 * which leaves 1 to 4 fields more than 14 + 5n, or 5 more for six allergies. The drugs then start at the first place that fits: its
 * first group has a code and a positive total, and no field moved into field 14 has a digit, as a drug's code, dose and total do.
 * Those fields are joined back into field 14 with ;. A QR that fits 14 + 5n keeps its layout unless its first group cannot be a drug.
 */
export function alignFields(fields: string[]): string[] | undefined {
  if (fields.length < 19) return undefined;
  const fits = (start: number) => {
    const total = fields[start + 4].trim();
    return !!fields[start].trim() && DECIMAL.test(total) && /[1-9]/.test(total) && fields.slice(14, start).every(value => !/\d/.test(value));
  };
  const extra = (fields.length - 14) % 5;
  for (let start = 14 + extra; start + 5 <= fields.length; start += 5) {
    if (fits(start)) return start === 14 ? fields : [...fields.slice(0, 13), fields.slice(13, start).join(';'), ...fields.slice(start)];
  }
  return extra ? undefined : fields;
}
/** Layout only, shared by every parser: readable text, 14 fixed fields, then 5 per drug (at least one). */
function layoutFields(text: string): string[] {
  if (text.length > 32_768 || text.includes('�') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error('QR 文字不完整或含亂碼，請重新掃描。');
  const fields = alignFields(splitFields(text));
  if (!fields) throw new Error('不是支援的處方 QR 格式，或藥品欄位不完整。');
  return fields;
}
/** Any prescription type and number of days: the layout, and a code for every drug; a blank dose, frequency, route or total stays blank. For collecting samples, not for dispensing. */
export function parsePrescriptionLayout(scanned: string, scannedAs = '文字輸入'): { fields: string[]; encoding: string } {
  const { text, encoding } = repairByteText(scanned, scannedAs);
  const fields = layoutFields(text);
  for (let i = 14; i < fields.length; i += 5) if (!fields[i].trim()) throw new Error('QR 藥品健保碼空白。');
  return { fields, encoding };
}
function prescriptionFields(text: string): { fields: string[]; date: string } {
  const fields = layoutFields(text);
  if (!/^\d{10}$/.test(fields[0]) || fields[1] !== '2') throw new Error('目前支援此格式的連續處方 QR，請確認掃到正確的碼。');
  const date = rocDate(fields[7]);
  if (!/^\d+$/.test(fields[9]) || ![28, 29, 30].includes(Number(fields[9]))) throw new Error('QR 給藥日份不在目前支援的 28、29、30 天內，請手動核對。');
  checkDrugs(fields, 14);
  return { fields, date };
}
function checkDrugs(fields: string[], start: number) {
  for (let i = start; i < fields.length; i += 5) {
    // Nothing reads the dose and hospitals write it their own way (an eye clinic writes X1), so only the total's format is checked.
    const [code, dose, frequency, route, total] = fields.slice(i, i + 5);
    if (![code, dose, frequency, route, total].every(v => v.trim()) || !DECIMAL.test(total) || !/[1-9]/.test(total)) throw new Error('QR 藥品欄位缺漏或數量格式不支援，請核對後手動輸入。');
  }
}
/** Only non-identifying fields needed for date calculation leave this parser. */
export function parsePrescription(scanned: string, scannedAs = '文字輸入'): PrescriptionQR {
  const { text, encoding } = repairByteText(scanned, scannedAs);
  const { fields, date } = prescriptionFields(text);
  return { date, days: Number(fields[9]), drugCount: (fields.length - 14) / 5, encoding };
}
/**
 * Fields 1, 4, 5 and 6 hold the institution code, name, ID number and ROC birth date (checked against a real QR). Some hospitals
 * mask part of the ID number and birth date with * (A128***212; 067**17, written with slashes); those are kept as masked, the birth
 * date as 1978-**-17.
 * A malformed ID or birth date is left blank.
 */
export function parsePrescriptionSlip(scanned: string, scannedAs = '文字輸入'): SlipQR {
  const { text, encoding } = repairByteText(scanned, scannedAs);
  const { fields, date } = prescriptionFields(text);
  const idNumber = fields[4].trim().toUpperCase();
  let birth = '';
  try { birth = rocDate(fields[5].trim()); } catch { birth = maskedBirth(fields[5])?.date ?? ''; /* Blank: the store copy prints the ID number alone. */ }
  const drugs = [];
  for (let i = 14; i < fields.length; i += 5) drugs.push({ code: fields[i].trim(), total: fields[i + 4].trim() });
  return { date, days: Number(fields[9]), drugCount: drugs.length, encoding, institution: fields[0], name: fields[3].trim(),
    idNumber: /^[A-Z][0-9A-D*][0-9*]{8}$/.test(idNumber) ? idNumber : '', birth, drugs, rx: rxFacts(fields, ageBand(fields[5], fields[7]), sexOf(idNumber)) };
}
/** The layout of a drugs-only QR, as parsePrescriptionLayout for a first QR: a code for every drug, the other four fields may be blank. */
export function parseDrugsLayout(scanned: string, scannedAs = '文字輸入'): { fields: string[]; encoding: string } | undefined {
  const { text, encoding } = repairByteText(scanned, scannedAs);
  const fields = splitFields(text);
  if (/^\d{10}$/.test(fields[0]?.trim() ?? '') || !fields.length || fields.length % 5 !== 0) return undefined;
  if (text.length > 32_768 || text.includes('�') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error('QR 文字不完整或含亂碼，請重新掃描。');
  for (let i = 0; i < fields.length; i += 5) if (!fields[i].trim()) throw new Error('QR 藥品健保碼空白。');
  return { fields, encoding };
}
/** The drugs of a prescription's follow-up QR, for one prescribing more drugs than its first QR holds. */
export interface DrugsQR { drugs: { code: string; total: string }[]; rx: RxFacts['drugs']; encoding: string }
/**
 * A prescription with many drugs can come with a second QR of drug fields only: 5 per drug, no 14 fixed fields, and nothing in the
 * first QR saying another follows. Returns undefined for any other scan, which starts with the 10-digit institution code instead.
 */
export function parsePrescriptionDrugs(scanned: string, scannedAs = '文字輸入'): DrugsQR | undefined {
  const layout = parseDrugsLayout(scanned, scannedAs);
  if (!layout) return undefined;
  const { fields, encoding } = layout;
  checkDrugs(fields, 0);
  const f = fields.map(value => value.trim());
  const drugs = [], rx = [];
  for (let i = 0; i < f.length; i += 5) {
    drugs.push({ code: f[i], total: f[i + 4] });
    rx.push({ code: f[i].toUpperCase(), frequency: f[i + 2].toUpperCase(), route: f[i + 3].toUpperCase() });
  }
  return { drugs, rx, encoding };
}
/** A birth date that cannot be read is described by its shape, never its value: digits become 9, letters A, any other character outside printable ASCII X, symbols stay; past 12 characters only the length. */
export function birthShape(value: string): string {
  const chars = [...value];
  if (chars.length > 12) return `AGE?len${chars.length}`;
  return `AGE?${chars.map(char => /[0-9]/.test(char) ? '9' : /[A-Za-z]/.test(char) ? 'A' : /[\x20-\x7E]/.test(char) ? char : 'X').join('')}`;
}
/**
 * A ROC birth date with its month, day or both masked by ** (067**17 or 06701**, or with the same / - or . between the parts), as some
 * hospitals print it: the
 * date as shown with the masked part kept (1978-**-17), and every date it can be. The year must be shown; undefined otherwise,
 * for a date without a mask, or when no date fits.
 */
export function maskedBirth(value: string): { date: string; dates: string[] } | undefined {
  const parts = value.trim().match(/^(\d{3})([/.-]?)(\d{2}|\*\*)\2(\d{2}|\*\*)$/);
  if (!parts || !value.includes('*')) return undefined;
  const [, year, , month, day] = parts;
  const any = (part: string, last: number) => part === '**' ? Array.from({ length: last }, (_, i) => String(i + 1).padStart(2, '0')) : [part];
  const dates: string[] = [];
  for (const m of any(month, 12)) for (const d of any(day, 31)) {
    try { dates.push(rocDate(`${year}${m}${d}`)); } catch { /* Not a date, such as 02/30. */ }
  }
  return dates.length ? { date: `${Number(year) + 1911}-${month}-${day}`, dates } : undefined;
}
function band(age: number): string {
  if (age >= 90) return 'AGE90+';
  if (age >= 60 && age < 70) return age < 65 ? 'AGE60-64' : 'AGE65-69';
  const low = age - age % 10;
  return `AGE${low}-${low + 9}`;
}
/**
 * Completed years on the visit date in 10-year bands (AGE0-9 … AGE80-89, AGE90+), with 60–69 split at 65 for the rules on older
 * patients. A birth date with a masked month or day (see maskedBirth) gives the band when every date it can be falls in the same
 * one, as a known year mostly does; otherwise, and for any other unreadable birth date, its shape. A blank birth date, an
 * unreadable visit date or a birth after the visit gives a blank.
 */
export function ageBand(birthRoc: string, visitRoc: string): string {
  let births: string[], visit: string;
  try { births = [rocDate(birthRoc.trim())]; } catch {
    const masked = maskedBirth(birthRoc);
    if (!masked) return birthRoc.trim() ? birthShape(birthRoc) : '';
    births = masked.dates;
  }
  try { visit = rocDate(visitRoc.trim()); } catch { return ''; }
  const bands = new Set(births.filter(birth => birth <= visit)
    .map(birth => band(Number(visit.slice(0, 4)) - Number(birth.slice(0, 4)) - (visit.slice(5) < birth.slice(5) ? 1 : 0))));
  if (!bands.size) return '';
  return bands.size === 1 ? [...bands][0] : birthShape(birthRoc);
}
/** The second character of an ID number by sex: 身分證 1 and 2, the 統一證號 issued since 2021 8 and 9, the older 統一證號 A and C, B and D. */
const SEX_DIGIT: Record<string, Sex> = { 1: 'M', 2: 'F', 8: 'M', 9: 'F', A: 'M', B: 'F', C: 'M', D: 'F' };
/**
 * Sex from an ID number's second character, also when a hospital masks later digits with * (A128***212); any other character, a
 * masked second character and a malformed ID are unknown. Only the sex leaves: whether it was a 身分證 or a 統一證號 does not.
 */
export function sexOf(idNumber: string): Sex {
  const id = idNumber.trim().toUpperCase();
  return /^[A-Z][1289A-D][0-9*]{8}$/.test(id) ? SEX_DIGIT[id[1]] : '';
}
/** A de-identified sample keeps only the sex in field 5, as SEXM or SEXF (blank when unknown), never the ID number. */
export const sexMark = (sex: Sex) => sex && `SEX${sex}`;
export const markedSex = (field: string): Sex => ({ SEXM: 'M', SEXF: 'F' } as const)[field.trim().toUpperCase()] ?? '';
/**
 * What the prescription check reads, each field trimmed and upper-cased as hospitals write either case: field 12's #-separated
 * diagnoses without dots, field 7's 就醫科別, each drug's code, frequency and route. The 就醫科別 has 2 characters, or 4 when a
 * hospital pads it (AB00, 0100); any other length is the hospital's own code (146, 0NB) and leaves the department unknown.
 */
export function rxFacts(fields: string[], age: string, sex: Sex): RxFacts {
  const f = fields.map(value => value.trim().toUpperCase());
  const dept = f[6].length === 2 || (f[6].length === 4 && f[6].endsWith('00')) ? f[6].slice(0, 2) : '';
  const drugs = [];
  for (let i = 14; i < f.length; i += 5) drugs.push({ code: f[i], frequency: f[i + 2], route: f[i + 3] });
  return { dx: f[11].split('#').filter(code => code.trim()).map(normCode), dept, age, sex, drugs };
}
/** A first QR's fields start with the 10-digit institution code; this many or more is a prescription, whatever its layout. */
const FIRST_QR_FIELDS = 10;
/**
 * The text of a QR read by the phone camera, when it is a prescription's, from UTF-8 or Big5 bytes: a first QR's 10-digit
 * institution code and at least FIRST_QR_FIELDS fields, or a drugs-only QR's 5n. A first QR is taken whatever its layout, so one
 * the slip cannot read closes the camera with the reason and is kept as a failure, as a keyboard scan is. Any other QR (a web
 * address, a member card) is undefined, so the camera keeps looking; what the fields hold is checked as for a keyboard scan.
 */
export function prescriptionText(bytes: Uint8Array): string | undefined {
  let text: string;
  try { text = decodePrescriptionBytes(bytes).text.replace(/[\r\n]+$/, ''); } catch { return undefined; }
  if (!text.includes(';')) return undefined;
  const fields = splitFields(text);
  const shaped = /^\d{10}$/.test(fields[0].trim()) ? fields.length >= FIRST_QR_FIELDS : fields.length >= 5 && fields.length % 5 === 0;
  return shaped ? text : undefined;
}
export function parsePrescriptionBytes(bytes: Uint8Array): PrescriptionQR {
  const { text, encoding } = decodePrescriptionBytes(bytes);
  return parsePrescription(text, encoding);
}
