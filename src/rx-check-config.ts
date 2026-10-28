/**
 * 處方警示 in the 憑單 mode. The rule tables (docs/reference/rx-rules/) are a draft, so it is off until a pharmacist has reviewed
 * them; then set this to true. Meanwhile appointment/?rxcheck=1 switches it on for that page load, ?rxcheck=0 off.
 */
export const RX_CHECK_DEFAULT = false;
/** The page address overrides the default for this page load only; nothing is stored. */
export function rxCheckOn(search: string, fallback = RX_CHECK_DEFAULT): boolean {
  const value = new URLSearchParams(search).get('rxcheck');
  return value === '1' ? true : value === '0' ? false : fallback;
}
