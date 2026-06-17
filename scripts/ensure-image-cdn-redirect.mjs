#!/usr/bin/env node
/**
 * ensure-image-cdn-redirect.mjs — idempotently ensure the Cloudflare Redirect
 * Rule that 301s the offloaded self-hosted image prefixes from the apex to the
 * dedicated CDN (cdn.frontaliereticino.ch).
 *
 * Why this exists (in-repo IaC, not a mystery dashboard click): the brand/logo
 * images are offloaded out of the GitHub Pages artifact to the CDN repo and
 * DELETED from dist (scripts/offload-generated-images-cdn.mjs). Our own outputs
 * already point at the CDN (services/cdnImageBase.ts cdnImageUrl, the offload
 * HTML rewrite, newsletter-content.mjs IMAGE_CDN_BASE), but EXTERNAL referrers
 * and Google-Images cache still hit the old apex `/images/{prefix}/…` paths and
 * 404 there (~1.1k hits/day measured via Cloudflare edge analytics, 2026-06-17).
 * A single edge Redirect Rule recovers them at zero dist cost (vs re-bloating
 * the artifact by keeping the files in dist).
 *
 * Free-plan note: the `matches` (regex) operator needs Business/WAF-Advanced, so
 * the expression uses `starts_with(...) or …` over each prefix — allowed on Free.
 * `/images/places/` is intentionally NOT redirected (stays same-origin, blog
 * hero places), matching CDN_OFFLOADED_IMAGE_PREFIXES in services/cdnImageBase.ts.
 *
 * Auth: CF_API_TOKEN needs Zone→Dynamic Redirect→Edit on the zone (hydrated from
 * Firebase Remote Config by scripts/load-rc-env.mjs). Idempotent: matches the
 * rule by its description and updates in place, else appends; never duplicates.
 *
 * Usage:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=… node scripts/load-rc-env.mjs)" \
 *     && node scripts/ensure-image-cdn-redirect.mjs
 *   node scripts/ensure-image-cdn-redirect.mjs --dry-run
 */

import { resolveZoneId, DEFAULT_ZONE_NAME, REST_BASE } from './lib/cf-analytics.mjs';

const CDN_BASE = 'https://cdn.frontaliereticino.ch';

// MUST stay in sync with CDN_OFFLOADED_IMAGE_PREFIXES in services/cdnImageBase.ts
// (and IMAGE_TARGETS in scripts/offload-generated-images-cdn.mjs). `/images/places/`
// is deliberately excluded — it stays same-origin.
const OFFLOADED_PREFIXES = [
  '/images/brands/',
  '/images/insurers/',
  '/images/providers/',
  '/images/logos/',
  '/images/authors/',
  '/images/publisher/',
];

const RULE_DESCRIPTION = 'Offloaded images -> CDN (apex 404 recovery)';
const PHASE = 'http_request_dynamic_redirect';

// Host-scoped to the apex. The rule lives at zone level, so without the host
// clause it would also fire on any OTHER hostname in the zone. cdn.frontaliereticino.ch
// is DNS-only today (not proxied), so the phase doesn't run on CDN requests — but if
// the CDN were ever put behind Cloudflare (orange-cloud), every cdn…/images/brands/x.png
// would match the prefix and 301 to itself → infinite redirect loop on every offloaded
// image. The `http.host eq APEX` guard makes the rule fire ONLY on the apex, where the
// offloaded paths genuinely 404. Reviewer 🔴 on #2396.
const APEX_HOST = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME;
const buildExpression = () =>
  '(' + OFFLOADED_PREFIXES.map((p) => `starts_with(http.request.uri.path, "${p}")`).join(' or ') +
  `) and http.host eq "${APEX_HOST}"`;

const buildRule = () => ({
  action: 'redirect',
  action_parameters: {
    from_value: {
      target_url: { expression: `concat("${CDN_BASE}", http.request.uri.path)` },
      status_code: 301,
      preserve_query_string: true,
    },
  },
  expression: buildExpression(),
  description: RULE_DESCRIPTION,
  enabled: true,
});

async function cfFetch(token, path, init = {}) {
  const res = await fetch(`${REST_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Cloudflare returned non-JSON (HTTP ${res.status}) for ${path}`);
  if (!json.success) {
    const err = new Error(`Cloudflare API error for ${path}: ${JSON.stringify(json.errors || [])}`);
    err.cfErrors = json.errors || [];
    err.httpStatus = res.status;
    throw err;
  }
  return json.result;
}

/**
 * Read the dynamic_redirect entrypoint rules. A phase that has NEVER had a
 * ruleset returns CF error code 10003 ("could not find entrypoint ruleset …") —
 * that is the only "genuinely empty" case, treated as `[]`. EVERY other failure
 * (429/5xx/network/missing-scope) MUST propagate: swallowing it here would make
 * `existing` empty and the subsequent full-array PUT would clobber any OTHER
 * redirect rules already in the phase (data loss). Reviewer 🔴 on #2396.
 */
async function readEntrypointRules(token, zoneId) {
  try {
    const result = await cfFetch(token, `/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`);
    return Array.isArray(result?.rules) ? result.rules : [];
  } catch (err) {
    const noEntrypoint =
      err.httpStatus === 404 || (err.cfErrors || []).some((e) => e?.code === 10003);
    if (noEntrypoint) return [];
    throw err; // transient / auth / other — never proceed to a truncating PUT
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.error('❌ CF_API_TOKEN not set. Run `node scripts/load-rc-env.mjs` first (needs Dynamic Redirect→Edit).');
    process.exit(1);
  }
  const zoneId = await resolveZoneId(token, process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME, process.env.CF_ZONE_ID);

  const existing = await readEntrypointRules(token, zoneId);
  const desired = buildRule();

  const idx = existing.findIndex((r) => r.description === RULE_DESCRIPTION);
  const next = existing.map((r) => ({
    // Strip server-managed fields so the PUT round-trips cleanly.
    action: r.action,
    action_parameters: r.action_parameters,
    expression: r.expression,
    description: r.description,
    enabled: r.enabled,
  }));
  if (idx >= 0) {
    const cur = existing[idx];
    const curFv = cur.action_parameters?.from_value;
    const wantFv = desired.action_parameters.from_value;
    if (cur.expression === desired.expression &&
        curFv?.target_url?.expression === wantFv.target_url.expression &&
        curFv?.status_code === wantFv.status_code &&
        curFv?.preserve_query_string === wantFv.preserve_query_string &&
        cur.enabled === desired.enabled) {
      console.log('✅ Redirect Rule already present and current — no change.');
      return;
    }
    next[idx] = desired;
    console.log('🔁 Updating existing Redirect Rule.');
  } else {
    next.push(desired);
    console.log('➕ Appending new Redirect Rule.');
  }

  console.log(`   expr: ${desired.expression}`);
  console.log(`   →     ${desired.action_parameters.from_value.target_url.expression} (301)`);
  if (dryRun) {
    console.log('🧪 --dry-run: no write.');
    return;
  }

  await cfFetch(token, `/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({ rules: next }),
  });
  console.log(`✅ Redirect Rule ensured (${next.length} rule(s) in ${PHASE}).`);
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exit(1);
});
