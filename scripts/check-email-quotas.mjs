#!/usr/bin/env node
/**
 * check-email-quotas.mjs — Verify the daily/monthly sending limits of every
 * configured email provider by hitting their real usage endpoints.
 *
 * For each provider it prints: configured?, used today, remaining today, daily
 * limit (the per-provider usage APIs are queried by syncQuotasFromAPIs). For
 * Cloudflare Email Service — whose quota is MONTHLY, not daily — it additionally
 * reports month-to-date consumption against the 3000/mo allowance via the
 * GraphQL Analytics API (emailSendingAdaptiveGroups). Same idea for Maileroo
 * (100k/mo plan since 2026-07-20) via its Account API statistics endpoint,
 * best-effort — falls back to "unverified" if the sending key lacks the
 * statistics.read scope, sending is unaffected either way.
 *
 * It also watches Resend's quota-cycle burn rate (cycle anchored on the 6th
 * of each month, same as the cascade's own dynamic daily cap) and opens a
 * GitHub issue if usage is running ahead of the pace needed to land at/under
 * the free plan's 3000/mo quota — a signal the dynamic cap alone can't surface,
 * since it only throttles FUTURE sends, it doesn't tell a human the burn rate
 * looks wrong (e.g. verification blind spot, cap bypassed, real demand spike).
 *
 * Usage (env must already carry the provider keys — run load-rc-env first):
 *   eval "$(node scripts/load-rc-env.mjs)" && node scripts/check-email-quotas.mjs
 *   node scripts/check-email-quotas.mjs --dry-run   # print, never open an issue
 *
 * Exit code is always 0 — this is a read-only diagnostic, never a gate.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  PROVIDERS,
  syncQuotasFromAPIs,
  logProviderSummary,
  isProviderConfigured,
  fetchCloudflareUsage,
  fetchCloudflareDeliveryStats,
  fetchResendCycleUsage,
  fetchMailerooCycleUsage,
  fetchMailtrapCycleUsage,
} from './lib/email-cascade.mjs';

// 15% slack over the expected pace before alerting — daily sends are lumpy
// (newsletter days vs quiet days), so a small overshoot is normal noise, not
// a real risk to the 3000/mo cap. Below 20% of the monthly quota consumed we
// skip the check entirely: early in the cycle a handful of transactional
// sends can look like a huge overshoot in ratio terms while being a
// negligible absolute risk (e.g. 3 sent vs 1 expected = "300% of pace").
const RESEND_PACE_BUFFER = 1.15;
const RESEND_PACE_MIN_USAGE_RATIO = 0.2;
const RESEND_PACING_ISSUE_TITLE = 'Resend: burn rate ahead of pace for 3k/mo free quota';
const WORKFLOW_NAME = 'Email Quota Check';

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonthUTC() {
  return todayUTC().slice(0, 7) + '-01';
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Pure ratio math, split out from checkResendPacing() so it's testable
 * without mocking the network (mirrors dmarc-monitor.mjs's analyze()).
 * Returns a signal object when usage is meaningfully ahead of pace, or null
 * when on-pace / too-early-to-tell (fail-safe: never alert on noise).
 */
export function computePacingSignal({ count, monthlyLimit, cycleStart, cycleEnd, now }) {
  const totalCycleMs = cycleEnd.getTime() - cycleStart.getTime();
  const elapsedMs = now - cycleStart.getTime();
  const expectedRatio = Math.min(1, Math.max(0, elapsedMs / totalCycleMs));
  const actualRatio = count / monthlyLimit;
  const daysRemaining = Math.max(1, Math.ceil((cycleEnd.getTime() - now) / 86_400_000));

  const signal = { count, monthlyLimit, actualRatio, expectedRatio, daysRemaining, cycleStart, cycleEnd };

  if (actualRatio < RESEND_PACE_MIN_USAGE_RATIO) return { ...signal, aheadOfPace: false };
  if (actualRatio <= expectedRatio * RESEND_PACE_BUFFER) return { ...signal, aheadOfPace: false };
  return { ...signal, aheadOfPace: true };
}

/**
 * Fetches Resend's cycle-to-date usage and runs it through computePacingSignal().
 * Returns null when unconfigured/unverifiable (fail-safe) or on-pace.
 */
async function checkResendPacing() {
  if (!isProviderConfigured('resend')) return null;
  const provider = PROVIDERS.find((p) => p.id === 'resend');
  const { count, truncated, cycleStart, cycleEnd } = await fetchResendCycleUsage();
  if (truncated) {
    console.log('\n⚠️  Resend cycle usage unverifiable (paging truncated) — cannot assess pacing.');
    return null;
  }

  const signal = computePacingSignal({ count, monthlyLimit: provider.monthlyLimit, cycleStart, cycleEnd, now: Date.now() });
  console.log(`\n📈 Resend cycle pacing: used ${signal.count}/${signal.monthlyLimit} (${pct(signal.actualRatio)}), expected pace ${pct(signal.expectedRatio)}, ${signal.daysRemaining}d remaining in quota cycle (${cycleEnd.toISOString().slice(0, 10)}).`);

  return signal.aheadOfPace ? signal : null;
}

export function buildPacingIssueBody(signal) {
  return [
    '## 📈 Resend: burn rate ahead of pace',
    '',
    `Ciclo quota **${signal.cycleStart.toISOString().slice(0, 10)} → ${signal.cycleEnd.toISOString().slice(0, 10)}** (reset il 6 del mese).`,
    '',
    `Usati **${signal.count} / ${signal.monthlyLimit}** (**${pct(signal.actualRatio)}**) contro un ritmo atteso del **${pct(signal.expectedRatio)}**.`,
    `Giorni rimanenti nel ciclo quota: **${signal.daysRemaining}**.`,
    '',
    'Il cap dinamico su Resend (`computeResendDynamicDailyLimit` in `functions/src/emailCascade.js`)',
    'rallenta automaticamente gli invii FUTURI in base a questo stesso calcolo, ma non segnala a un',
    'umano quando il ritmo attuale è già fuori scala — questo alert copre quel buco (cap bypassato,',
    'lookup usage inaffidabile ripetuto, picco reale di domanda).',
    '',
    '### Possibili cause',
    '- Un invio ha bypassato la cascade (bypass diretto Resend non ancora individuato).',
    '- Il riordino dei provider non sta assorbendo abbastanza volume prima di Resend.',
    '- Picco reale di domanda (newsletter/job-alert più grandi del solito).',
    '',
    '_Aperta automaticamente dal workflow Email Quota Check. Chiudi quando il ritmo rientra sotto pace._',
  ].join('\n');
}

function createIssue({ title, description, priority }) {
  // Mirrors dmarc-monitor.mjs's createIssue(). `automation` label keeps the
  // deterministic issue-triage classifier from routing this to an auto-fixer.
  execFileSync(
    'node',
    [
      'scripts/lib/github-issue-creator.mjs',
      '--title', title,
      '--description', description,
      '--priority', String(priority),
      '--label', 'automation',
      '--workflow', WORKFLOW_NAME,
    ],
    { stdio: 'inherit' },
  );
}

function parseArgs(argv) {
  const opts = { dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') opts.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main(opts) {
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
    const [today, mtd, todayStats] = await Promise.all([
      fetchCloudflareUsage(todayUTC(), todayUTC()),
      fetchCloudflareUsage(firstOfMonthUTC(), todayUTC()),
      fetchCloudflareDeliveryStats(todayUTC(), todayUTC()),
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
      // Delivery-event observation. Cloudflare has no webhook and no open/click
      // tracking — delivery STATUS via this pull dataset is the only event signal.
      if (todayStats && Object.keys(todayStats.byStatus).length) {
        const breakdown = Object.entries(todayStats.byStatus)
          .sort((a, b) => b[1] - a[1])
          .map(([s, n]) => `${s}=${n}`)
          .join(', ');
        console.log(`   Delivery status today:    ${breakdown}`);
      }
    }
  }

  // Maileroo: surface real calendar-month-to-date usage (2026-07-20, 100k/mo
  // plan) via the Account API statistics endpoint, same best-effort probe
  // computeMailerooDynamicDailyLimit already does for pacing — this just
  // prints it. verified:false means the sending key doesn't carry the
  // statistics.read scope (or the endpoint errored); sending is unaffected
  // either way, since the daily guard falls back to the conservative static
  // floor in that case.
  if (isProviderConfigured('maileroo')) {
    const monthlyCap = PROVIDERS.find(p => p.id === 'maileroo')?.monthlyLimit ?? 100000;
    const { count, verified } = await fetchMailerooCycleUsage();
    console.log('\n📮 Maileroo (Account API statistics):');
    if (!verified) {
      console.log('   ⚠️  Usage endpoint unreachable/unauthorized — key needs the statistics.read scope.');
      console.log('       (Sending is unaffected: the daily guard falls back to a conservative static pace.)');
    } else {
      const remaining = Math.max(0, monthlyCap - count);
      console.log(`   Delivered+bounced month-to-date: ${count} / ${monthlyCap}  (≈${remaining} remaining this month)`);
      console.log('   Note: delivered+bounced is a lower-bound proxy (no raw "sent" counter exposed) — may under-count sends still in flight.');
    }
  }

  // Mailtrap: surface real billing-cycle usage via /billing/usage (discovered
  // 2026-07-20 auditing all providers — the /stats endpoint's sent_count field
  // this cascade used to rely on never actually appears in this account's
  // responses, silently defeating its own under-count safety net; see
  // computeMailtrapDynamicDailyLimit in functions/src/emailCascade.js).
  if (isProviderConfigured('mailtrap')) {
    const monthlyCap = PROVIDERS.find(p => p.id === 'mailtrap')?.monthlyLimit ?? 4000;
    const { count, apiLimit, cycleStart, cycleEnd, verified } = await fetchMailtrapCycleUsage();
    console.log('\n📨 Mailtrap (billing/usage):');
    if (!verified) {
      console.log('   ⚠️  Usage endpoint unreachable/unauthorized — sending is unaffected, daily guard falls back to a conservative static pace.');
    } else {
      // Display against the live apiLimit when available, not the possibly-
      // stale static config (review finding, PR #4583 — same fix as
      // computeMailtrapDynamicDailyLimit in emailCascade.js).
      const cap = apiLimit || monthlyCap;
      const remaining = Math.max(0, cap - count);
      console.log(`   Sent this cycle (${cycleStart.toISOString().slice(0, 10)}→${cycleEnd.toISOString().slice(0, 10)}): ${count} / ${cap}  (≈${remaining} remaining)`);
      if (apiLimit && apiLimit !== monthlyCap) {
        console.log(`   ⚠️  Live plan limit (${apiLimit}) differs from configured monthlyLimit (${monthlyCap}) — update PROVIDERS in emailCascade.js.`);
      }
    }
  }

  const pacingSignal = await checkResendPacing();
  if (pacingSignal) {
    if (opts.dryRun) {
      console.log(`\n[dry-run] Would open issue "${RESEND_PACING_ISSUE_TITLE}" (priority 2).`);
    } else {
      console.log(`\n🚨 Resend ahead of pace — opening/updating GitHub issue.`);
      createIssue({
        title: RESEND_PACING_ISSUE_TITLE,
        description: buildPacingIssueBody(pacingSignal),
        priority: 2,
      });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv);
  main(opts).catch(err => {
    console.error('check-email-quotas failed:', err?.message || err);
    // Diagnostic only — never fail a pipeline on this.
    process.exit(0);
  });
}
