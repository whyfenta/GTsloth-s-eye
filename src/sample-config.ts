/**
 * The Google Apps Script web app that keeps the 憑單 page's de-identified samples (docs/rx-samples-apps-script.gs).
 * Empty: nothing is sent and the page says nothing about it. It is a public address, not a secret.
 */
export const SAMPLE_ENDPOINT = '';
/** On whenever there is an address to send to; appointment/?samples=0 switches it off for that page load, nothing is stored. */
export function samplesOn(search: string, endpoint = SAMPLE_ENDPOINT): boolean {
  return !!endpoint && new URLSearchParams(search).get('samples') !== '0';
}
