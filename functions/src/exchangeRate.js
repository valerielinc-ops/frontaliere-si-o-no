/**
 * exchangeRate.js — server-side CHF/EUR live rate so TWELVEDATA_API_KEY stays
 * off the browser.
 *
 * The client keeps its memory/Firestore/localStorage cache cascade; it only
 * calls this when the shared Firestore cache is stale, so call volume is low.
 * Edge-cached briefly on top of that.
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';

const TWELVEDATA_URL = 'https://api.twelvedata.com/exchange_rate?symbol=CHF/EUR';

export async function handleGetExchangeRate() {
  const apiKey = await getRemoteConfigValue('TWELVEDATA_API_KEY');
  if (!apiKey) {
    return { status: 200, body: { ok: false, rate: null, error: 'not_configured' } };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${TWELVEDATA_URL}&apikey=${encodeURIComponent(apiKey)}`, {
      signal: controller.signal,
    });
    // clearTimeout must run AFTER the body is fully read, not right after
    // fetch() resolves: the AbortController has to stay armed across res.json()
    // so a server that stalls the response body still trips the 5s timeout
    // instead of hanging the Cloud Function. See #4123 (anti-hang sweep).
    const data = await res.json().catch(() => ({}));
    if (data?.rate) {
      return { status: 200, body: { ok: true, rate: parseFloat(data.rate) } };
    }
    return { status: 200, body: { ok: false, rate: null, error: data?.message || 'no_rate' } };
  } catch (error) {
    return { status: 200, body: { ok: false, rate: null, error: error instanceof Error ? error.message : 'fetch_failed' } };
  } finally {
    clearTimeout(timeout);
  }
}
