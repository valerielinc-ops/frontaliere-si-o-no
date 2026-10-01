/** NopeCHA's anonymous, IP-metered API. No key, subscription or candidate data. */
import { setTimeout as sleep } from 'node:timers/promises';
import { getChromium } from '../../../lib/ensure-chromium.mjs';
import { extractFields } from './fields.mjs';

export const CAPTCHA_TIMEOUT_MS = 120_000;
const TOKEN_URL = 'https://api.nopecha.com/v1/token/recaptcha3';
const bindings = new WeakMap();

/** Extension builds require Chromium's persistent context, including in headless mode. */
export async function launchNopechaContext(extensionPath, options) {
  const chromium = await getChromium();
  const context = await chromium.launchPersistentContext('', {
    ...options,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const ready = await worker.evaluate(() => {
      const manifest = chrome.runtime.getManifest();
      return manifest.name === 'NopeCHA: CAPTCHA Solver' && manifest.nopecha?.enabled
        && !manifest.nopecha.key && !manifest.nopecha.keys?.length;
    });
    if (!ready) throw new Error('nopecha_extension_not_ready');
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** The extension handles visible image challenges; v3 execute() needs the Token API. */
export async function solveRecaptchaV3({ sitekey, url, action, enterprise = false }, {
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

/** Install only on a page the runner is about to submit, without exposing credentials. */
export async function armRecaptchaV3(page, evidence, { solve = solveRecaptchaV3 } = {}) {
  let stats = bindings.get(page);
  const binding = '__aaNopechaRecaptcha';
  if (!stats) {
    stats = { provider: 'nopecha', mode: 'free', requested: 0, solved: 0 };
    (evidence.captcha ||= []).push(stats);
    const origin = new URL(page.url()).origin;
    await page.exposeBinding(binding, async ({ frame }, challenge) => {
      if (frame !== page.mainFrame() || new URL(frame.url()).origin !== origin || stats.requested >= 3) throw new Error('nopecha_challenge_limit');
      stats.requested += 1;
      try {
        const token = await solve({ ...challenge, url: frame.url() });
        stats.solved += 1;
        return token;
      } catch (error) {
        stats.error = /^nopecha_[a-z0-9_]+$/.test(error?.message) ? error.message : 'nopecha_unavailable';
        throw new Error(stats.error);
      }
    });
    bindings.set(page, stats);
  }
  const armed = await page.evaluate((bindingName) => {
    const wrap = (api, enterprise) => {
      if (typeof api?.execute !== 'function') return false;
      if (api.execute.__aaNopechaWrapped) return true;
      const original = api.execute;
      api.execute = function (sitekey, options) {
        // Numeric ids are v2 widgets: the extension solves those in the browser.
        if (typeof sitekey !== 'string' || !options?.action) return original.apply(this, arguments);
        // Free quota exhaustion or IP ineligibility must not break a portal
        // that accepts its own token. The final application click stays single.
        return window[bindingName]({ sitekey, action: options.action, enterprise })
          .catch(() => original.call(this, sitekey, options));
      };
      api.execute.__aaNopechaWrapped = true;
      return true;
    };
    return [wrap(window.grecaptcha, false), wrap(window.grecaptcha?.enterprise, true)].some(Boolean);
  }, binding);
  stats.armed = armed;
  return stats;
}

/** Bounded wait while the installed extension solves the challenge in the same page. */
export async function awaitCaptcha(page, snapshot, { enabled, timeoutMs = CAPTCHA_TIMEOUT_MS } = {}) {
  if (!enabled || !snapshot.captcha) return snapshot;
  const deadline = Date.now() + timeoutMs;
  let current = snapshot;
  while (current.captcha && Date.now() < deadline) {
    await page.waitForTimeout(1000);
    current = await extractFields(page, { listboxOptions: false });
  }
  return current;
}
