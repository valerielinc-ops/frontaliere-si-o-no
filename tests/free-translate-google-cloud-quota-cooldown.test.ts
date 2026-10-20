import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Quota circuit breaker of the Google Cloud tier in scripts/lib/free-translate.mjs.
 *
 * translate-pending run 37272320066 (corpus, 2026-10-05) called the tier for
 * every text after the project's rate limit refused it: 976 refused requests in
 * the title fix and 2270 in the description fix, each one a round trip before
 * the next tier. After a quota refusal the tier now waits a cooldown that
 * doubles per refusal and resets on success. No network: `fetch` is a stub,
 * `Date.now` is driven by the test.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cooldown-'));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_PATH = path.join(tmp, 'sa.json');
fs.writeFileSync(SA_PATH, JSON.stringify({
  client_email: 'translate-test@frontaliere-ticino.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  project_id: 'frontaliere-ticino',
}));

const realFetch = globalThis.fetch;
const QUOTA = { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } };
const SCOPE = { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } };

let now = 1_700_000_000_000;

async function load(env: Record<string, string>, translate: () => { status: number; body: unknown }) {
  for (const key of [
    'GOOGLE_APPLICATION_CREDENTIALS', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_REFRESH_TOKEN',
  ]) vi.stubEnv(key, env[key] ?? '');
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url);
    calls.push(target);
    const { status, body } = target === 'https://oauth2.googleapis.com/token'
      ? { status: 200, body: { access_token: 'token', expires_in: 3600 } }
      : translate();
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.resetModules();
  const ft = await import('../scripts/lib/free-translate.mjs');
  const translations = () => calls.filter((url) => url.startsWith('https://translation.googleapis.com/')).length;
  return { ft, translations };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Google Cloud quota cooldown', () => {
  it('stops calling the API after a quota refusal until the cooldown has passed', async () => {
    const { ft, translations } = await load({ GOOGLE_APPLICATION_CREDENTIALS: SA_PATH }, () => ({ status: 403, body: QUOTA }));
    expect(await ft.translateWithGoogleCloud('Cercasi cameriere', 'it', 'en')).toBe('');
    expect(translations()).toBe(1);

    for (const text of ['Cuoco', 'Barista', 'Aiuto cuoco']) {
      expect(await ft.translateWithGoogleCloud(text, 'it', 'en')).toBe('');
    }
    expect(translations()).toBe(1);

    now += 61_000;
    await ft.translateWithGoogleCloud('Lavapiatti', 'it', 'en');
    expect(translations()).toBe(2);
  });

  it('doubles the cooldown on every further refusal', async () => {
    const { ft, translations } = await load({ GOOGLE_APPLICATION_CREDENTIALS: SA_PATH }, () => ({ status: 403, body: QUOTA }));
    await ft.translateWithGoogleCloud('Cercasi cameriere', 'it', 'en');
    now += 61_000;
    await ft.translateWithGoogleCloud('Cuoco', 'it', 'en');
    expect(translations()).toBe(2);
    now += 61_000; // inside the second, 120s cooldown
    await ft.translateWithGoogleCloud('Barista', 'it', 'en');
    expect(translations()).toBe(2);
    now += 60_000;
    await ft.translateWithGoogleCloud('Aiuto cuoco', 'it', 'en');
    expect(translations()).toBe(3);
  });

  it('treats a 429 as a quota refusal and a success as the end of the cooldown', async () => {
    let answer: { status: number; body: unknown } = { status: 429, body: {} };
    const { ft, translations } = await load({ GOOGLE_APPLICATION_CREDENTIALS: SA_PATH }, () => answer);
    await ft.translateWithGoogleCloud('Cercasi cameriere', 'it', 'en');
    now += 61_000;
    answer = { status: 200, body: { data: { translations: [{ translatedText: 'Cook' }] } } };
    expect(await ft.translateWithGoogleCloud('Cuoco', 'it', 'en')).toBe('Cook');
    expect(await ft.translateWithGoogleCloud('Barista', 'it', 'en')).toBe('Cook');
    expect(translations()).toBe(3);
  });

  it('does not arm the cooldown for a credential refusal', async () => {
    const { ft, translations } = await load({
      GSC_CLIENT_ID: 'id', GSC_CLIENT_SECRET: 'secret', GSC_REFRESH_TOKEN: 'refresh',
    }, () => ({ status: 403, body: SCOPE }));
    await ft.translateWithGoogleCloud('Cercasi cameriere', 'it', 'en');
    await ft.translateWithGoogleCloud('Cuoco', 'it', 'en');
    expect(translations()).toBe(2);
  });

  it('reports the skipped calls in the cascade summary', async () => {
    const { ft } = await load({ GOOGLE_APPLICATION_CREDENTIALS: SA_PATH }, () => ({ status: 403, body: QUOTA }));
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The summary prints only after a cascade call, so one text goes through
    // `freeTranslate` first (every other tier is refused by the same stub).
    await ft.freeTranslate({ text: 'Cercasi cameriere', sourceLang: 'it', targetLang: 'en' });
    await ft.translateWithGoogleCloud('Cuoco', 'it', 'en');
    await ft.translateWithGoogleCloud('Barista', 'it', 'en');
    ft.logCascadeSummary();
    const summary = lines.find((line) => line.includes('Google Cloud Translation')) ?? '';
    expect(summary).toContain('1 refused (last: HTTP 403 quota)');
    const skipped = Number(summary.match(/(\d+) skipped in quota cooldown/)?.[1] ?? 0);
    expect(skipped).toBeGreaterThanOrEqual(2);
  });
});
