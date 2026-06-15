#!/usr/bin/env node
/**
 * setup-posthog-email-funnel.mjs — create the subject A/B funnel insights in
 * PostHog (idempotent by name). Companion to the server-side capture wired in
 * functions/src/lib/emailExperimentPostHog.js (events `email_sent` →
 * `email_opened`, tied by distinct_id = email).
 *
 * Creates two saved Funnel insights:
 *   1. "Email subject A/B — open rate by variant"   (breakdown subject_variant)
 *   2. "Email subject A/B — open rate by provider"  (breakdown email_provider)
 *
 * Both use a 3-day conversion window (well under the weekly cadence) so a later
 * campaign's open can't be mis-attributed to an earlier campaign's variant. For
 * exact per-campaign attribution, open the insight and add a `campaign_id`
 * property filter for the week you're analyzing.
 *
 * Auth (same as scripts/query-authgate-experiment.mjs):
 *   POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, POSTHOG_HOST
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs | grep POSTHOG)" \
 *     && node scripts/setup-posthog-email-funnel.mjs
 *
 * The personal API key needs `insight:write` scope. Re-runnable: skips an
 * insight whose name already exists.
 */

const key = process.env.POSTHOG_PERSONAL_API_KEY;
const project = process.env.POSTHOG_PROJECT_ID;
const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');

if (!key || !project) {
  console.error('❌ Missing POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID. See header for auth.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };

function funnelFilters(breakdown) {
  return {
    insight: 'FUNNELS',
    events: [
      { id: 'email_sent', name: 'email_sent', type: 'events', order: 0 },
      { id: 'email_opened', name: 'email_opened', type: 'events', order: 1 },
    ],
    breakdown,
    breakdown_type: 'event',
    funnel_viz_type: 'steps',
    funnel_window_interval: 3,
    funnel_window_interval_unit: 'day',
    date_from: '-60d',
  };
}

const INSIGHTS = [
  { name: 'Email subject A/B — open rate by variant', filters: funnelFilters('subject_variant') },
  { name: 'Email subject A/B — open rate by provider', filters: funnelFilters('email_provider') },
];

async function findByName(name) {
  const url = `${host}/api/projects/${project}/insights/?search=${encodeURIComponent(name)}&limit=100`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`list insights ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.results || []).find((i) => i.name === name) || null;
}

async function createInsight({ name, filters }) {
  const existing = await findByName(name);
  if (existing) {
    console.log(`↩︎  Exists: "${name}" → ${host}/project/${project}/insights/${existing.short_id}`);
    return existing;
  }
  const res = await fetch(`${host}/api/projects/${project}/insights/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, filters, saved: true }),
  });
  if (!res.ok) throw new Error(`create "${name}" ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const created = await res.json();
  console.log(`✅ Created: "${name}" → ${host}/project/${project}/insights/${created.short_id}`);
  return created;
}

async function main() {
  for (const insight of INSIGHTS) {
    await createInsight(insight);
  }
  console.log('\nDone. Open one insight and add a `campaign_id` filter to read a single week exactly.');
}

main().catch((err) => {
  console.error('❌ setup-posthog-email-funnel failed:', err?.message || err);
  process.exit(1);
});
