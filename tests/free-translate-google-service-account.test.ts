import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tier Google Cloud di scripts/lib/free-translate.mjs, il file che
 * translate-pending esegue. Il token OAuth GSC porta solo gli scope
 * webmasters/analytics.readonly/indexing, quindi Cloud Translation lo rifiuta
 * con 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT (misurato il 2026-09-30); il tier deve
 * usare prima il service account con lo scope cloud-translation, come fa il
 * gemello del corpus dalla sua #1987, e contare ogni rifiuto nel riepilogo.
 *
 * Nessuna rete: `fetch` e' uno stub e la chiave RSA del service account e'
 * generata qui. Le credenziali si leggono all'import: ogni caso prepara
 * l'ambiente e importa un modulo fresco.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sa-'));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_PATH = path.join(tmp, 'sa.json');
fs.writeFileSync(SA_PATH, JSON.stringify({
  client_email: 'translate-test@frontaliere-ticino.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  project_id: 'frontaliere-ticino',
}));

const realFetch = globalThis.fetch;

type Call = { url: string; body: string; headers: Record<string, string> };

async function loadWith(env: Record<string, string>, respond: (call: Call) => { status: number; body: unknown }) {
  for (const key of [
    'GOOGLE_APPLICATION_CREDENTIALS', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_REFRESH_TOKEN',
    'DEEPL_API_KEY', 'DEEPL_API_KEY_2', 'AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_KEY_2',
    'CODEX_AUTH_BROKER_SOCKET', 'MT_LOCAL_OPUSMT', 'LIBRETRANSLATE_SELF_HOSTED_URL', 'HF_TOKEN', 'HUGGINGFACE_API_KEY',
  ]) vi.stubEnv(key, env[key] ?? '');
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const call = { url: String(url), body: String(init.body ?? ''), headers: init.headers ?? {} };
    calls.push(call);
    const { status, body } = respond(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof globalThis.fetch;
  vi.resetModules();
  const ft = await import('../scripts/lib/free-translate.mjs');
  return { ft, calls };
}

/** The summary prints only after a cascade call, so one text goes through `freeTranslate` first. */
async function summaryLine(ft: typeof import('../scripts/lib/free-translate.mjs')) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await ft.freeTranslate({ text: 'Cercasi cameriere', sourceLang: 'it', targetLang: 'en' });
    ft.logCascadeSummary();
  } finally {
    spy.mockRestore();
    warn.mockRestore();
  }
  return lines.find((line) => line.includes('Google Cloud Translation')) ?? '';
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe('Google Cloud tier authentication', () => {
  it('translates with the service account under the cloud-translation scope', async () => {
    const { ft, calls } = await loadWith({ GOOGLE_APPLICATION_CREDENTIALS: SA_PATH }, (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') return { status: 200, body: { access_token: 'sa-token', expires_in: 3600 } };
      if (call.url.startsWith('https://translation.googleapis.com/')) return { status: 200, body: { data: { translations: [{ translatedText: 'Full-time nurse wanted' }] } } };
      return { status: 404, body: {} };
    });

    const out = await ft.translateWithGoogleCloud('Cercasi infermiere a tempo pieno', 'it', 'en');
    expect(out).toBe('Full-time nurse wanted');

    const tokenCall = calls.find((call) => call.url === 'https://oauth2.googleapis.com/token')!;
    const params = new URLSearchParams(tokenCall.body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = JSON.parse(Buffer.from(params.get('assertion')!.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.scope).toBe('https://www.googleapis.com/auth/cloud-translation');
    expect(claims.iss).toBe('translate-test@frontaliere-ticino.iam.gserviceaccount.com');
    expect(calls.find((call) => call.url.startsWith('https://translation.googleapis.com/'))!.headers.Authorization).toBe('Bearer sa-token');

    // The token is cached: a second field does not sign a new JWT.
    await ft.translateWithGoogleCloud('Cercasi cuoco', 'it', 'en');
    expect(calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token')).toHaveLength(1);
  });

  it('falls back to the GSC OAuth token once when the service account is refused, and counts the 403', async () => {
    const { ft, calls } = await loadWith({
      GOOGLE_APPLICATION_CREDENTIALS: SA_PATH,
      GSC_CLIENT_ID: 'id', GSC_CLIENT_SECRET: 'secret', GSC_REFRESH_TOKEN: 'refresh',
    }, (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new URLSearchParams(call.body).get('grant_type') === 'refresh_token'
          ? { status: 200, body: { access_token: 'gsc-token', expires_in: 3600 } }
          : { status: 400, body: { error: 'invalid_grant' } };
      }
      if (call.url.startsWith('https://translation.googleapis.com/')) {
        return { status: 403, body: { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } };
      }
      return { status: 404, body: {} };
    });

    expect(await ft.translateWithGoogleCloud('Cercasi cuoco', 'it', 'en')).toBe('');
    expect(await ft.translateWithGoogleCloud('Cercasi autista', 'it', 'en')).toBe('');
    const jwtExchanges = calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token'
      && new URLSearchParams(call.body).get('grant_type') !== 'refresh_token');
    // A refused service account is not retried for every field.
    expect(jwtExchanges).toHaveLength(1);
    expect(calls.filter((call) => call.url.startsWith('https://translation.googleapis.com/'))
      .every((call) => call.headers.Authorization === 'Bearer gsc-token')).toBe(true);

    const line = await summaryLine(ft);
    expect(line).toContain('auth=service-account+OAuth2');
    expect(line).toMatch(/refused \(last: HTTP 403\)/);
  });

  it('drops a service-account token the API rejects and serves the field through OAuth', async () => {
    const { ft, calls } = await loadWith({
      GOOGLE_APPLICATION_CREDENTIALS: SA_PATH,
      GSC_CLIENT_ID: 'id', GSC_CLIENT_SECRET: 'secret', GSC_REFRESH_TOKEN: 'refresh',
    }, (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new URLSearchParams(call.body).get('grant_type') === 'refresh_token'
          ? { status: 200, body: { access_token: 'gsc-token', expires_in: 3600 } }
          : { status: 200, body: { access_token: 'sa-token', expires_in: 3600 } };
      }
      if (call.url.startsWith('https://translation.googleapis.com/')) {
        return call.headers.Authorization === 'Bearer sa-token'
          ? { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } }
          : { status: 200, body: { data: { translations: [{ translatedText: 'Cook wanted' }] } } };
      }
      return { status: 404, body: {} };
    });

    expect(await ft.translateWithGoogleCloud('Cercasi cuoco', 'it', 'en')).toBe('Cook wanted');
    expect(await ft.translateWithGoogleCloud('Cercasi cuoco', 'it', 'en')).toBe('Cook wanted');
    const translations = calls.filter((call) => call.url.startsWith('https://translation.googleapis.com/'));
    // One rejected service-account request, then OAuth only: the rejected token is not reused.
    expect(translations.map((call) => call.headers.Authorization)).toEqual(['Bearer sa-token', 'Bearer gsc-token', 'Bearer gsc-token']);
  });

  it('does not fall back on the project daily cap, which the OAuth token shares', async () => {
    const { ft, calls } = await loadWith({
      GOOGLE_APPLICATION_CREDENTIALS: SA_PATH,
      GSC_CLIENT_ID: 'id', GSC_CLIENT_SECRET: 'secret', GSC_REFRESH_TOKEN: 'refresh',
    }, (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') return { status: 200, body: { access_token: 'sa-token', expires_in: 3600 } };
      if (call.url.startsWith('https://translation.googleapis.com/')) {
        return { status: 403, body: { error: { message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } };
      }
      return { status: 404, body: {} };
    });

    expect(await ft.translateWithGoogleCloud('Cercasi cuoco', 'it', 'en')).toBe('');
    expect(await ft.translateWithGoogleCloud('Cercasi autista', 'it', 'en')).toBe('');
    const translations = calls.filter((call) => call.url.startsWith('https://translation.googleapis.com/'));
    expect(translations.every((call) => call.headers.Authorization === 'Bearer sa-token')).toBe(true);
    expect(calls.some((call) => new URLSearchParams(call.body).get('grant_type') === 'refresh_token')).toBe(false);
  });

  it('stays unavailable without any Google credential', async () => {
    const { ft, calls } = await loadWith({}, () => ({ status: 500, body: {} }));
    const outcome: Record<string, unknown> = {};
    expect(await ft.translateWithGoogleCloud('Cercasi cuoco', 'it', 'en', outcome)).toBe('');
    expect(outcome.tierUnavailable).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
