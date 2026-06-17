#!/usr/bin/env node
/**
 * cf-otto-route-monitor.mjs — detect re-appearance of SearchAtlas "OTTO"
 * Cloudflare Worker routes on the production zone.
 *
 * ─── Why this exists ───────────────────────────────────────────────────────
 * 2026-06-15: the apex `frontaliereticino.ch` was serving zone-wide 429 (CF
 * error 1027, 30.638/24h) + 504 (68.389/24h) to REAL users — not just the CI
 * datacenter IP. Root cause was the SearchAtlas **OTTO** integration: an edge
 * Worker (`otto-pixel-worker`) bound to a catch-all route `frontaliereticino.ch/*`
 * (and `www.frontaliereticino.ch/*`) whose degraded rate-limiter/backend
 * (`otto-ratelimit.internal`, `sa.searchatlas.com`) 429'd & 504'd everything.
 * The two routes were deleted via the CF API and the apex returned 200 instantly.
 *
 * The catch: SearchAtlas can **re-create those routes automatically** — it
 * reconnects to Cloudflare with its own token. Permanently disabling it is
 * owner-only (disconnect the integration / revoke the SearchAtlas CF token in
 * the SearchAtlas dashboard — outside this repo). Until that happens, this
 * monitor is the in-repo early-warning so a re-appearance doesn't silently
 * recreate the outage. PR #2138's Lighthouse probe-gate only *skips* the audit
 * on 429 (self-healing for CI), it does NOT alert that OTTO is back — that gap
 * is what this closes (follow-up issue #2142).
 *
 * ─── What it does ──────────────────────────────────────────────────────────
 * Lists every Worker route on the zone via the CF REST API
 * (`GET /zones/{zone}/workers/routes`) and flags any route that looks like the
 * OTTO integration:
 *   - the bound Worker script name matches /otto|searchatlas|pixel/i, OR
 *   - the route pattern is a broad catch-all (e.g. `<host>/<star>`) bound to a
 *     script that is NOT the site's own locale-router worker.
 * The locale-router worker (frontaliere-locale-router, on the specific
 * `/en/* /de/* /fr/*` patterns) is the legitimate site worker and is allow-listed.
 *
 * Exit codes (so CI can branch on the result):
 *   0 = no OTTO routes found (clean) — or CF token missing (skip, non-blocking).
 *   3 = OTTO route(s) DETECTED → caller opens/refreshes a tracked issue.
 *   1 = hard error (API failure / bad config).
 *
 * The exit-3 vs exit-1 split lets the workflow treat "OTTO is back" (actionable
 * alert) differently from "the monitor itself broke" (infra noise), instead of
 * collapsing both into a red check.
 *
 * ─── Auth ──────────────────────────────────────────────────────────────────
 *   Needs CF_API_TOKEN with Zone → Workers Routes → Read on the zone (the same
 *   token in Remote Config that was used to DELETE the routes had write, so it
 *   has at least read). Locally:
 *
 *     eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *       node scripts/load-rc-env.mjs)" && node scripts/cf-otto-route-monitor.mjs
 *
 *   In CI: run `node scripts/load-rc-env.mjs` first (populates $GITHUB_ENV).
 *   CF_ZONE_ID is optional — resolved from the zone name when absent.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *   node scripts/cf-otto-route-monitor.mjs            # check, exit 3 if found
 *   node scripts/cf-otto-route-monitor.mjs --json      # machine-readable output
 */

import { REST_BASE, DEFAULT_ZONE_NAME, resolveZoneId } from './lib/cf-analytics.mjs';

const ZONE_NAME = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME;

// The site's own legitimate Worker. Routes bound to this script are NEVER OTTO,
// no matter how broad the pattern looks. Match by substring so a re-deploy that
// suffixes the name (e.g. -staging) still allow-lists.
const SITE_WORKER_SCRIPT = 'frontaliere-locale-router';

// A bound Worker whose script name matches this is the SearchAtlas OTTO
// integration (observed name: `otto-pixel-worker`).
const OTTO_SCRIPT_RX = /otto|searchatlas|pixel/i;

// A route pattern this broad, bound to a foreign (non-site) worker, is the OTTO
// catch-all signature even if the script were renamed: `<host>/*` or `*/*`.
const CATCH_ALL_RX = /^(\*|[^/]+)\/\*$/;

function parseArgs(argv) {
  return { json: argv.includes('--json') };
}

/** GET a CF REST path; return parsed JSON or throw with the CF error message. */
async function cfGet(token, path) {
  const res = await fetch(`${REST_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Cloudflare REST returned non-JSON (HTTP ${res.status}).`);
  if (!json.success) {
    const errs = (json.errors || []).map((e) => `${e.code} ${e.message}`).join('; ');
    throw new Error(`Cloudflare REST error on ${path}: ${errs || `HTTP ${res.status}`}`);
  }
  return json.result;
}

/** True if a Worker route is the OTTO/SearchAtlas integration. */
function isOttoRoute(route) {
  const script = (route.script || '').trim();
  const pattern = (route.pattern || '').trim();
  // The site's own worker is never OTTO.
  if (script.includes(SITE_WORKER_SCRIPT)) return false;
  // Named OTTO/SearchAtlas/pixel worker.
  if (OTTO_SCRIPT_RX.test(script)) return true;
  // A broad catch-all bound to any other (foreign) worker is the OTTO signature
  // — this is what intercepted apex traffic and 429'd it.
  if (CATCH_ALL_RX.test(pattern) && script) return true;
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.CF_API_TOKEN;

  if (!token) {
    // Non-blocking: a missing token must not turn the gate red. Emit a warning
    // and exit clean so a misconfigured RC doesn't masquerade as "OTTO is back".
    console.error('⚠️  CF_API_TOKEN not set — skipping OTTO route check (non-blocking).');
    process.exit(0);
  }

  let zoneId;
  try {
    zoneId = await resolveZoneId(token, ZONE_NAME, process.env.CF_ZONE_ID);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  let routes;
  try {
    routes = await cfGet(token, `/zones/${zoneId}/workers/routes`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const all = Array.isArray(routes) ? routes : [];
  const otto = all.filter(isOttoRoute);

  if (opts.json) {
    console.log(JSON.stringify({ zone: ZONE_NAME, zoneId, total: all.length, otto }, null, 2));
  } else {
    console.log(`Cloudflare zone ${ZONE_NAME} (${zoneId}): ${all.length} Worker route(s).`);
    for (const r of all) {
      const flag = isOttoRoute(r) ? '🚨 OTTO' : 'ok';
      console.log(`  [${flag}] ${r.pattern}  →  ${r.script || '(no script)'}  (id=${r.id})`);
    }
  }

  if (otto.length) {
    console.error(
      `\n🚨 ${otto.length} OTTO/SearchAtlas route(s) detected on ${ZONE_NAME}. ` +
        `These intercept apex traffic and historically 429'd/504'd real users (#2138). ` +
        `Delete them via the CF API and disconnect the SearchAtlas integration (owner, dashboard).`,
    );
    process.exit(3);
  }

  console.log('\n✅ No OTTO/SearchAtlas Worker routes present.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`❌ Unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
