import { setTimeout as sleep } from 'node:timers/promises';
import { CAPTCHA_TIMEOUT_MS } from './portal/nopecha.mjs';

const TOKEN_URL = 'https://api.nopecha.com/v1/token/recaptcha3';

/** Opt-in diagnostic only: the documented Token API requires a key.
 * This anonymous probe is never called by the application runner. */
export async function probeAnonymousRecaptchaV3({ sitekey, url, action, enterprise = false }, {
  fetchImpl = fetch, wait = sleep, now = Date.now, timeoutMs = CAPTCHA_TIMEOUT_MS,
} = {}) {
  const endpoint = new URL(url);
  // The solver needs the public page, never its query, fragment, cookies or form values.
  endpoint.search = '';
  endpoint.hash = '';
  if (!/^https?:$/.test(endpoint.protocol) || !/^[\w-]{10,200}$/.test(sitekey) || !/^[\w/.-]{1,100}$/.test(action)) {
    throw new Error('nopecha_invalid_challenge');
  }
  const deadline = now() + timeoutMs;
  const request = async (method, id) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('nopecha_timeout');
    const response = await fetchImpl(id ? `${TOKEN_URL}?id=${encodeURIComponent(id)}` : TOKEN_URL, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ sitekey, url: endpoint.href, data: { action }, enterprise }) } : {}),
      signal: AbortSignal.timeout(Math.min(remaining, 15_000)),
      redirect: 'error',
    });
    const data = await response.json();
    const code = data.code ?? data.error;
    // Provider messages may echo request data: only a numeric error code leaves here.
    if (code != null && !(method === 'GET' && code === 14)) {
      throw new Error(`nopecha_error_${Number.isInteger(code) ? code : 'unknown'}`);
    }
    if (!response.ok && code !== 14) throw new Error(`nopecha_http_${response.status}`);
    return { ...data, error: code };
  };
  const job = await request('POST');
  if (typeof job.data !== 'string' || !job.data) throw new Error('nopecha_invalid_job');
  while (now() < deadline) {
    await wait(Math.min(3000, Math.max(0, deadline - now())));
    const result = await request('GET', job.data);
    if (result.error === 14) continue;
    if (typeof result.data !== 'string' || !result.data) throw new Error('nopecha_invalid_token');
    return result.data;
  }
  throw new Error('nopecha_timeout');
}
