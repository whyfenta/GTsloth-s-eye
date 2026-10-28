import { rocDate } from './arithmetic-model';

export interface PrescriptionQR { date: string; days: number; drugCount: number; encoding: string }
/** Identifying fields printed on the pickup slip. They stay in page memory only: never stored, logged or sent. */
export interface SlipQR extends PrescriptionQR { institution: string; name: string; idNumber: string; birth: string; drugs: { code: string; total: string }[] }
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
/** Layout only, shared by every parser: readable text, 14 fixed fields, then 5 per drug (at least one). */
function layoutFields(text: string): string[] {
  if (text.length > 32_768 || text.includes('�') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error('QR 文字不完整或含亂碼，請重新掃描。');
  const fields = splitFields(text);
  if (fields.length < 19 || (fields.length - 14) % 5 !== 0) throw new Error('不是支援的處方 QR 格式，或藥品欄位不完整。');
  return fields;
}
/** Any prescription type and number of days: the layout, and no blank drug field. For collecting samples, not for dispensing. */
export function parsePrescriptionLayout(scanned: string, scannedAs = '文字輸入'): { fields: string[]; encoding: string } {
  const { text, encoding } = repairByteText(scanned, scannedAs);
  const fields = layoutFields(text);
  if (fields.slice(14).some(value => !value.trim())) throw new Error('QR 藥品欄位有空白。');
  return { fields, encoding };
}
function prescriptionFields(text: string): { fields: string[]; date: string } {
  const fields = layoutFields(text);
  if (!/^\d{10}$/.test(fields[0]) || fields[1] !== '2') throw new Error('目前支援此格式的連續處方 QR，請確認掃到正確的碼。');
  const date = rocDate(fields[7]);
  if (!/^\d+$/.test(fields[9]) || ![28, 29, 30].includes(Number(fields[9]))) throw new Error('QR 給藥日份不在目前支援的 28、29、30 天內，請手動核對。');
  const decimal = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
  for (let i = 14; i < fields.length; i += 5) {
    // Nothing reads the dose and hospitals write it their own way (an eye clinic writes X1), so only the total's format is checked.
    const [code, dose, frequency, route, total] = fields.slice(i, i + 5);
    if (![code, dose, frequency, route, total].every(v => v.trim()) || !decimal.test(total) || !/[1-9]/.test(total)) throw new Error('QR 藥品欄位缺漏或數量格式不支援，請核對後手動輸入。');
  }
  return { fields, date };
}
/** Only non-identifying fields needed for date calculation leave this parser. */
export function parsePrescription(scanned: string, scannedAs = '文字輸入'): PrescriptionQR {
  const { text, encoding } = repairByteText(scanned, scannedAs);
  const { fields, date } = prescriptionFields(text);
  return { date, days: Number(fields[9]), drugCount: (fields.length - 14) / 5, encoding };
}
/** Fields 1, 4, 5 and 6 hold the institution code, name, ID number and ROC birth date (checked against a real QR); a malformed ID or birth date is left blank. */
export function parsePrescriptionSlip(scanned: string, scannedAs = '文字輸入'): SlipQR {
  const { text, encoding } = repairByteText(scanned, scannedAs);
  const { fields, date } = prescriptionFields(text);
  const idNumber = fields[4].trim().toUpperCase();
  let birth = '';
  try { birth = rocDate(fields[5].trim()); } catch { /* The store copy then prints the ID number alone. */ }
  const drugs = [];
  for (let i = 14; i < fields.length; i += 5) drugs.push({ code: fields[i].trim(), total: fields[i + 4].trim() });
  return { date, days: Number(fields[9]), drugCount: drugs.length, encoding, institution: fields[0], name: fields[3].trim(),
    idNumber: /^[A-Z][0-9A-D]\d{8}$/.test(idNumber) ? idNumber : '', birth, drugs };
}
export function parsePrescriptionBytes(bytes: Uint8Array): PrescriptionQR {
  const { text, encoding } = decodePrescriptionBytes(bytes);
  return parsePrescription(text, encoding);
}
