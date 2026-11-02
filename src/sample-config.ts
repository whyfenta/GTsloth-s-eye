/**
 * The Google Apps Script web app that keeps the 憑單 page's de-identified samples (docs/rx-samples-apps-script.gs).
 * Empty: nothing is sent and the page says nothing about it. It is a public address, not a secret.
 */
export const SAMPLE_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzXXlIoYOKhAJ16LWqMM3Gqq4ts8CNwWDz8kxVCFTxKRiE-FgBXqaKh3uNOxy5DlUU3/exec';
/** On whenever there is an address to send to; appointment/?samples=0 switches it off for that page load, nothing is stored. */
export function samplesOn(search: string, endpoint = SAMPLE_ENDPOINT): boolean {
  return !!endpoint && new URLSearchParams(search).get('samples') !== '0';
}
