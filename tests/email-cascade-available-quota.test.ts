// @ts-nocheck
/**
 * getAvailableCascadeQuota() sums remainingQuota() across CONFIGURED
 * providers only, after syncing today's real usage from provider APIs — the
 * pre-generation capacity check in scripts/send-job-alerts.mjs relies on this
 * number to size how many alerts get their (network-cost) content built
 * before the shared cascade's daily quota is known to run out.
 *
 * syncQuotasFromAPIs() memoizes per UTC day on module-level state, so each
 * scenario here needs a fresh module instance (vi.resetModules() + dynamic
 * re-import) — same pattern as tests/below-floor-bridge-locale-shard.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROVIDER_ENV_VARS = [
  'MAILJET_API_KEY', 'MAILJET_SECRET_KEY',
  'MAILGUN_API_KEY', 'MAILGUN_DOMAIN',
  'MAILTRAP_API_TOKEN',
  'MAILEROO_API_KEY',
  'RESEND_API_KEY',
  'CLOUDFLARE_EMAIL_API_TOKEN', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ZONE_ID',
];

async function loadCascade() {
  vi.resetModules();
  return import('../scripts/lib/email-cascade.mjs');
}

function mockMailtrapStats(stats: Record<string, unknown>) {
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/api/accounts/')) {
      return { ok: true, status: 200, json: async () => stats } as any;
    }
    return { ok: true, status: 200, json: async () => [{ id: 1 }] } as any;
  }) as any;
}

describe('getAvailableCascadeQuota', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of PROVIDER_ENV_VARS) delete process.env[key];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of PROVIDER_ENV_VARS) delete process.env[key];
  });

  it('sums remaining quota only across configured providers', async () => {
    process.env.MAILTRAP_API_TOKEN = 'test-token';
    mockMailtrapStats({ sent_count: 40, delivery_count: 0, bounce_count: 0 });
    const { getAvailableCascadeQuota, PROVIDERS } = await loadCascade();
    const mailtrapLimit = PROVIDERS.find((p) => p.id === 'mailtrap').dailyLimit;
    expect(await getAvailableCascadeQuota()).toBe(mailtrapLimit - 40);
  });

  it('clamps at 0 once the configured provider is fully used, never negative', async () => {
    process.env.MAILTRAP_API_TOKEN = 'test-token';
    mockMailtrapStats({ sent_count: 999, delivery_count: 0, bounce_count: 0 });
    const { getAvailableCascadeQuota } = await loadCascade();
    expect(await getAvailableCascadeQuota()).toBe(0);
  });

  it('returns 0 when no provider is configured at all', async () => {
    const { getAvailableCascadeQuota } = await loadCascade();
    expect(await getAvailableCascadeQuota()).toBe(0);
  });

  it('does not double-fetch provider usage on a second call the same day (memoized sync)', async () => {
    process.env.MAILTRAP_API_TOKEN = 'test-token';
    let fetchCalls = 0;
    globalThis.fetch = (async (url: string) => {
      fetchCalls++;
      if (String(url).includes('/api/accounts/')) {
        return { ok: true, status: 200, json: async () => ({ sent_count: 10, delivery_count: 0, bounce_count: 0 }) } as any;
      }
      return { ok: true, status: 200, json: async () => [{ id: 1 }] } as any;
    }) as any;
    const { getAvailableCascadeQuota, PROVIDERS } = await loadCascade();
    const mailtrapLimit = PROVIDERS.find((p) => p.id === 'mailtrap').dailyLimit;
    expect(await getAvailableCascadeQuota()).toBe(mailtrapLimit - 10);
    const callsAfterFirst = fetchCalls;
    expect(await getAvailableCascadeQuota()).toBe(mailtrapLimit - 10);
    expect(fetchCalls).toBe(callsAfterFirst); // second call reused the memoized sync, no new fetch
  });
});
