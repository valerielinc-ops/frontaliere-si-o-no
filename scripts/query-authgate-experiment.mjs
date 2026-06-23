#!/usr/bin/env node
/**
 * Query the auth-gate headline A/B experiment from PostHog and print, per
 * variant, the per-person gate→auth_success conversion rate plus a
 * two-proportion z-test of each challenger against `control`.
 *
 * Results feed docs/AUTHGATE-HEADLINE-EXPERIMENT.md. Re-run anytime to decide
 * whether a round has a winner.
 *
 * Auth: needs PostHog server creds. Either export them directly:
 *   POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, POSTHOG_HOST
 * or load them from Remote Config (Firebase SA required):
 *   GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     eval "$(node scripts/load-rc-env.mjs | grep POSTHOG)" \
 *     && node scripts/query-authgate-experiment.mjs
 *
 * Flags:
 *   --days <n>      lookback window in days (default 90)
 *   --since <date>  absolute lower-bound date (YYYY-MM-DD); combined with --days
 *                   via AND. Use to bound round-N queries to their start date and
 *                   avoid contamination from stale `headline_variant` super
 *                   properties set in earlier rounds (persistent via ph.register).
 *                   Example: --since 2026-06-01 for round-2 (launched 2026-06-01).
 *   --event <e>     funnel event name (default job_auth_funnel)
 *   --prop <p>      super-property holding the arm: headline_variant (default,
 *                   copy test) or gate_model (structural test, authgate-model-v1)
 */

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const days = Number(getArg('--days', '90'));
const since = getArg('--since', null);
const event = getArg('--event', 'job_auth_funnel');
// Which super-property holds the arm: `headline_variant` (copy test, default) or
// `gate_model` (structural test, flag authgate-model-v1).
const prop = getArg('--prop', 'headline_variant');

const key = process.env.POSTHOG_PERSONAL_API_KEY;
const project = process.env.POSTHOG_PROJECT_ID;
const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
if (!key || !project) {
  console.error('Missing POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID. See header for auth.');
  process.exit(1);
}

const url = `${host}/api/projects/${project}/query/`;
async function runQuery(hogql) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  });
  if (!res.ok) throw new Error(`posthog ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).results || [];
}

// Standard normal CDF via the Abramowitz-Stegun erf approximation.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t) *
      Math.exp(-x * x);
  return x < 0 ? -y : y;
}
const twoSidedP = (z) => 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));

function zTest(a, b) {
  // a, b: { persons, conv }
  const p1 = a.conv / a.persons;
  const p2 = b.conv / b.persons;
  const pooled = (a.conv + b.conv) / (a.persons + b.persons);
  // Pooled SE — correct for the z-test (null hypothesis p1 === p2).
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.persons + 1 / b.persons));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  // Unpooled SE — correct for the CI on the difference of proportions (the
  // arms have distinct CRs, so they don't share a pooled variance). Using the
  // pooled SE here slightly over-states the printed ±CI.
  const seDiff = Math.sqrt((p1 * (1 - p1)) / a.persons + (p2 * (1 - p2)) / b.persons);
  return { p1, p2, z, p: twoSidedP(z), absLiftPp: (p2 - p1) * 100, ciHalfPp: 1.96 * seDiff * 100 };
}

const windowLabel = since ? `since ${since}` : `last ${days}d`;
const sinceClause = since ? `  AND timestamp >= toDateTime('${since}')\n` : '';
const hogql = `
SELECT properties.${prop} AS variant,
       uniqIf(person_id, properties.action = 'gate_view')    AS gate_persons,
       uniqIf(person_id, properties.action = 'auth_success') AS conv_persons
FROM events
WHERE event = '${event}'
  AND timestamp > now() - INTERVAL ${days} DAY
${sinceClause}  AND properties.${prop} IS NOT NULL
GROUP BY variant
ORDER BY variant`;

const rows = await runQuery(hogql);
if (!rows.length) {
  console.log(`No variant-attributed rows for '${event}' (${windowLabel}).`);
  process.exit(0);
}

const arms = new Map();
for (const [variant, gate, conv] of rows) {
  arms.set(variant, { persons: Number(gate), conv: Number(conv) });
}

console.log(`=== Auth-gate experiment [${prop}] — ${event}, ${windowLabel} (per-person) ===`);
for (const [variant, a] of arms) {
  const cr = a.persons ? (a.conv / a.persons) * 100 : 0;
  console.log(`${variant.padEnd(13)} persons=${a.persons}  auth_success=${a.conv}  CR=${cr.toFixed(2)}%`);
}

const control = arms.get('control');
if (!control) {
  console.log('\nNo `control` arm present — cannot run significance test.');
  process.exit(0);
}
console.log('\n--- vs control ---');
for (const [variant, a] of arms) {
  if (variant === 'control') continue;
  const t = zTest(control, a);
  const verdict =
    t.p < 0.01 && t.absLiftPp - t.ciHalfPp > 0
      ? 'WINNER (sig.)'
      : t.p < 0.01 && t.absLiftPp + t.ciHalfPp < 0
        ? 'LOSES (sig.)'
        : 'inconclusive';
  console.log(
    `${variant.padEnd(13)} lift=${t.absLiftPp >= 0 ? '+' : ''}${t.absLiftPp.toFixed(2)}pp ` +
      `(95% CI ±${t.ciHalfPp.toFixed(2)}pp)  z=${t.z.toFixed(2)}  p=${t.p.toExponential(2)}  → ${verdict}`,
  );
}
