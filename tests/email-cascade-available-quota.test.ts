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
 *
 * Vehicle: resend (not mailtrap — mailtrap was removed from PROVIDERS
 * 2026-07-29, see the PROVIDERS comment in functions/src/emailCascade.js).
 * resend is API-driven like mailtrap was: fetchResendDailyUsage() feeds the
 * in-memory counter with a real, mockable number, and remainingQuota()'s own
 * Math.max(0, ...) clamp is reachable by driving that counter past the
 * provider's effective (dynamic) daily limit — cloudflare/maileroo can't
 * stand in here because their daily-usage fetchers are hardcoded to return 0
 * (see fetchCloudflareDailyUsage / fetchMailerooDailyUsage), so the counter
 * side of "limit minus already-used" would never move for them.
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

// Resend has no date-range filter on GET /emails (verified against live docs,
// see fetchResendEntriesSince in emailCascade.js) — it always returns entries
// newest-first regardless of query params, so a single flat page (has_more:
// false) is a faithful mock for BOTH fetchResendDailyUsage (today) and
// computeResendDynamicDailyLimit's cycle-usage lookup (this billing cycle).
function mockResendUsage(entries: Array<{ id: string; created_at: string }>) {
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('api.resend.com/emails')) {
      return { ok: true, json: async () => ({ data: entries, has_more: false }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }) as any;
}

function resendEntries(count: number, dateStr: string) {
  const entry = { id: 'e', created_at: `${dateStr}T08:00:00.000Z` };
  return Array.from({ length: count }, () => entry);
}

// Regression: removing a provider from PROVIDERS must not make the quota sync
// throw. computeMailtrapDynamicDailyLimit() looked mailtrap up in PROVIDERS and
// dereferenced `.monthlyLimit` — undefined once the entry was gone. That throw
// escaped syncQuotasFromAPIs(), which sendEmailCascade() awaits, so it would
// have failed EVERY send. It was invisible under the existing mocks because the
// dereference only runs when the provider API returns a plan limit; it appeared
// only against real credentials. This test reproduces that shape: credentials
// present for a provider that is NOT in PROVIDERS, and an API answering with a
// plan limit.
describe('quota sync tolerates credentials for a provider absent from PROVIDERS', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of PROVIDER_ENV_VARS) delete process.env[key];
  });

  it('does not throw when MAILTRAP_API_TOKEN is set but mailtrap is not a provider', async () => {
    process.env.MAILTRAP_API_TOKEN = 'token-for-a-removed-provider';
    // Answer every lookup with a plan limit — the exact condition that used to
    // reach `provider.monthlyLimit` on an undefined provider.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 1, sent_count: 10, delivery_count: 10, bounce_count: 0, limit: 4000, plan: { limit: 4000 } }),
      text: async () => '{}',
    })) as any;

    const { getAvailableCascadeQuota, PROVIDERS } = await loadCascade();
    expect(PROVIDERS.find((p) => p.id === 'mailtrap')).toBeUndefined();
    await expect(getAvailableCascadeQuota()).resolves.toBeTypeOf('number');
  });
});

describe('getAvailableCascadeQuota', () => {
  const realFetch = globalThis.fetch;
  const today = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    for (const key of PROVIDER_ENV_VARS) delete process.env[key];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of PROVIDER_ENV_VARS) delete process.env[key];
  });

  it('sums remaining quota only across configured providers', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    mockResendUsage(resendEntries(40, today));
    const { getAvailableCascadeQuota, computeResendDynamicDailyLimit, fetchResendDailyUsage } = await loadCascade();
    const dynamicLimit = await computeResendDynamicDailyLimit();
    const dailyUsage = await fetchResendDailyUsage();
    expect(dailyUsage).toBe(40); // sanity: the mock is actually driving the "already used" figure
    expect(await getAvailableCascadeQuota()).toBe(Math.max(0, dynamicLimit - dailyUsage));
  });

  it('clamps at 0 once the configured provider is fully used, never negative', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    // The free plan allows at most 100/day, so exactly 100 already sent leaves
    // no local quota even when the monthly budget has room left.
    mockResendUsage(resendEntries(100, today));
    const { getAvailableCascadeQuota } = await loadCascade();
    expect(await getAvailableCascadeQuota()).toBe(0);
  });

  it('returns 0 when no provider is configured at all', async () => {
    const { getAvailableCascadeQuota } = await loadCascade();
    expect(await getAvailableCascadeQuota()).toBe(0);
  });

  it('does not double-fetch provider usage on a second call the same day (memoized sync)', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const entries = resendEntries(10, today);
    let fetchCalls = 0;
    globalThis.fetch = (async (url: string) => {
      fetchCalls++;
      if (String(url).includes('api.resend.com/emails')) {
        return { ok: true, json: async () => ({ data: entries, has_more: false }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any;
    const { getAvailableCascadeQuota, computeResendDynamicDailyLimit, fetchResendDailyUsage } = await loadCascade();
    // Warm-up probes, on the same module instance, to derive the expected
    // number from the real production formula rather than a hand-copied one.
    const expectedQuota = Math.max(0, (await computeResendDynamicDailyLimit()) - (await fetchResendDailyUsage()));
    fetchCalls = 0; // reset the counter baseline after the warm-up probes above
    expect(await getAvailableCascadeQuota()).toBe(expectedQuota);
    const callsAfterFirst = fetchCalls;
    expect(callsAfterFirst).toBeGreaterThan(0); // the first call must actually sync from the API
    expect(await getAvailableCascadeQuota()).toBe(expectedQuota);
    expect(fetchCalls).toBe(callsAfterFirst); // second call reused the memoized sync, no new fetch
  });
});

describe('PROVIDERS invariant', () => {
  // mailtrap was removed from the cascade 2026-07-29: its send stream was
  // suspended, so it accepted every message, returned a message_id, and
  // delivered nothing — while its per-message `suspension` webhook was being
  // mis-mapped into a per-subscriber suppression that dropped 1676 real
  // subscribers, more than a fifth of the base, from the newsletter. This test is the
  // guard against silently re-adding a provider that swallows mail; the
  // fetchMailtrap*/computeMailtrapDynamicDailyLimit helpers stay exported
  // and tested (see tests/email-cascade-burst.test.ts) since restoring the
  // entry once Mailtrap's stream is verified sending again only needs the
  // PROVIDERS line back, not the helpers rewritten.
  it('never re-includes mailtrap', async () => {
    const { PROVIDERS } = await loadCascade();
    expect(PROVIDERS.find((p) => p.id === 'mailtrap')).toBeUndefined();
  });
});
