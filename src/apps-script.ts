/**
 * Posts JSON to a Google Apps Script web app. text/plain keeps it a simple request (Apps Script answers no CORS preflight),
 * so the response is opaque: success cannot be read, only a network failure.
 */
export async function postAppsScript(endpoint: string, data: unknown, post: typeof fetch = fetch): Promise<void> {
  const body = JSON.stringify(data);
  await post(endpoint, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, keepalive: body.length < 60_000 });
}
