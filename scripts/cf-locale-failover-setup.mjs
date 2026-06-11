#!/usr/bin/env node
/**
 * cf-locale-failover-setup.mjs — idempotent Cloudflare config for the
 * locale-router over-cap failover. Run after EVERY `wrangler deploy` of the
 * Worker (deploy-worker.yml wires it in; manual deploys: run it yourself —
 * see LOCALE-SHARD-CLOUDFLARE-RUNBOOK §2.4).
 *
 * What it asserts (and why it must re-run post-deploy):
 *
 * 1. ROUTES — `request_limit_fail_open: true` on every route bound to the
 *    `frontaliere-locale-router` script. Over the free 100k invocations/day
 *    cap, fail-open BYPASSES the Worker (the request flows through the normal
 *    CDN pipeline: WAF → cache → DNS origin) instead of answering Cloudflare
 *    error 1027 on every /en /de /fr request (the fail-closed default).
 *    `wrangler deploy` re-syncs routes from wrangler.toml, which cannot
 *    express this flag — so a deploy can silently reset it to fail closed.
 *
 * 2. CACHE RULE — zone rule (marker: RULE_DESCRIPTION) that makes the apex
 *    locale paths ELIGIBLE for cache. Extensionless HTML is not looked up in
 *    the edge cache by default, so without this rule the apex-keyed entries
 *    the Worker writes via cache.put() are unreachable exactly on the
 *    fail-open path they exist for. Write-side TTLs on this rule only matter
 *    for fail-open MISSes that reach the main GitHub Pages origin (which has
 *    no /en|/de|/fr content since the locale sharding): 3xx-5xx → value 0
 *    (no-cache) so a transient fail-open 404 never outlives the cap window.
 *    Scoped to http.host == apex so the Worker's own subrequests to the
 *    origin-{loc} shard hosts (already cached via cf.cacheEverything) are
 *    untouched.
 *
 * Auth: CF_API_TOKEN — needs Zone→Workers Routes:Edit (already required by
 * deploy-worker.yml) + Zone→Zone Settings/Cache Rules:Edit + zone read.
 * Locally:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs)" && node scripts/cf-locale-failover-setup.mjs
 *
 * Flags: --dry-run (report drift, change nothing) · --routes-only · --rule-only
 * Exit: 0 = converged (or already in shape), 1 = API/auth error.
 */

const REST_BASE = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = process.env.CF_ZONE_NAME || 'frontaliereticino.ch';
const WORKER_SCRIPT = 'frontaliere-locale-router';
const RULE_DESCRIPTION = 'locale-shard-failover-cache (managed by scripts/cf-locale-failover-setup.mjs)';
const CACHE_PHASE = 'http_request_cache_settings';

const RULE_EXPRESSION =
  '(http.host eq "frontaliereticino.ch" and ' +
  '(starts_with(http.request.uri.path, "/en/") or ' +
  'starts_with(http.request.uri.path, "/de/") or ' +
  'starts_with(http.request.uri.path, "/fr/") or ' +
  'http.request.uri.path in {"/en" "/de" "/fr" "/en.html" "/de.html" "/fr.html"}))';

const RULE_ACTION_PARAMETERS = {
  cache: true,
  edge_ttl: {
    mode: 'override_origin',
    default: 7200, // 2h — only reachable by fail-open 2xx from the apex origin (none today)
    status_code_ttl: [{ status_code_range: { from: 300, to: 599 }, value: 0 }], // 0 = no-cache
  },
  browser_ttl: { mode: 'respect_origin' },
};

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const DO_ROUTES = !args.has('--rule-only');
const DO_RULE = !args.has('--routes-only');

function bail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const token = process.env.CF_API_TOKEN;
if (!token) bail('CF_API_TOKEN not set (hydrate via scripts/load-rc-env.mjs).');

async function cf(method, path, body) {
  const res = await fetch(`${REST_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function resolveZoneId() {
  if (process.env.CF_ZONE_ID) return process.env.CF_ZONE_ID;
  const { json } = await cf('GET', `/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!json?.success || !json.result?.length) bail(`Cannot resolve zone id for ${ZONE_NAME} (token scope?).`);
  return json.result[0].id;
}

async function assertFailOpenRoutes(zoneId) {
  const { json } = await cf('GET', `/zones/${zoneId}/workers/routes`);
  if (!json?.success) bail(`Cannot list worker routes: ${JSON.stringify(json?.errors)}`);
  const routes = json.result.filter((r) => r.script === WORKER_SCRIPT);
  if (!routes.length) bail(`No routes found for script ${WORKER_SCRIPT} — deploy the Worker first.`);

  let flipped = 0;
  for (const r of routes) {
    if (r.request_limit_fail_open === true) continue;
    console.log(`route ${r.pattern}: fail_open=false → true${DRY_RUN ? ' (dry-run)' : ''}`);
    if (DRY_RUN) { flipped++; continue; }
    const { json: put } = await cf('PUT', `/zones/${zoneId}/workers/routes/${r.id}`, {
      pattern: r.pattern,
      script: r.script,
      request_limit_fail_open: true,
    });
    if (!put?.success) bail(`PUT route ${r.pattern} failed: ${JSON.stringify(put?.errors)}`);
    flipped++;
  }
  console.log(`routes: ${routes.length} on ${WORKER_SCRIPT}, ${flipped} flipped to fail-open, ${routes.length - flipped} already ok`);
}

// Field-by-field canonical check instead of a JSON.stringify equality:
// Cloudflare re-emits action_parameters with normalized key order and
// API-added defaults, so a stringify comparison would flag drift on every
// run and re-PUT the entrypoint forever (never converging to "in shape").
// Extra/unknown fields CF adds are tolerated; only OUR contract is checked.
function ruleInShape(current) {
  if (!current || current.enabled === false) return false;
  if (current.expression !== RULE_EXPRESSION) return false;
  const p = current.action_parameters || {};
  if (p.cache !== true) return false;
  const e = p.edge_ttl || {};
  if (e.mode !== 'override_origin' || e.default !== 7200) return false;
  const noCache3xx5xx = (e.status_code_ttl || []).find(
    (s) => s.status_code_range && s.status_code_range.from === 300 && s.status_code_range.to === 599,
  );
  if (!noCache3xx5xx || noCache3xx5xx.value !== 0) return false;
  if ((p.browser_ttl || {}).mode !== 'respect_origin') return false;
  return true;
}

async function assertCacheRule(zoneId) {
  // The entrypoint ruleset may not exist yet on a zone with no cache rules —
  // GET then answers 404; PUT below creates it.
  const { status, json } = await cf('GET', `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`);
  if (status !== 404 && !json?.success) bail(`Cannot read ${CACHE_PHASE} entrypoint: ${JSON.stringify(json?.errors)}`);
  const existing = status === 404 ? [] : (json.result.rules || []);

  const desired = {
    description: RULE_DESCRIPTION,
    expression: RULE_EXPRESSION,
    action: 'set_cache_settings',
    action_parameters: RULE_ACTION_PARAMETERS,
    enabled: true,
  };

  const idx = existing.findIndex((r) => r.description === RULE_DESCRIPTION);
  const current = idx >= 0 ? existing[idx] : null;

  if (ruleInShape(current)) {
    console.log('cache rule: already in shape');
    return;
  }
  console.log(`cache rule: ${current ? 'drift — updating' : 'missing — creating'}${DRY_RUN ? ' (dry-run)' : ''}`);
  if (DRY_RUN) return;

  // Preserve every foreign rule untouched; replace/append only ours. Strip
  // read-only per-rule fields (id, ref, version, last_updated) — the PUT
  // replaces the rule list wholesale and rejects unknown/read-only keys.
  const keep = existing
    .filter((_, i) => i !== idx)
    .map(({ id, ref, version, last_updated, ...rest }) => rest);
  const rules = idx >= 0 ? [...keep.slice(0, idx), desired, ...keep.slice(idx)] : [...keep, desired];

  const { json: put } = await cf('PUT', `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`, {
    rules,
  });
  if (!put?.success) bail(`PUT ${CACHE_PHASE} entrypoint failed: ${JSON.stringify(put?.errors)}`);
  console.log('cache rule: applied');
}

const zoneId = await resolveZoneId();
if (DO_ROUTES) await assertFailOpenRoutes(zoneId);
if (DO_RULE) await assertCacheRule(zoneId);
console.log(DRY_RUN ? 'dry-run complete' : 'failover config converged');
