#!/usr/bin/env node
/**
 * check-email-quotas.mjs — Verify the daily/monthly sending limits of every
 * configured email provider by hitting their real usage endpoints.
 *
 * For each provider it prints: configured?, used today, remaining today, daily
 * limit (the per-provider usage APIs are queried by syncQuotasFromAPIs). For
 * Cloudflare Email Service — whose quota is MONTHLY, not daily — it additionally
 * reports month-to-date consumption against the 3000/mo allowance via the
 * GraphQL Analytics API (emailSendingAdaptiveGroups).
 *
 * Usage (env must already carry the provider keys — run load-rc-env first):
 *   eval "$(node scripts/load-rc-env.mjs)" && node scripts/check-email-quotas.mjs
 *
 * Exit code is always 0 — this is a read-only diagnostic, never a gate.
 */

import {
  PROVIDERS,
  syncQuotasFromAPIs,
  logProviderSummary,
  isProviderConfigured,
  fetchCloudflareUsage,
} from './lib/email-cascade.mjs';

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonthUTC() {
  return todayUTC().slice(0, 7) + '-01';
}

async function main() {
  console.log('🔎 Email provider quota check\n');

  const configured = PROVIDERS.filter(p => isProviderConfigured(p.id)).map(p => p.id);
  if (configured.length === 0) {
    console.log('⚠️  No email providers configured in this environment.');
    console.log('   Run `eval "$(node scripts/load-rc-env.mjs)"` first to load keys from Remote Config.');
    return;
  }
  console.log(`Configured providers: ${configured.join(', ')}\n`);

  // Hits each provider's usage API and seeds the in-memory counters.
  await syncQuotasFromAPIs();
  logProviderSummary();

  // Cloudflare Email Service: surface the real MONTHLY consumption (its actual
  // billing dimension) against the included allowance — the daily-summary row
  // above is in-memory only for this provider.
  if (isProviderConfigured('cloudflare')) {
    const monthlyCap = PROVIDERS.find(p => p.id === 'cloudflare')?.monthlyLimit ?? 3000;
    const [today, mtd] = await Promise.all([
      fetchCloudflareUsage(todayUTC(), todayUTC()),
      fetchCloudflareUsage(firstOfMonthUTC(), todayUTC()),
    ]);
    console.log('\n☁️  Cloudflare Email Service (GraphQL Analytics):');
    if (mtd === null) {
      console.log('   ⚠️  Usage endpoint unreachable/unauthorized — token needs the Analytics Read scope.');
      console.log('       (Sending is unaffected: the daily guard falls back to the in-memory counter.)');
    } else {
      const remaining = Math.max(0, monthlyCap - mtd);
      console.log(`   Send events today:        ${today ?? 'n/a'}`);
      console.log(`   Send events month-to-date: ${mtd} / ${monthlyCap}  (≈${remaining} remaining this month)`);
      console.log('   Note: counts raw send EVENTS (queued/delivered/bounced), so it may exceed the email count.');
    }
  }
}

main().catch(err => {
  console.error('check-email-quotas failed:', err?.message || err);
  // Diagnostic only — never fail a pipeline on this.
  process.exit(0);
});
