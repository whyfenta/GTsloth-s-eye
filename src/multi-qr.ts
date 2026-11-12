import list from '../docs/reference/multi-qr-institutions.json';

/** One institution known to print a prescription as 2 or more QR codes, as docs/reference/multi-qr-institutions.json lists it. */
export interface MultiQRInstitution { code: string; since: string; source: string }
export const MULTI_QR: readonly MultiQRInstitution[] = list.institutions;
const codes = new Set(MULTI_QR.map(entry => entry.code));
/** Whether this institution has printed a prescription as 2 or more QR codes. */
export const printsMultiQR = (institution: string) => codes.has(institution.trim());
/**
 * The card's reminder for such an institution: a prescription with many drugs may continue in another QR, so check every QR on
 * it was scanned. qrs: how many QR codes this card was read from.
 */
export function multiQRNote(qrs: number): string {
  return `這家院所開立藥品較多時，可能用 2 個以上的 QR 記載同一張處方。請核對處方箋上的 QR 是否都已掃入、藥品清單是否完整（本張目前由 ${qrs} 個 QR 讀入）。`;
}
