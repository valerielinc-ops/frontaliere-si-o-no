import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  credentialAlertTitle,
  formatCredentialAlert,
  formatReadinessTable,
  planCredentialAlerts,
  probeAzure,
  probeDeepL,
  probeGoogleCloud,
  providerRecovered,
  rejectedProviders,
} from '../scripts/translation-provider-readiness.mjs';

type Reply = { status: number; body?: unknown };
const fetcherFrom = (reply: (url: string, init: { body?: string; headers?: Record<string, string> }) => Reply) =>
  (async (url: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
    const { status, body = {} } = reply(String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof globalThis.fetch;

describe('translation provider readiness probe', () => {
  it('reads DeepL usage without translating, and tells an exhausted key from a rejected one', async () => {
    const urls: string[] = [];
    const usage = (count: number) => fetcherFrom((url) => { urls.push(url); return { status: 200, body: { character_count: count, character_limit: 500000 } }; });
    expect((await probeDeepL('DEEPL_API_KEY', 'k:fx', { fetcher: usage(500000) })).verdict).toBe('quota-exhausted');
    expect((await probeDeepL('DEEPL_API_KEY', 'k:fx', { fetcher: usage(120) })).verdict).toBe('ok');
    expect((await probeDeepL('DEEPL_API_KEY', 'k:fx', { fetcher: fetcherFrom(() => ({ status: 403 })) })).verdict).toBe('auth-failed');
    expect((await probeDeepL('DEEPL_API_KEY_2', '', { fetcher: usage(0) })).verdict).toBe('not-configured');
    expect(urls.every((url) => url === 'https://api-free.deepl.com/v2/usage')).toBe(true);
  });

  it('marks Azure 401001 as a rejected credential and 429 as quota', async () => {
    const rejected = await probeAzure('AZURE_TRANSLATOR_KEY', 'k', { fetcher: fetcherFrom(() => ({ status: 401, body: { error: { code: 401001 } } })) });
    expect(rejected).toMatchObject({ verdict: 'auth-failed', detail: 'HTTP 401 (401001), region=westeurope' });
    expect((await probeAzure('AZURE_TRANSLATOR_KEY', 'k', { fetcher: fetcherFrom(() => ({ status: 429 })) })).verdict).toBe('quota-exhausted');
    expect((await probeAzure('AZURE_TRANSLATOR_KEY', 'k', { fetcher: fetcherFrom(() => ({ status: 200, body: [] })) })).verdict).toBe('ok');
  });

  it('probes Google with the service account first and separates scope errors from the daily cap', async () => {
    const serviceAccount = { client_email: 'sa@x', private_key: 'k', project_id: 'frontaliere-ticino' };
    const oauth = { clientId: 'id', clientSecret: 's', refreshToken: 'r' };
    const translation = (reply: Reply) => fetcherFrom((url) => (url.startsWith('https://translation.googleapis.com/') ? reply : { status: 200, body: { access_token: 'gsc' } }));

    const ok = await probeGoogleCloud({ fetcher: translation({ status: 200 }), serviceAccount, oauth, serviceAccountToken: async () => 'sa-token' });
    expect(ok).toMatchObject({ credential: 'service-account', verdict: 'ok' });

    const cap = await probeGoogleCloud({
      fetcher: translation({ status: 403, body: { error: { message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } }),
      serviceAccount, oauth, serviceAccountToken: async () => 'sa-token',
    });
    expect(cap.verdict).toBe('quota-exhausted');

    // Service account refused → GSC OAuth fallback, whose token lacks the scope.
    const scope = await probeGoogleCloud({
      fetcher: translation({ status: 403, body: { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } }),
      serviceAccount, oauth, serviceAccountToken: async () => { throw new Error('OAuth token exchange failed: 400 {"error":"invalid_grant"}'); },
    });
    // Both refused: the verdict names the service account, the credential the fix is about.
    expect(scope).toMatchObject({ credential: 'service-account', verdict: 'auth-failed' });
    expect(scope.detail).toContain('ACCESS_TOKEN_SCOPE_INSUFFICIENT');

    const none = await probeGoogleCloud({ fetcher: translation({ status: 200 }), serviceAccount: null, oauth: { clientId: '', clientSecret: '', refreshToken: '' } });
    expect(none.verdict).toBe('not-configured');
  });

  it('treats a transient service-account token failure as an error, and a rejected one as a fallback to OAuth', async () => {
    const serviceAccount = { client_email: 'sa@x', private_key: 'k', project_id: 'frontaliere-ticino' };
    const oauth = { clientId: 'id', clientSecret: 's', refreshToken: 'r' };
    const okTranslation = fetcherFrom((url) => (url.startsWith('https://translation.googleapis.com/') ? { status: 200 } : { status: 200, body: { access_token: 'gsc' } }));

    const transient = await probeGoogleCloud({
      fetcher: okTranslation, serviceAccount, oauth,
      serviceAccountToken: async () => { throw new Error('OAuth token exchange timed out after 30000ms'); },
    });
    expect(transient).toMatchObject({ credential: 'service-account', verdict: 'error' });

    const rejected = await probeGoogleCloud({
      fetcher: okTranslation, serviceAccount, oauth,
      serviceAccountToken: async () => { throw new Error('OAuth token exchange failed: 400 {"error":"invalid_grant"}'); },
    });
    expect(rejected).toMatchObject({ credential: 'oauth', verdict: 'ok' });

    // Service-account token refused by the API, OAuth refused too: the verdict names the service account.
    const both = await probeGoogleCloud({
      fetcher: fetcherFrom((url) => (url.startsWith('https://translation.googleapis.com/')
        ? { status: 403, body: { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } }
        : { status: 200, body: { access_token: 'gsc' } })),
      serviceAccount, oauth, serviceAccountToken: async () => 'sa-token',
    });
    expect(both).toMatchObject({ credential: 'service-account', verdict: 'auth-failed' });
    expect(both.detail).toContain('oauth fallback');
  });

  it('closes a credential alert only when a credential answers ok', () => {
    const errorOnly = [
      { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'error', detail: 'TimeoutError' },
      { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY_2', verdict: 'quota-exhausted' },
    ];
    expect(rejectedProviders(errorOnly)).toEqual([]);
    expect(providerRecovered('azure', errorOnly)).toBe(false);
    expect(providerRecovered('azure', [...errorOnly, { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'ok' }])).toBe(true);
    expect(providerRecovered('deepl', [{ provider: 'deepl', credential: 'DEEPL_API_KEY', verdict: 'quota-exhausted' }])).toBe(false);
  });

  it('does not turn a failing OAuth token endpoint into a rejected Google credential', async () => {
    const verdict = await probeGoogleCloud({
      fetcher: fetcherFrom(() => ({ status: 503 })),
      serviceAccount: null,
      oauth: { clientId: 'id', clientSecret: 's', refreshToken: 'r' },
    });
    expect(verdict).toMatchObject({ credential: 'oauth', verdict: 'error' });
  });

  it('keeps the readiness table shape when a detail carries pipes or newlines', () => {
    const table = formatReadinessTable([{ provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'error', detail: 'bad | value\nsecond line' }]);
    const row = table.split('\n')[2];
    expect(table.split('\n')).toHaveLength(3);
    expect(row).toBe('| Azure Translator | AZURE_TRANSLATOR_KEY | error | bad \\| value second line |');
  });

  it('sends a rejected Google credential to the Actions secret the workflow reads, not to Remote Config', () => {
    const results = [{ provider: 'google-cloud', credential: 'service-account', verdict: 'auth-failed', detail: 'HTTP 403 PERMISSION_DENIED' }];
    const body = formatCredentialAlert('google-cloud', results);
    const fix = body.split('\n').find((line) => line.startsWith('- FIX:'))!;
    expect(fix).toContain('GitHub Actions secret `FIREBASE_SERVICE_ACCOUNT_JSON`');
    expect(fix).not.toContain('Remote Config');
    expect(credentialAlertTitle('google-cloud')).not.toContain('Remote Config');
    expect(credentialAlertTitle('google-cloud').slice(0, 60)).not.toBe(credentialAlertTitle('azure').slice(0, 60));
  });

  it('alerts only on providers whose every configured credential is rejected', () => {
    const results = [
      { provider: 'deepl', credential: 'DEEPL_API_KEY', verdict: 'quota-exhausted' },
      { provider: 'deepl', credential: 'DEEPL_API_KEY_2', verdict: 'quota-exhausted' },
      { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'auth-failed', detail: 'HTTP 401 (401001)' },
      { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY_2', verdict: 'auth-failed', detail: 'HTTP 401 (401001)' },
      { provider: 'google-cloud', credential: 'service-account', verdict: 'ok' },
    ];
    expect(rejectedProviders(results)).toEqual(['azure']);
    expect(rejectedProviders([
      { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'auth-failed' },
      { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY_2', verdict: 'ok' },
    ])).toEqual([]);
    expect(rejectedProviders([{ provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY_2', verdict: 'not-configured' }])).toEqual([]);

    const title = credentialAlertTitle('azure');
    expect(title).toBe('Azure Translator credentials rejected — rotate them in Remote Config');
    expect(title).not.toMatch(/\d/);
    const body = formatCredentialAlert('azure', results, { runUrl: 'https://github.com/o/r/actions/runs/1' });
    for (const field of ['- CAUSA:', '- FIX:', '- METRICA:', '| COMANDO:', '- OSSERVATORE:', 'AZURE_TRANSLATOR_KEY', 'Run: https://github.com/o/r/actions/runs/1']) {
      expect(body).toContain(field);
    }
  });

  it('runs on every credentialed translate-pending run and never writes issues in a dry run', () => {
    const logic = YAML.parse(readFileSync(new URL('../.github/workflows/translate-pending-logic.yml', import.meta.url), 'utf8'));
    const steps = Object.values(logic.jobs as Record<string, { steps?: Array<Record<string, string>> }>)
      .flatMap((job) => job.steps ?? []);
    const names = steps.map((step) => step.name);
    const load = names.indexOf('Load RC secrets');
    expect(names[load + 1]).toBe('Probe translation provider readiness');
    const probe = steps[load + 1];
    expect(String(probe['continue-on-error'])).toBe('true');
    expect(probe.run).toContain('scripts/translation-provider-readiness.mjs');
    // The alert reads the Codex reserve reports (owner decision H7,
    // 2026-10-05), so it runs after every phase that can write one, also when
    // one of them failed.
    const alertAt = names.indexOf('Alert on rejected translation credentials (dedup, zero-Claude)');
    const alert = steps[alertAt];
    expect(alert.if).toContain('always()');
    expect(alert.if).toContain("steps.provider_readiness.outcome == 'success'");
    expect(alert.if).toContain('inputs.dry_run != true');
    expect(alert.run).toContain('--codex-reserve-dir "$RUNNER_TEMP/translation-codex-reserve"');
    for (const phase of [
      'Phase 2b: Translate pending jobs (cascade top-up)',
      'Phase 2d: Fix untranslated titles (free cascade)',
      'Phase 2e: Fix untranslated descriptions (free cascade)',
    ]) {
      expect(names.indexOf(phase), phase).toBeGreaterThan(load);
      expect(names.indexOf(phase), phase).toBeLessThan(alertAt);
    }

    const artifact = readFileSync(new URL('../.github/corpus-workflows/translate-pending.yml', import.meta.url), 'utf8');
    expect(artifact).toContain('Probe translation provider readiness');
  });
});

describe('credential alert with the Codex reserve (owner decision H7, 2026-10-05)', () => {
  const azureRejected = [
    { provider: 'deepl', credential: 'DEEPL_API_KEY', verdict: 'quota-exhausted', detail: 'HTTP 456' },
    { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'auth-failed', detail: 'HTTP 401 (401001)' },
    { provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY_2', verdict: 'auth-failed', detail: 'HTTP 401 (401001)' },
    { provider: 'google-cloud', credential: 'service-account', verdict: 'auth-failed', detail: 'HTTP 403' },
  ];
  const actionOf = (plan: Array<{ provider: string; action: string }>, provider: string) =>
    plan.find((entry) => entry.provider === provider)?.action;

  it('without the reserve verdict a rejected provider still alerts, as before', () => {
    const plan = planCredentialAlerts(azureRejected, null);
    expect(actionOf(plan, 'azure')).toBe('alert');
    expect(actionOf(plan, 'google-cloud')).toBe('alert');
    expect(actionOf(plan, 'deepl')).toBe('none');
  });

  it('a rejected Azure key covered by Codex is degraded, not a needs-human issue', () => {
    const plan = planCredentialAlerts(azureRejected, { verdict: 'covered', detail: '2b-cascade: ready' });
    expect(actionOf(plan, 'azure')).toBe('covered');
    expect(actionOf(plan, 'google-cloud')).toBe('covered');
    expect(plan.some((entry) => entry.action === 'alert')).toBe(false);
  });

  it('the real red: Codex failed, unavailable or not measured', () => {
    for (const verdict of ['codex-failed', 'codex-unavailable', 'unknown']) {
      expect(actionOf(planCredentialAlerts(azureRejected, { verdict, detail: '' }), 'azure'), verdict).toBe('alert');
    }
  });

  it('a recovered provider still closes its alert with the reserve in place', () => {
    const recovered = [{ provider: 'azure', credential: 'AZURE_TRANSLATOR_KEY', verdict: 'ok' }];
    expect(actionOf(planCredentialAlerts(recovered, { verdict: 'covered', detail: '' }), 'azure')).toBe('resolve');
  });

  it('the issue body says what the reserve did', () => {
    const body = formatCredentialAlert('azure', azureRejected, {
      codexReserve: { verdict: 'codex-failed', detail: '2b-cascade: failed, 0 translated / 3 rejected in 3/30 calls' },
    });
    expect(body).toContain('Codex reserve: codex-failed — 2b-cascade: failed');
  });
});
