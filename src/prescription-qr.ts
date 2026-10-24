import { rocDate } from './arithmetic-model';

export interface PrescriptionQR { date: string; days: number; drugCount: number; encoding: string }
export function decodePrescriptionBytes(bytes: Uint8Array): { text: string; encoding: string } {
  for (const encoding of ['utf-8', 'big5']) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (!text.includes('\uFFFD')) return { text, encoding };
    } catch { /* Try the next known sample encoding without replacement characters. */ }
  }
  throw new Error('無法完整解碼 QR，請重新掃描或改用手動輸入。');
}
/** Only non-identifying fields needed for date calculation leave this parser. */
export function parsePrescription(text: string, encoding = '文字輸入'): PrescriptionQR {
  if (text.length > 32_768 || text.includes('\uFFFD') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error('QR 文字不完整或含亂碼，請重新掃描。');
  const fields = text.replace(/^\uFEFF/, '').split(';');
  if (fields.at(-1) === '') fields.pop(); // Remove one terminator only; preserve every other empty field.
  if (fields.length < 19 || (fields.length - 14) % 5 !== 0) throw new Error('不是支援的處方 QR 格式，或藥品欄位不完整。');
  if (!/^\d{10}$/.test(fields[0]) || fields[1] !== '2') throw new Error('目前支援此格式的連續處方 QR，請確認掃到正確的碼。');
  const date = rocDate(fields[7]);
  if (!/^\d+$/.test(fields[9]) || ![28, 29, 30].includes(Number(fields[9]))) throw new Error('QR 給藥日份不在目前支援的 28、29、30 天內，請手動核對。');
  const decimal = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
  for (let i = 14; i < fields.length; i += 5) {
    const [code, dose, frequency, route, total] = fields.slice(i, i + 5);
    if (![code, dose, frequency, route, total].every(v => v.trim()) || !decimal.test(dose) || !decimal.test(total) || !/[1-9]/.test(dose) || !/[1-9]/.test(total)) throw new Error('QR 藥品欄位缺漏或數量格式不支援，請核對後手動輸入。');
  }
  return { date, days: Number(fields[9]), drugCount: (fields.length - 14) / 5, encoding };
}
export function parsePrescriptionBytes(bytes: Uint8Array): PrescriptionQR {
  const { text, encoding } = decodePrescriptionBytes(bytes);
  return parsePrescription(text, encoding);
}
