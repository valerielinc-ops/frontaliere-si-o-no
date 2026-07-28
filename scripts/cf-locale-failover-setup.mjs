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
 *    a) and b) override Edge TTL to 24h; the deploy-time purge (scripts/
 *    cf-purge-cache.mjs, wired in post-deploy-validate-live.yml) clears the
 *    edge once a new build is confirmed live, so the long TTL never serves
 *    stale content across deploys.
 *    c) cdn-r2-passthrough-cache — makes cdn.frontaliereticino.ch (R2 custom
 *       domain, CDN_TARGET=r2) ELIGIBLE for cache, RESPECTING the origin's own
 *       Cache-Control (no override, no purge mechanism needed — R2 objects
 *       already carry correct explicit per-prefix Cache-Control from
 *       deploy-it-pages-prep.sh's _r2_sync). Root cause of the recurring
 *       "CF 5xx: cdn.*" issue class (#4332, #4668): this host had NO cache
 *       rule at all, so cf-cache-status was DYNAMIC on every path — every
 *       request round-tripped to R2 origin with zero edge buffering, so any
 *       transient R2 hiccup surfaced immediately as a live 5xx. Excludes
 *       /cdn-build-id.txt (kept no-store — the #2569 cross-shard publish
 *       gate polls it and must always see the live origin value).
 *
 * 3. FIREWALL RULES — the managed entries in MANAGED_FIREWALL_RULES (keyed by
 *    `description`; foreign rules on the entrypoint preserved). Three today:
 *    a) locale-bot-throttle-noindex-scrapers — blocks non-search/non-AI
 *       scraper bots (BLOCKED_CRAWLER_UAS) ZONE-WIDE (2026-07-20: widened from
 *       /en|/de|/fr only — the ticino/svizzera/zurigo IT-prefix sections are
 *       now also Worker-routed and were an open gap; zone-wide means future
 *       new sections never reopen it). Kept on value grounds: these bring no
 *       SEO traffic, no clicks, no monetizable traffic. (It also keeps Worker
 *       invocations down — the WAF runs BEFORE the Worker — a bonus, not the
 *       reason.) Real search + AI-search crawlers are deliberately NOT
 *       matched (#1867). TRUSTED_CRAWLER_IP_RANGES (2026-07-22) carves an
 *       IP-verified exception out of this block — currently Semrush's own
 *       Site Audit crawler range, unblocked by source IP (not by UA removal,
 *       which a spoofed UA from elsewhere would still bypass this block for).
 *    b) unidentified-scripted-traffic-challenge — `managed_challenge` (NOT a
 *       hard block — too uncertain to block outright) for requests with an
 *       empty User-Agent or the literal UA "node": live traffic analysis
 *       2026-07-20 found these are ~42% of Worker invocations on the routed
 *       sections, never a real browser (which always sends a UA) and never a
 *       named crawler (every welcomed crawler below self-identifies).
 *    c) the owner's "Allowlist verified SEO + AI crawlers" skip-all-security
 *       rule — adopted under management 2026-07-20 (was a "foreign" rule) to
 *       remove Amazonbot/Bytespider from it: that rule exempted them from
 *       ALL security (rateLimit/WAF/UA-block) outside the block rule's old
 *       narrow scope, directly contradicting (a)'s policy. VERIFIED_CRAWLER_UAS
 *       is exactly the intended-welcome list; OWNER_IP is never
 *       challenged/rate-limited.
 *    Rules (a) and (b) are PREPENDED ahead of (c) so a bad/ambiguous UA is
 *    blocked or challenged before the skip can short-circuit it (same
 *    reasoning as the original comment below).
 *
 * 4. REDIRECT RULES — the managed entries in MANAGED_REDIRECT_RULES (keyed by
 *    `description`; foreign rules on the entrypoint — e.g. the image→CDN
 *    apex-404 recovery — preserved). Currently one: trailing-slash-301 —
 *    301s every extensionless no-trailing-slash apex path to its slash form
 *    (#3472). Every canonical URL on the site is slash-terminated
 *    (buildPath()/sitemap/hreflang), but GitHub Pages' extensionless
 *    resolution serves the flat `<path>.html` noindex bridge
 *    (flatHtmlRedirectPlugin) with HTTP 200 at the no-slash URL instead of
 *    301ing — a crawl-budget-wasting 200 duplicate on every deep page. The
 *    dynamic-redirect phase runs BEFORE the cache and BEFORE Workers routes,
 *    so the 301 also short-circuits Worker invocations and stale edge-cached
 *    200s for no-slash variants. Excluded: paths with a "." (real files:
 *    .xml/.txt/.html/…), /cdn-cgi/* (Cloudflare-internal endpoints — the Web
 *    Analytics beacon POSTs to /cdn-cgi/rum; a 301 is not followed by beacon
 *    senders, which silently killed RUM ingest, #3503) and /disiscrivi-*
 *    (RFC 8058 one-click unsubscribe — a 301 would not be re-issued as a
 *    POST by mail clients).
 *
 * Auth: CF_API_TOKEN — needs Zone→Workers Routes:Edit (already required by
 * deploy-worker.yml) + Zone→Zone Settings/Cache Rules:Edit + Zone→Firewall
 * Services:Edit (WAF custom rules) + Zone→Dynamic URL Redirects:Edit + zone
 * read.
 * Locally:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs)" && node scripts/cf-locale-failover-setup.mjs
 *
 * Flags: --dry-run (report drift, change nothing) · --routes-only · --rule-only
 *        (cache+firewall+redirect) · --cache-only · --firewall-only ·
 *        --redirect-only
 * Exit: 0 = converged (or already in shape), 1 = API/auth error.
 *
 * Zone-id resolution delegates to scripts/lib/cf-analytics.mjs's resolveZoneId
 * (AGENTS.md #6 — no inline copy of that fetch+parse construct); this file's
 * own resolveZoneId() wrapper only translates a failure into this script's
 * bail() convention.
 */

import { stableStringify } from './lib/stable-stringify.mjs';
import { resolveZoneId as resolveZoneIdShared } from './lib/cf-analytics.mjs';

const REST_BASE = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = process.env.CF_ZONE_NAME || 'frontaliereticino.ch';
const WORKER_SCRIPT = 'frontaliere-locale-router';
const CACHE_PHASE = 'http_request_cache_settings';
const FIREWALL_PHASE = 'http_request_firewall_custom';
const REDIRECT_PHASE = 'http_request_dynamic_redirect';

// Non-visibility crawlers blocked ZONE-WIDE (2026-07-20: widened from the
// original /en|/de|/fr-only scope — the ticino/svizzera/zurigo IT-prefix
// sections are now also Worker-routed via their own wrangler.toml routes, and
// scoping this rule to specific path prefixes meant every new section reopened
// the gap; host-only scope closes it for good). These bring no SEO traffic, no
// clicks, and no monetizable traffic for this audience (owner value policy), so
// they stay blocked. The WAF runs BEFORE the Worker, so blocking a request here
// also means it never invokes the Worker — a cost bonus, not the reason.
//
// Amazonbot + Bytespider were the original two (owner-approved carve-out from
// the verified-crawler allowlist below). Added 2026-07-20 after live traffic
// analysis (CF GraphQL httpRequestsAdaptiveGroups, 2026-07-19 sample) surfaced
// Amzn-SearchBot (a distinct Amazon UA the old "Amazonbot" substring match
// never covered, ~3.4% of routed-path traffic that day) plus the other
// no-SEO-value scrapers already named in owner policy
// ([[project_workers_paid_bot_value_policy_jun15]]) that had no WAF block at
// all — robots.txt Disallow is best-effort and many ignore it. Every real
// visibility crawler (Googlebot, Bingbot, AdSense, GPTBot, ClaudeBot,
// PerplexityBot, Google-Extended, Applebot, DuckDuckBot, Yandex, cohere, …) is
// deliberately NOT in this list — see VERIFIED_CRAWLER_UAS below.
//
// CRITICAL — this rule is PREPENDED (see assertFirewallRules) so it runs BEFORE
// the allowlist skip rule below. action = block (not managed_challenge: that
// lets CF-verified bots pass). Fully reversible: remove the rule or prune a UA.
const BLOCKED_CRAWLER_UAS = [
  'Amazonbot',
  'Amzn-SearchBot',
  'Bytespider',
  'AhrefsBot',
  'SemrushBot',
  'MJ12bot',
  'DotBot',
  'BLEXBot',
  'DataForSeoBot',
  'SerpstatBot',
];

// Ambiguous non-self-identifying automated traffic: `managed_challenge`, not a
// hard block (uncertain enough that an outright block risks a real visitor
// behind an odd client). Live traffic analysis (2026-07-19 sample, routed
// sections) found empty User-Agent = 34.2% and literal UA "node" = 7.5% of
// Worker invocations — never a real browser (always sends a UA) and never a
// named crawler (every welcomed one below self-identifies). Challenging (JS
// proof-of-work) filters non-interactive scripted clients while letting any
// genuine human through.
const CHALLENGED_UAS = ['', 'node'];

// IP-verified exception to the block above (owner request, 2026-07-22):
// Semrush's own Site Audit tool (`SemrushBot-SI` UA) was getting 403'd by the
// 2026-07-20 zone-wide block — an over-widening side effect, not the original
// intent. Carved out by SOURCE IP (owner-supplied range), not by removing
// "SemrushBot" from BLOCKED_CRAWLER_UAS, because a UA string is trivially
// spoofed: this way a "SemrushBot" UA from any OTHER IP still gets blocked,
// only requests actually originating from Semrush's published crawler range
// pass. Excluded from the block expression AND added to the allowlist skip
// below so other zone security (WAF managed rules, Bot Fight Mode) doesn't
// re-block it downstream of the custom ruleset.
const TRUSTED_CRAWLER_IP_RANGES = ['85.208.98.128/25'];

// The crawlers this site deliberately welcomes — organic-search + AI-search
// visibility channels. Mirrors the owner's original allowlist rule (adopted
// under management 2026-07-20; was a "foreign" rule with Amazonbot/Bytespider
// INSIDE it, which exempted them from ALL security outside this rule's old
// narrow /en|/de|/fr scope — contradicted the block above). Never
// challenged/rate-limited, on top of the owner's own IP.
const VERIFIED_CRAWLER_UAS = [
  'Googlebot',
  'Bingbot',
  'Mediapartners-Google',
  'AdsBot-Google',
  'DuckDuckBot',
  'Applebot',
  'YandexBot',
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-Web',
  'Claude-User',
  'Claude-SearchBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'cohere-ai',
  'Meta-ExternalAgent',
  'FacebookBot',
];
const OWNER_IP = '178.197.238.144';

const MANAGED_FIREWALL_RULES = [
  {
    description: 'locale-bot-throttle-noindex-scrapers (managed by scripts/cf-locale-failover-setup.mjs)',
    action: 'block',
    expression:
      '(http.host eq "frontaliereticino.ch" and not (ip.src in {' +
      TRUSTED_CRAWLER_IP_RANGES.join(' ') +
      '}) and (' +
      BLOCKED_CRAWLER_UAS.map((ua) => `http.user_agent contains "${ua}"`).join(' or ') +
      '))',
  },
  {
    description: 'unidentified-scripted-traffic-challenge (managed by scripts/cf-locale-failover-setup.mjs)',
    action: 'managed_challenge',
    expression:
      '(http.host eq "frontaliereticino.ch" and (' +
      CHALLENGED_UAS.map((ua) => `http.user_agent eq "${ua}"`).join(' or ') +
      '))',
  },
  {
    // Description MUST stay byte-identical to the owner's original rule so
    // this entry is recognized as an update-in-place, not a duplicate.
    description:
      'Allowlist verified SEO + AI crawlers — skip ALL security so crawlers are never challenged + our IP (never challenge/rate-limit us)',
    action: 'skip',
    expression:
      `(ip.src eq ${OWNER_IP}) or (ip.src in {${TRUSTED_CRAWLER_IP_RANGES.join(' ')}}) or ((` +
      VERIFIED_CRAWLER_UAS.map((ua) => `http.user_agent contains "${ua}"`).join(') or (') +
      ') or (cf.client.bot))',
    action_parameters: {
      products: ['bic', 'hot', 'rateLimit', 'securityLevel', 'uaBlock', 'waf', 'zoneLockdown'],
      ruleset: 'current',
    },
  },
];

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

// cdn.frontaliereticino.ch (R2) cache settings: RESPECT origin instead of
// overriding it — unlike the apex HTML above, R2 objects already carry
// correct explicit per-prefix Cache-Control (assets/og/images/data/job-canon,
// see deploy-it-pages-prep.sh _r2_sync) and there is no purge-on-deploy
// mechanism for R2 keys, so a fixed override would risk serving a stale
// asset past a deploy. respect_origin also means a response with no positive
// Cache-Control (e.g. /cdn-build-id.txt's `no-store`, or an R2 404) is never
// cached, without needing per-status overrides here.
const CDN_CACHE_ACTION_PARAMETERS = {
  cache: true,
  edge_ttl: { mode: 'respect_origin' },
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
    // shards (handled above), /api/, and the shard root paths. This rule is
    // host-scoped to the apex, so it never matches cdn.* — no asset-extension
    // exclusion is needed here (see cdn-r2-passthrough-cache below, which
    // owns cdn.frontaliereticino.ch).
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
  {
    // R2-origin CDN passthrough cache — see header doc (c) for full rationale.
    // Excludes /cdn-build-id.txt: the #2569 cross-shard publish-ordering gate
    // (scripts/lib/wait-cdn-build-id.sh) polls this exact URL and must always
    // observe the live origin value, never a cached one.
    description: 'cdn-r2-passthrough-cache (managed by scripts/cf-locale-failover-setup.mjs)',
    expression:
      '(http.host eq "cdn.frontaliereticino.ch" and ' +
      'http.request.uri.path ne "/cdn-build-id.txt")',
    action_parameters: CDN_CACHE_ACTION_PARAMETERS,
  },
];

// Trailing-slash 301 normalization (#3472). Site convention: every canonical
// URL ends with "/" (buildPath() in services/router.ts forces it; canonical/
// sitemap/hreflang all emit slash-terminated URLs). But GitHub Pages resolves
// the extensionless no-slash URL (/fisco, /en/tax, …) to the flat `<path>.html`
// noindex bridge emitted by build-plugins/flatHtmlRedirectPlugin.ts and serves
// it with HTTP 200 — a crawl-budget-wasting duplicate on every deep page,
// drifting from the documented no-slash→slash 301 behavior. This zone-level
// dynamic redirect closes the gap for BOTH the IT apex (never Worker-routed)
// and the Worker-routed locale/Ticino paths: the http_request_dynamic_redirect
// phase runs BEFORE the edge cache and BEFORE Workers routes, so no-slash hits
// 301 at the edge without invoking the Worker or hitting a stale cached 200.
//
// Exclusions (keep in sync with the header doc §4):
//   - `contains "."` — real files (/sitemap.xml, /robots.txt, /ads.txt,
//     /en.html, /404.html, …) and the flat-bridge URLs themselves must keep
//     serving as-is. No site page path contains a dot.
//   - /disiscrivi-* — the RFC 8058 one-click unsubscribe proxies accept POST;
//     a 301 would not be re-issued as a POST by mail clients (see
//     infra/cloudflare-worker/locale-router.js UNSUB_PROXIES).
//   - host guard — only the apex; origin-*/cdn.* subdomains are gray-cloud
//     (never traverse this zone's rules) but the guard keeps it explicit.
// Root "/" and every canonical URL already end with "/" → never match, so a
// redirect loop is impossible by construction. Query strings are preserved
// (preserve_query_string) and fragments survive 301s client-side. Flat-only
// pages with no directory sibling (e.g. /404) are non-canonical URLs never
// emitted by the site; their no-slash form 301ing to a 404 is acceptable and
// strictly more honest than the previous duplicate 200.
const MANAGED_REDIRECT_RULES = [
  {
    description: 'trailing-slash-301 (managed by scripts/cf-locale-failover-setup.mjs)',
    expression:
      '(http.host eq "frontaliereticino.ch" ' +
      'and not ends_with(http.request.uri.path, "/") ' +
      'and not http.request.uri.path contains "." ' +
      'and not starts_with(http.request.uri.path, "/cdn-cgi/") ' +
      'and not starts_with(http.request.uri.path, "/disiscrivi-"))',
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: {
          expression: 'concat("https://", http.host, http.request.uri.path, "/")',
        },
        preserve_query_string: true,
      },
    },
  },
];

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
// Section gating. --routes-only / --rule-only kept for back-compat (--rule-only
// = every zone ruleset — cache + firewall + redirect — skip routes).
// --cache-only / --firewall-only / --redirect-only isolate a single ruleset so
// a targeted live apply never touches a sibling's drift.
const ONLY =
  (args.has('--routes-only') && 'routes') ||
  (args.has('--cache-only') && 'cache') ||
  (args.has('--firewall-only') && 'firewall') ||
  (args.has('--redirect-only') && 'redirect') ||
  (args.has('--rule-only') && 'rule') ||
  null;
const DO_ROUTES = ONLY === null || ONLY === 'routes';
const DO_CACHE = ONLY === null || ONLY === 'rule' || ONLY === 'cache';
const DO_FIREWALL = ONLY === null || ONLY === 'rule' || ONLY === 'firewall';
const DO_REDIRECT = ONLY === null || ONLY === 'rule' || ONLY === 'redirect';

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
  try {
    return await resolveZoneIdShared(token, ZONE_NAME, process.env.CF_ZONE_ID);
  } catch {
    bail(`Cannot resolve zone id for ${ZONE_NAME} (token scope?).`);
  }
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
  if (e.mode !== want.edge_ttl.mode) return false;
  // override_origin rules (apex HTML) carry a fixed default + per-status-code
  // overrides; respect_origin rules (cdn-r2-passthrough-cache) carry neither
  // — there is nothing to override, the edge just mirrors origin headers.
  if (want.edge_ttl.mode === 'override_origin') {
    if (e.default !== want.edge_ttl.default) return false;
    const wantStatus = want.edge_ttl.status_code_ttl[0];
    const gotStatus = (e.status_code_ttl || []).find(
      (s) =>
        s.status_code_range &&
        s.status_code_range.from === wantStatus.status_code_range.from &&
        s.status_code_range.to === wantStatus.status_code_range.to,
    );
    if (!gotStatus || gotStatus.value !== wantStatus.value) return false;
  }
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

function fwShape(r) {
  // Canonical comparable form for a firewall rule — only OUR contract fields,
  // in order (CF re-emits normalized/extra fields we ignore). stableStringify
  // (imported above) avoids ever raw-JSON-comparing an API-echoed
  // action_parameters object — same footgun as the cache-rule comparison
  // above (unsorted key re-emission would cause perpetual false drift).
  return `${r.action} ${r.enabled === false ? '0' : '1'} ${r.expression} ${r.description || ''} ${stableStringify(r.action_parameters || null)}`;
}

async function assertFirewallRules(zoneId) {
  // The custom-firewall entrypoint may not exist on a zone with no custom rules
  // — GET then answers 404; the PUT below creates it.
  const { status, json } = await cf('GET', `/zones/${zoneId}/rulesets/phases/${FIREWALL_PHASE}/entrypoint`);
  if (status !== 404 && !json?.success) bail(`Cannot read ${FIREWALL_PHASE} entrypoint: ${JSON.stringify(json?.errors)}`);
  const existing = status === 404 ? [] : (json.result.rules || []);
  const stripped = existing.map(({ id, ref, version, last_updated, ...rest }) => rest);

  const managedDescriptions = new Set(MANAGED_FIREWALL_RULES.map((s) => s.description));
  const desiredManaged = MANAGED_FIREWALL_RULES.map((spec) => ({
    description: spec.description,
    expression: spec.expression,
    action: spec.action,
    enabled: true,
    ...(spec.action_parameters ? { action_parameters: spec.action_parameters } : {}),
  }));
  // Foreign rules (e.g. the Ghana mitigation) are preserved verbatim, in their
  // existing order. OUR rules are PREPENDED, in MANAGED_FIREWALL_RULES array
  // order: block, then challenge, then the (now-managed) verified-crawler
  // allowlist skip — both the block and challenge rules MUST run before the
  // skip, else it short-circuits a bad/ambiguous UA before our rule fires.
  // Order-sensitive — that's why we compare the full list, not per-rule.
  const foreign = stripped.filter((r) => !managedDescriptions.has(r.description));
  const desired = [...desiredManaged, ...foreign];

  const same =
    desired.length === stripped.length &&
    desired.every((r, i) => fwShape(r) === fwShape(stripped[i]));
  if (same) {
    console.log('firewall rules: all in shape (managed rules prepended)');
    return;
  }
  console.log(
    `firewall rules: drift — applying ${desiredManaged.length} managed rule(s) ahead of ${foreign.length} foreign rule(s)${DRY_RUN ? ' (dry-run)' : ''}`,
  );
  if (DRY_RUN) return;

  const { json: put } = await cf('PUT', `/zones/${zoneId}/rulesets/phases/${FIREWALL_PHASE}/entrypoint`, {
    rules: desired,
  });
  if (!put?.success) bail(`PUT ${FIREWALL_PHASE} entrypoint failed: ${JSON.stringify(put?.errors)}`);
  console.log('firewall rules: applied');
}

// Field-by-field canonical check for a managed dynamic-redirect rule — same
// rationale as ruleInShape above (CF re-emits normalized/extra fields; a
// stringify comparison would never converge). Only OUR contract is checked.
function redirectRuleInShape(current, desired) {
  if (!current || current.enabled === false) return false;
  if (current.action !== 'redirect') return false;
  if (current.expression !== desired.expression) return false;
  const from = (current.action_parameters || {}).from_value || {};
  const want = desired.action_parameters.from_value;
  if (from.status_code !== want.status_code) return false;
  if ((from.target_url || {}).expression !== want.target_url.expression) return false;
  if (from.preserve_query_string !== want.preserve_query_string) return false;
  return true;
}

async function assertRedirectRules(zoneId) {
  // The entrypoint ruleset may not exist yet on a zone with no redirect rules —
  // GET then answers 404; PUT below creates it.
  const { status, json } = await cf('GET', `/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`);
  if (status !== 404 && !json?.success) bail(`Cannot read ${REDIRECT_PHASE} entrypoint: ${JSON.stringify(json?.errors)}`);
  const existing = status === 404 ? [] : (json.result.rules || []);

  // Same read-modify-write shape as assertCacheRules: every foreign rule (e.g.
  // the image→CDN apex-404 recovery) preserved at its position, each managed
  // rule updated in place or APPENDED (first matching redirect rule wins, so
  // appending keeps existing recoveries' priority; the expressions are disjoint
  // anyway — image paths carry file extensions, excluded by `contains "."`).
  const rules = existing.map(({ id, ref, version, last_updated, ...rest }) => rest);
  let drift = 0;
  for (const spec of MANAGED_REDIRECT_RULES) {
    const desired = {
      description: spec.description,
      expression: spec.expression,
      action: 'redirect',
      action_parameters: spec.action_parameters,
      enabled: true,
    };
    const idx = rules.findIndex((r) => r.description === spec.description);
    const current = idx >= 0 ? existing[idx] : null;
    if (redirectRuleInShape(current, desired)) {
      console.log(`redirect rule "${spec.description.split(' ')[0]}": already in shape`);
      continue;
    }
    drift++;
    console.log(
      `redirect rule "${spec.description.split(' ')[0]}": ${current ? 'drift — updating' : 'missing — creating'}${DRY_RUN ? ' (dry-run)' : ''}`,
    );
    if (idx >= 0) rules[idx] = desired;
    else rules.push(desired);
  }

  if (drift === 0) {
    console.log('redirect rules: all in shape');
    return;
  }
  if (DRY_RUN) return;

  const { json: put } = await cf('PUT', `/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, {
    rules,
  });
  if (!put?.success) bail(`PUT ${REDIRECT_PHASE} entrypoint failed: ${JSON.stringify(put?.errors)}`);
  console.log('redirect rules: applied');
}

const zoneId = await resolveZoneId();
if (DO_ROUTES) await assertFailOpenRoutes(zoneId);
if (DO_CACHE) await assertCacheRules(zoneId);
if (DO_FIREWALL) await assertFirewallRules(zoneId);
if (DO_REDIRECT) await assertRedirectRules(zoneId);
console.log(DRY_RUN ? 'dry-run complete' : 'failover config converged');
