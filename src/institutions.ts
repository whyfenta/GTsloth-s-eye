import { asset } from './model';

/** 健保特約醫療院所名冊. A code missing from it usually means an institution contracted after the roster was built. */
export const ROSTER_SOURCE = 'https://data.gov.tw/dataset/168341';
export const ROSTER_FILE = 'A21030000I-D2100G-001.csv';
export interface Roster { dataDate: string; names: Record<string, string> }
let pending: Promise<Roster> | undefined;
/** Loaded on the first scan only (~0.9 MB, gzip ~0.23 MB); a failed load is retried on the next scan. */
export function loadRoster(): Promise<Roster> {
  if (!pending) {
    pending = fetch(asset('nhi/institutions.json')).then(async response => {
      if (!response.ok) throw new Error('醫院名冊載入失敗，請手動輸入醫院名稱。');
      return await response.json() as Roster;
    });
    pending.catch(() => { pending = undefined; });
  }
  return pending;
}
export function unknownInstitution(code: string, roster: Roster): string {
  return `查無醫事機構代碼 ${code}（名冊資料日期 ${roster.dataDate.replaceAll('-', '/')}），可能是新特約院所：請到政府資料開放平臺下載最新的「健保特約醫療院所名冊」${ROSTER_FILE}（不要先用 Excel 開啟）交給維護者更新。本張先手動輸入醫院名稱。`;
}
