/**
 * 處方警示 in the 憑單 mode. On since the pharmacist's first review of the rule tables (docs/reference/rx-rules/); the rows
 * still unreviewed apply as written and are reviewed as samples come in. appointment/?rxcheck=0 switches it off for that page load.
 */
export const RX_CHECK_DEFAULT = true;
/** The page address overrides the default for this page load only; nothing is stored. */
export function rxCheckOn(search: string, fallback = RX_CHECK_DEFAULT): boolean {
  const value = new URLSearchParams(search).get('rxcheck');
  return value === '1' ? true : value === '0' ? false : fallback;
}
