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
 *    a) and b) override Edge TTL to APEX_EDGE_TTL_SECONDS (300s, self-
 *    invalidating — NOT purge-invalidated since 2026-08-05, #5162; the
 *    zone-wide purge_everything this comment used to describe was removed
 *    from post-deploy-validate-live.yml because it also wiped the CDN's
 *    96%-hit cache on every deploy, see the APEX_EDGE_TTL_SECONDS comment
 *    below for the measurement). A deploy therefore bounds apex staleness to
 *    5 minutes on its own; cf-purge-cache.mjs's targeted `--files=` mode is a
 *    best-effort freshness accelerator on top, not the mechanism these two
 *    rules depend on — and per scripts/lib/cf-purge-variants.mjs it only
 *    clears the header-less and `Vary: Origin` cache variants, never a
 *    `Vary: Accept-Encoding` one (#5483): a caller purging an apex URL can
 *    report ✅ without moving the copy browsers get, but the 300s TTL still
 *    catches it regardless.
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
 *       gate polls it and must always see the live origin value) AND
 *       /assets/early-boot.js — this rule is appended LAST and a later rule
 *       wins in the cache phase, so without that exclusion its `cache: true`
 *       silently overrode the `early-boot-js-bypass-cache` rule and the file
 *       served HIT instead of BYPASS (#5176).
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
 *    apex-404 recovery — preserved). Two today. First, trailing-slash-301 —
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
 *    Second, cdn-root-301 — 301s the bare CDN root to the apex. R2 has no root
 *    object, so `cdn.frontaliereticino.ch/` answered Cloudflare's stock ~28 KB
 *    R2 error page 42_919 times in 23h (315.3 MB of egress, the zone's largest
 *    non-2xx by far). Measured as external scanning, not a broken link of ours
 *    — 99.4% HTTP/1.1, unrecognised UA, bursty, one country — so the fix is to
 *    stop paying for the answer, not to chase a referrer (#5176).
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
// eligible for the edge cache (override_origin — the origin sends max-age=600,
// which would otherwise cap edge entries). 3xx-5xx responses get TTL 0 so a
// transient redirect/404 never outlives a build. Browser TTL respects the
// origin so clients still revalidate per max-age.
//
// EDGE TTL IS SELF-INVALIDATING, NOT PURGE-INVALIDATED (2026-08-05, #5162).
// This was 86400 (24h), and apex freshness after a deploy was delegated to the
// zone-wide `purge_everything` in scripts/cf-purge-cache.mjs. Measuring the
// zone showed that trade was inverted — it bought little and cost a lot:
//
//   * apex (frontaliereticino.ch) ran at 19.2% cache hit (109_543 hit vs
//     241_501 miss + 216_685 none over 23h). The 24h TTL was mostly notional.
//   * cdn.frontaliereticino.ch ran at 96.0% hit — 1_436_958 of 1_497_318 — and
//     `purge_everything` is ZONE-wide, so every deploy annihilated that cache
//     too, even though the CDN never needed it: /assets/ freshness already
//     comes from the targeted per-key purge (purge-changed-cdn-assets.mjs).
//
// The cost landed as 5xx. With a 7-day edge TTL on /assets/, steady state
// should produce almost no origin fetches; instead ~60k reached R2 in 23h,
// which only the repeated full-zone purges explain. 277 of them failed
// (0.46% of origin fetches) and surfaced as edge-synthesised 502s — issues
// #5034/#5035/#5036/#5052/#5081/#5092/#5093/#5094, and the failed dynamic
// import in #4644.
//
// A purge also DELETES the cached copy rather than expiring it, so serve_stale
// (#5158) had nothing to fall back on and measured staleRescuable = 0. Purge
// and serve_stale are mutually exclusive by construction; keeping both was the
// reason that mitigation could not work.
//
// 300s bounds post-deploy apex staleness to 5 minutes without any zone purge,
// so the CDN cache survives deploys. Do NOT raise this back toward 86400
// without restoring a freshness mechanism for the apex — and do not restore it
// by re-enabling the zone-wide purge (see CF_PURGE_ZONE_WIDE in
// scripts/cf-purge-cache.mjs). Guarded by tests/cf-zone-purge-blast-radius.test.ts.
const APEX_EDGE_TTL_SECONDS = 300;
const CACHE_ACTION_PARAMETERS = {
  cache: true,
  edge_ttl: {
    mode: 'override_origin',
    default: APEX_EDGE_TTL_SECONDS,
    status_code_ttl: [{ status_code_range: { from: 300, to: 599 }, value: 0 }], // 0 = no-cache for 3xx-5xx apex origin miss
  },
  browser_ttl: { mode: 'respect_origin' },
};

// cdn.frontaliereticino.ch (R2) cache settings: RESPECT origin instead of
// overriding it — unlike the apex HTML above, R2 objects already carry
// correct explicit per-prefix Cache-Control (assets/og/images/data/job-canon,
// see deploy-it-pages-prep.sh _r2_sync), so a fixed override would risk
// serving a stale asset past a deploy. respect_origin also means a response
// with no positive Cache-Control (e.g. /cdn-build-id.txt's `no-store`, or an
// R2 404) is never cached, without needing per-status overrides here.
//
// Because this is respect_origin, the object's Cache-Control IS the edge TTL —
// which is why /assets/ must never be uploaded `immutable` under this site's
// stable (non-content-hashed) filenames. Freshness for those keys comes from
// the targeted per-key purge deploy-it-pages-prep.sh runs right after the R2
// sync (scripts/ci/purge-changed-cdn-assets.mjs); their 7d max-age is only the
// backstop if that purge is missed.
// `serve_stale` IS set here, and the precondition the previous revision of this
// comment demanded has now been met.
//
// It is the direct mitigation for the `cloudflare-5xx` family
// (#5034/#5035/#5036/#5052/#5081/#5082/#5092/#5093/#5094 + #4644): those 502s
// carry `originResponseStatus: 0` + `cacheStatus: none` — the origin returned
// NOTHING and Cloudflare synthesised the 502 — and they cluster inside deploy
// windows, when the rclone sync (`--fast-list` + 24 parallel PUTs, see
// deploy-it-pages-prep.sh) is loading the same bucket the edge fetches through.
// Serving a stale byte-identical asset beats blanking the page for a user or
// for Googlebot.
//
// It was previously left out because the field could not be validated against
// the live zone from an agent session, and shipping an unverified schema into
// the script that OWNS these rules would risk breaking all of them on the next
// run. That gate is now cleared: an operator-approved PATCH was applied to rule
// 0c83f11bdd424cf28d7dabaf637ba525 (zone 435c32ec…, ruleset d738dd4c…) on
// 2026-08-05, the API returned `success: true`, and the rule now echoes back
// `"serve_stale": {"disable_stale_while_updating": false}` — so the schema is
// confirmed against the live zone, not assumed.
//
// This constant must keep the field: this script owns every managed cache rule
// and rewrites `action_parameters` wholesale on each run, so dropping it here
// would silently REMOVE serve_stale from the live rule at the next invocation
// and reopen the whole 5xx family.
//
// `disable_stale_while_updating: false` = stale-while-revalidate ENABLED (the
// Cloudflare field is negated). It only ever applies to an asset already in
// cache whose TTL has lapsed; a first-ever request to a dead origin still 502s,
// which is why this mitigates the family without masking a genuine outage.
const CDN_CACHE_ACTION_PARAMETERS = {
  cache: true,
  edge_ttl: { mode: 'respect_origin' },
  browser_ttl: { mode: 'respect_origin' },
  serve_stale: { disable_stale_while_updating: false },
};

// The one path whose cache bypass must never be overridden by the broad CDN
// passthrough rule below. Declared once so the rule expression and
// tests/cdn-zone-rule-invariants.test.ts cannot drift apart (AGENTS.md #6).
// Owned live by the foreign rule `early-boot-js-bypass-cache` (`cache: false`);
// see the exclusion comment in cdn-r2-passthrough-cache for why it is excluded
// here rather than fixed by reordering.
//
// NOT exported, deliberately: this module runs its work at TOP LEVEL (the
// `const zoneId = await resolveZoneId()` block at the end issues live PUTs), so
// importing it from a test would reconfigure the production zone as a side
// effect of collecting the suite. The guard test reads this file as TEXT.
const EARLY_BOOT_PATH = '/assets/early-boot.js';

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
    //
    // ALSO excludes /assets/early-boot.js, and that exclusion is load-bearing
    // (2026-08-05, #5176). In the `http_request_cache_settings` phase EVERY
    // matching rule is applied in order and a LATER rule overrides an earlier
    // one. `early-boot-js-bypass-cache` (`cache: false`, foreign rule, index 2)
    // is meant to keep that one file uncacheable so the version-skew self-heal
    // script is never stale. But assertCacheRules() below appends a managed
    // rule it does not already find (`rules.push(desired)`), so this rule lands
    // at index 4 — AFTER the bypass — and its `cache: true` silently won.
    // Measured live: `GET https://cdn.frontaliereticino.ch/assets/early-boot.js`
    // returned `cf-cache-status: HIT`, not `BYPASS`. The window that rule exists
    // to close was open the whole time.
    //
    // Fixing this by reordering would be fragile: the ordering is a side effect
    // of append-on-create, and a foreign rule can be re-created at any index by
    // whoever owns it. Excluding the path here makes the bypass the ONLY rule
    // that matches it, so it cannot be overridden no matter how the list is
    // ordered. Same shape as the /cdn-build-id.txt exclusion above.
    //
    // Why it matters beyond tidiness: a stale early-boot.js serves an old
    // self-heal listener set against new HTML, which is the cross-chunk skew
    // behind #3216 / #5062 / #4644 — the same dynamic-import failure #5165 just
    // closed from the 502 side. Leaving this open lets that issue come back for
    // a different reason and look like a regression of that fix.
    // Guarded by tests/cdn-zone-rule-invariants.test.ts.
    description: 'cdn-r2-passthrough-cache (managed by scripts/cf-locale-failover-setup.mjs)',
    expression:
      '(http.host eq "cdn.frontaliereticino.ch" and ' +
      'http.request.uri.path ne "/cdn-build-id.txt" and ' +
      `http.request.uri.path ne "${EARLY_BOOT_PATH}")`,
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
  {
    // CDN root -> apex (2026-08-05, #5176). `cdn.frontaliereticino.ch/` served
    // 42_919 404s in 23h — by far the zone's largest non-2xx, and larger than
    // every 5xx put together.
    //
    // It is NOT our defect. Measured before adding this rule:
    //   - 99.4% arrived over HTTP/1.1 (42_641 / 42_919) with an unrecognised
    //     user agent; browsers reach this zone over HTTP/2, and our own asset
    //     traffic is overwhelmingly HTTP/2.
    //   - bursty, not referenced: ~0/h for hours, then 6.5k / 7.9k / 10.3k /
    //     10.2k in single hours.
    //   - single-origin: 42_543 of them from one country (BE), which sends
    //     44_219 CDN requests in total — i.e. essentially all of it is this.
    //   - nothing the site emits requests the bare CDN root; the arriving tail
    //     alongside it is plain WordPress probing (/wp-json/batch/v1,
    //     /index.php, /config/.env, /wp-content/…).
    //
    // So the remedy is not to "fix a broken link" but to stop paying for the
    // answer. R2 has no root object, so each of those 404s returned
    // Cloudflare's stock ~28 KB R2 error page: 315.3 MB of egress in 23h to
    // tell a scanner the CDN has no home page.
    //
    // A 301 is the cheapest correct answer: no body, and semantically right for
    // anyone who does land there (the CDN root is not a page — the site is).
    // Deliberately NOT a WAF block: this costs nothing to serve, cannot produce
    // a false positive against a real client, and needs no allowlist upkeep.
    //
    // The dynamic-redirect phase runs BEFORE the cache and before the R2 object
    // lookup, so this intercepts ahead of the 404 — the same mechanism already
    // proven on this zone by scripts/ensure-cdn-fonts-redirect.mjs (#3248).
    // Exact-match on "/" only, so no other CDN path can be caught by it and a
    // redirect loop is impossible (the target is a different host).
    //
    // The target deliberately uses the `expression` + concat() form rather than
    // the static `target_url.value` form. Every redirect rule live on this zone
    // uses concat() — including "CDN fonts -> apex", whose construct this copies
    // byte for byte — whereas `value` is unproven here. This script REWRITES
    // action_parameters wholesale on every run, so an unverified schema would not
    // fail in isolation: the PUT bails and takes routes, cache, firewall and
    // redirect config down with it. Same reasoning the serve_stale field was held
    // back for until it could be checked against the live zone.
    // Since the expression matches only path == "/", concat() here always yields
    // exactly https://frontaliereticino.ch/ .
    // Guarded by tests/cdn-zone-rule-invariants.test.ts.
    description: 'cdn-root-301 (managed by scripts/cf-locale-failover-setup.mjs)',
    expression: '(http.host eq "cdn.frontaliereticino.ch" and http.request.uri.path eq "/")',
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: {
          expression: 'concat("https://frontaliereticino.ch", http.request.uri.path)',
        },
        preserve_query_string: false,
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
  // serve_stale is declared ONLY on cdn-r2-passthrough-cache, so compare it
  // only where it is wanted — otherwise the two apex rules, which legitimately
  // never carry it, would report perpetual drift and rewrite on every run.
  //
  // Without this branch the field is invisible to the comparison, which is a
  // one-way trap rather than a harmless omission: an in-shape rule keeps its
  // live action_parameters (so serve_stale survives an ordinary run), but the
  // first run that DOES see drift on this rule replaces it wholesale with the
  // constant below (`rules[idx] = desired`) and silently drops serve_stale —
  // reopening the 5xx family at the least observable moment. Comparing it here
  // also means the script RESTORES the field if it is ever stripped by hand.
  if (want.serve_stale) {
    const s = p.serve_stale;
    if (!s || s.disable_stale_while_updating !== want.serve_stale.disable_stale_while_updating) return false;
  }
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
  // A redirect target is EITHER dynamic (`expression`) or static (`value`), and
  // both must be compared. Checking only `expression` is drift-blind for a
  // static target: both sides read `undefined`, the comparison passes, and any
  // change to the destination URL — including one made by hand in the dashboard
  // — reports "already in shape" forever.
  //
  // No managed rule uses the static form today (cdn-root-301 deliberately uses
  // concat(), see its comment), so this is a latent bug rather than an active
  // one — surfaced while evaluating that form for #5176. It is guarded here so
  // the first static rule someone adds is not silently unmanaged.
  const fromTarget = from.target_url || {};
  if (fromTarget.expression !== want.target_url.expression) return false;
  if (fromTarget.value !== want.target_url.value) return false;
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
