#!/usr/bin/env node
/**
 * cf-locale-failover-setup.mjs — idempotent Cloudflare cache config for the
 * apex zone. Run after EVERY `wrangler deploy` of the locale-router Worker
 * (deploy-worker.yml wires it in; manual deploys: run it yourself — see
 * LOCALE-SHARD-CLOUDFLARE-RUNBOOK §2.4). Safe to re-run any time; idempotent.
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
 * 2. CACHE RULES — the managed entries in MANAGED_CACHE_RULES (each keyed by
 *    its `description` marker; foreign rules on the same entrypoint preserved):
 *    a) locale-shard-failover-cache — makes the apex /en|/de|/fr paths
 *       ELIGIBLE for cache so the apex-keyed entries the Worker writes via
 *       cache.put() are reachable on the fail-open path. 3xx-5xx → TTL 0 so a
 *       transient fail-open 404 never outlives the cap window.
 *    b) it-apex-html-cache — caches the IT/apex HTML (the ~95% Worker-
 *       passthrough bulk, previously cf-cache-status=DYNAMIC i.e. uncached).
 *       Query-string requests bypass (no cache pollution); 3xx-5xx → TTL 0.
 *    Both override Edge TTL to 24h; the deploy-time purge (scripts/
 *    cf-purge-cache.mjs, wired in post-deploy-validate-live.yml) clears the
 *    edge once a new build is confirmed live, so the long TTL never serves
 *    stale content across deploys.
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
const CACHE_PHASE = 'http_request_cache_settings';

// Shared cache settings for both managed rules: make matching requests
// eligible for the edge cache with a 24h Edge TTL (override_origin — the
// origin sends max-age=600, which would otherwise cap edge entries; the
// deploy-time purge in scripts/cf-purge-cache.mjs keeps them fresh). 3xx-5xx
// responses get TTL 0 so a transient redirect/404 never outlives a build.
// Browser TTL respects the origin so clients still revalidate per max-age.
const CACHE_ACTION_PARAMETERS = {
  cache: true,
  edge_ttl: {
    mode: 'override_origin',
    default: 86400, // 24h — matches cache.put() s-maxage; 7200 (2h) capped entries prematurely (EXPIRED observed 2026-06-11, Adversarial check A confirmed)
    status_code_ttl: [{ status_code_range: { from: 300, to: 599 }, value: 0 }], // 0 = no-cache for 3xx-5xx apex origin miss
  },
  browser_ttl: { mode: 'respect_origin' },
};

// Every cache rule this script owns, keyed by description (the idempotency
// marker — foreign rules sharing the entrypoint are preserved untouched).
const MANAGED_CACHE_RULES = [
  {
    // Locale-shard over-cap failover: extensionless HTML is not edge-cache
    // looked-up by default, so without this the apex-keyed entries the Worker
    // writes via cache.put() are unreachable on the fail-open path.
    description: 'locale-shard-failover-cache (managed by scripts/cf-locale-failover-setup.mjs)',
    expression:
      '(http.host eq "frontaliereticino.ch" and ' +
      '(starts_with(http.request.uri.path, "/en/") or ' +
      'starts_with(http.request.uri.path, "/de/") or ' +
      'starts_with(http.request.uri.path, "/fr/") or ' +
      'http.request.uri.path in {"/en" "/de" "/fr" "/en.html" "/de.html" "/fr.html"}))',
    action_parameters: CACHE_ACTION_PARAMETERS,
  },
  {
    // IT/apex HTML edge cache: the IT bulk (~95% traffic) is Worker-passthrough
    // and was served cf-cache-status=DYNAMIC (every hit reached GitHub Pages).
    // Cache GET page requests with NO query string (so ?q= search / ?debug=
    // variations bypass and never pollute the cache), excluding the locale
    // shards (handled above), /api/, and the shard root paths. Bundled JS/CSS
    // live on the gray-cloud cdn.* host (Fastly) and never reach this zone, so
    // no asset-extension exclusion is needed here.
    description: 'it-apex-html-cache (managed by scripts/cf-locale-failover-setup.mjs)',
    expression:
      '(http.host eq "frontaliereticino.ch" and http.request.method eq "GET" ' +
      'and http.request.uri.query eq "" ' +
      'and not starts_with(http.request.uri.path, "/en/") ' +
      'and not starts_with(http.request.uri.path, "/de/") ' +
      'and not starts_with(http.request.uri.path, "/fr/") ' +
      'and not starts_with(http.request.uri.path, "/api/") ' +
      'and not http.request.uri.path in {"/en" "/de" "/fr" "/en.html" "/de.html" "/fr.html"})',
    action_parameters: CACHE_ACTION_PARAMETERS,
  },
];

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
function ruleInShape(current, desired) {
  if (!current || current.enabled === false) return false;
  if (current.expression !== desired.expression) return false;
  const p = current.action_parameters || {};
  const want = desired.action_parameters;
  if (p.cache !== want.cache) return false;
  const e = p.edge_ttl || {};
  if (e.mode !== want.edge_ttl.mode || e.default !== want.edge_ttl.default) return false;
  const wantStatus = want.edge_ttl.status_code_ttl[0];
  const gotStatus = (e.status_code_ttl || []).find(
    (s) =>
      s.status_code_range &&
      s.status_code_range.from === wantStatus.status_code_range.from &&
      s.status_code_range.to === wantStatus.status_code_range.to,
  );
  if (!gotStatus || gotStatus.value !== wantStatus.value) return false;
  if ((p.browser_ttl || {}).mode !== want.browser_ttl.mode) return false;
  return true;
}

async function assertCacheRules(zoneId) {
  // The entrypoint ruleset may not exist yet on a zone with no cache rules —
  // GET then answers 404; PUT below creates it.
  const { status, json } = await cf('GET', `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`);
  if (status !== 404 && !json?.success) bail(`Cannot read ${CACHE_PHASE} entrypoint: ${JSON.stringify(json?.errors)}`);
  const existing = status === 404 ? [] : (json.result.rules || []);

  // Build the desired rule list IN PLACE: every foreign rule preserved at its
  // position, each managed rule updated where present or appended otherwise.
  // Strip read-only per-rule fields (id, ref, version, last_updated) — the PUT
  // replaces the rule list wholesale and rejects unknown/read-only keys.
  const rules = existing.map(({ id, ref, version, last_updated, ...rest }) => rest);
  let drift = 0;
  for (const spec of MANAGED_CACHE_RULES) {
    const desired = {
      description: spec.description,
      expression: spec.expression,
      action: 'set_cache_settings',
      action_parameters: spec.action_parameters,
      enabled: true,
    };
    const idx = rules.findIndex((r) => r.description === spec.description);
    const current = idx >= 0 ? existing[idx] : null;
    if (ruleInShape(current, desired)) {
      console.log(`cache rule "${spec.description.split(' ')[0]}": already in shape`);
      continue;
    }
    drift++;
    console.log(
      `cache rule "${spec.description.split(' ')[0]}": ${current ? 'drift — updating' : 'missing — creating'}${DRY_RUN ? ' (dry-run)' : ''}`,
    );
    if (idx >= 0) rules[idx] = desired;
    else rules.push(desired);
  }

  if (drift === 0) {
    console.log('cache rules: all in shape');
    return;
  }
  if (DRY_RUN) return;

  const { json: put } = await cf('PUT', `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`, {
    rules,
  });
  if (!put?.success) bail(`PUT ${CACHE_PHASE} entrypoint failed: ${JSON.stringify(put?.errors)}`);
  console.log('cache rules: applied');
}

const zoneId = await resolveZoneId();
if (DO_ROUTES) await assertFailOpenRoutes(zoneId);
if (DO_RULE) await assertCacheRules(zoneId);
console.log(DRY_RUN ? 'dry-run complete' : 'failover config converged');
