#!/usr/bin/env node
/**
 * cf-purge-cache.mjs — purge the Cloudflare edge cache after a deploy.
 *
 * WHY this exists: the apex HTML cache rule (it-apex-html-cache, managed by
 * cf-locale-failover-setup.mjs) makes extensionless 200 pages ELIGIBLE for
 * the edge cache with a long Edge TTL (override_origin 24h). GitHub Pages
 * does NOT notify Cloudflare when a deploy republishes content, so without
 * an explicit purge the edge would keep serving the PREVIOUS build's HTML
 * for up to the Edge TTL. This script clears the zone cache so the next
 * request re-fetches the freshly-deployed origin content.
 *
 * WHEN to run: ONLY after the new build is confirmed LIVE at origin
 * (post-deploy-validate-live → "Wait for Pages propagation"). Purging BEFORE
 * propagation would re-cache the OLD content (Pages still serving the prior
 * build) and defeat the purpose. The validate-live wiring gates this on the
 * propagation step succeeding.
 *
 * SCOPE: purge_everything (default, no argv). The site deploys as a whole
 * (every HTML page can change per build), and the free plan's granular purge
 * is capped at 30 URLs — far below the page count — so a full purge is the
 * correct primitive. It also clears the locale-shard failover entries (they
 * simply re-warm). cdn.frontaliereticino.ch IS Cloudflare-proxied (verified
 * 2026-07-05 via the zone's DNS record, proxied: true — an earlier
 * "DNS-only/Fastly" assumption here was stale; see
 * scripts/ensure-cdn-fonts-redirect.mjs), so this same purge_everything call
 * ALSO clears any edge-cached response for cdn.* (e.g. the /fonts/* redirect
 * from issue #3248). Desired, not a scope gap: one zone, one purge covers
 * both hostnames.
 *
 * TARGETED MODE: `--files=<url1>,<url2>,...` purges only those exact URLs
 * (Cloudflare's `files` purge_cache mode) instead of the whole zone. Added
 * for issue #4881 Fase 3 (pushable-origin fast-publish): the fast-publish
 * path PUTs a handful of files (sitemap/RSS/llms.txt) straight to R2 and
 * needs a cheap, fast, per-file purge — NOT a 650k-file full-zone purge,
 * which would be wildly disproportionate for a single-article publish and
 * would defeat the "near-instant" point of that pipeline (see
 * scripts/publish-edge-files.mjs, the sole caller of this mode so far).
 * Capped at 30 URLs (free-plan `files` purge limit) — over the cap is a hard
 * error, never a silent truncation (a silently-dropped URL would leave that
 * one file stale with no signal).
 *
 * THE AXIS THAT MATTERS ON THIS ZONE IS THE CACHE-KEY HOSTNAME (#5483). For any
 * path on a Cloudflare Worker route (infra/cloudflare-worker/wrangler.toml) the
 * entry a visitor is served is keyed on `origin-<shard>.frontaliereticino.ch`,
 * because locale-router.js's serveShard() fetches that host with
 * `cacheEverything`. An apex-only `--files=` list for such a path returns 200
 * and moves nothing, so this mode now emits a `::warning::` naming each apex URL
 * that has no non-apex companion in the same list — see the block below the cap
 * check and scripts/lib/cf-worker-routes.mjs.
 *
 * Skips the PURGE_SETTLE_MS sleep below: that
 * delay exists specifically for the purge_everything + immediate-live-probe
 * race (issue #4429); targeted callers don't race a live probe, so the sleep
 * would only slow down the fast-publish path for no benefit.
 *
 * Auth: CF_API_TOKEN — needs Zone→Cache Purge. Resolves zone by name unless
 * CF_ZONE_ID is set. Hydrate locally via:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs)" && node scripts/cf-purge-cache.mjs
 *
 * Zone-id resolution itself delegates to scripts/lib/cf-analytics.mjs's
 * resolveZoneId (AGENTS.md #6 — no inline copy of that fetch+parse construct);
 * this file's own resolveZoneId() wrapper only adds this script's specific
 * warnStaleEdge annotation on failure.
 *
 * Exit: 0 = purged (or no-op when CF_API_TOKEN absent — non-fatal so a
 * missing secret never fails the deploy), 1 = API/auth error or >30 --files.
 *
 * SETTLE DELAY (purge_everything path only): acknowledged instantly by the
 * API but takes up to ~30s to actually clear every edge PoP globally
 * (Cloudflare's own documented worst case) — on this ~650k-file zone the
 * very next requests are a cache-miss storm that can transiently
 * 503/timeout at the edge while it re-fetches from origin. The
 * validate-live workflow calls this script and then, within ~1s, runs
 * probe-5xx + e2e:live straight at LIVE_BASE_URL — racing our OWN purge
 * (root cause of the immediate-503 flake behind issue #4429, e.g. run
 * 29657637517: purge ack'd 19:39:07.37, probe started 19:39:08.38).
 * Sleeping here (not in the caller) keeps the fix scoped to the script that
 * creates the race, no workflow-YAML edit needed. A 4XX from a real broken
 * deploy still fails after the settle — this only smooths over the purge's
 * own propagation window.
 */
import { resolveZoneId as resolveZoneIdShared } from './lib/cf-analytics.mjs';
// Cloudflare free-plan `files` purge_cache cap. Shared with
// scripts/ci/purge-changed-cdn-assets.mjs, which batches UP TO this value —
// a drifting second copy there would produce lists this script rejects.
import { MAX_TARGETED_FILES } from './lib/cf-purge-limits.mjs';
// Every cache variant the edge keeps for a URL — `Vary: Origin` means the
// browser's copy is a SEPARATE entry from the one a header-less purge clears.
import { purgeBodiesForUrls } from './lib/cf-purge-variants.mjs';
// Which apex paths the Worker answers, and therefore which apex purges cannot
// move the copy a visitor is served (#5483).
import { apexPurgeBlindSpots } from './lib/cf-worker-routes.mjs';

const PURGE_SETTLE_MS = Number(process.env.CF_PURGE_SETTLE_MS) || 20_000;

const REST_BASE = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = process.env.CF_ZONE_NAME || 'frontaliereticino.ch';
const token = process.env.CF_API_TOKEN;

const filesArg = process.argv.find(arg => arg.startsWith('--files='));
const targetFiles = filesArg
  ? filesArg
      .slice('--files='.length)
      .split(',')
      .map(url => url.trim())
      .filter(Boolean)
  : null;

if (targetFiles && targetFiles.length > MAX_TARGETED_FILES) {
  console.error(
    `❌ --files lists ${targetFiles.length} URLs, over the ${MAX_TARGETED_FILES}-URL free-plan cap. Split into multiple calls — never silently truncated.`,
  );
  process.exit(1);
}

// APEX-BLIND PURGE WARNING (#5483).
//
// On THIS zone a ✅ from a `files` purge does not mean the served copy moved.
// locale-router.js's serveShard() fetches the shard origin with
// `cacheEverything`, so for every path on a Worker route the entry a visitor
// reads is keyed on `origin-<shard>.frontaliereticino.ch/<path>` — an apex-only
// purge of that path returns 200 and clears an entry nobody is being served.
// The blindness is bounded by infra/cloudflare-worker/wrangler.toml: apex
// passthrough paths (`/`, `/blog/…`, `/aziende/…`) are keyed on the apex and
// their purge is the real one.
//
// The warning fires BEFORE the token check on purpose. Without a token this
// script is a clean no-op exit 0, and a caller developing a purge list locally
// is exactly the reader who needs to be told the list is blind — waiting until
// a CI run with credentials would hide it from the only person able to fix it.
//
// Never fatal, and never a substitute for the caller naming the origin URL
// itself: the mapping from an apex path to its origin is unambiguous for shard
// paths but not for the R2-backed EDGE_PUSHED_FILES paths on the same route
// list, and a wrong expansion would trade a visible gap for a false ✅.
if (targetFiles) {
  let blindSpots = [];
  try {
    blindSpots = apexPurgeBlindSpots(targetFiles);
  } catch (err) {
    console.log(
      `::warning title=Apex-blind purge check skipped::could not read the Worker routes (${err.message}) — this purge may or may not reach the copy visitors get.`,
    );
  }
  for (const { url, pattern, expectedOrigin } of blindSpots) {
    const fix = expectedOrigin
      ? `add https://${expectedOrigin}${new URL(url).pathname} to the SAME --files list`
      : 'add the URL on the host that actually serves it (shard origin, or the cdn.frontaliereticino.ch key for an EDGE_PUSHED_FILES path)';
    console.log(
      `::warning title=Apex purge does not move the served copy::${url} matches the Cloudflare Worker route \`${pattern}\`, so the entry visitors read is keyed on the shard ORIGIN host, not on this apex URL. This URL will still report ✅ and change nothing — ${fix}. See scripts/lib/cf-worker-routes.mjs (#5483).`,
    );
  }
}

// Non-fatal when the secret is absent: callers wire this with
// continue-on-error, but a clean exit 0 keeps logs quiet on env-less runs.
if (!token) {
  console.warn('⚠️  CF_API_TOKEN not set — skipping Cloudflare cache purge (non-fatal).');
  process.exit(0);
}

// Surface a purge failure in the GitHub Actions run UI. The validate-live step
// (post-deploy-validate-live.yml) wires this with `continue-on-error: true` —
// a purge hiccup must not fail the deploy — but that ALSO swallows the non-zero
// exit, so without an explicit annotation the failure is invisible in the run
// summary: a revoked/mis-scoped token or a persistent CF API error would leave
// the edge serving stale HTML for up to the 24h Edge TTL with NO active signal
// (it would only surface by reading the validate-live logs). Crawlers that
// ignore the short browser max-age=600 could index that stale HTML → SEO drift
// for the whole window. A `::warning::` line on stdout is rendered as a run
// annotation even under continue-on-error, making the failure visible without
// making the deploy fatal (the intentional design). See issue #2067.
function warnStaleEdge(reason, staleWindow = 'up to 24h (Edge TTL) until the next deploy purges it') {
  console.log(
    `::warning title=Cloudflare cache purge failed::${reason} — edge may serve STALE content for ${staleWindow}. Re-run the purge or check CF_API_TOKEN scope (Zone→Cache Purge).`,
  );
}

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
    console.error(`❌ Cannot resolve zone id for ${ZONE_NAME} (token scope?).`);
    warnStaleEdge(`could not resolve zone id for ${ZONE_NAME} (token scope?)`);
    process.exit(1);
  }
}

// ZONE-WIDE PURGE IS OPT-IN SINCE 2026-08-05 (#5162).
//
// `purge_everything` is zone-wide, and this zone holds TWO hostnames with very
// different cache economics. Measured over 23h:
//
//   cdn.frontaliereticino.ch  1_497_318 req, 96.0% hit  ← destroyed as collateral
//   frontaliereticino.ch        570_021 req, 19.2% hit  ← the only intended target
//
// The CDN never needed this purge: /assets/ freshness comes from the targeted
// per-key purge in scripts/ci/purge-changed-cdn-assets.mjs, which purges exactly
// the keys the deploy re-uploaded. So each full-zone purge threw away a
// 1.4M-object cache to refresh a cache that was barely holding anything, and the
// re-fetch storm went straight at R2: ~60k origin fetches in 23h against a 7-day
// edge TTL, 277 of which failed as edge-synthesised 502s (issues #5034, #5035,
// #5036, #5052, #5081, #5092, #5093, #5094, and the failed dynamic import in
// #4644). The apex 503s (#5082) are the same storm hitting GitHub Pages.
//
// It also made serve_stale (#5158) structurally dead: a purge DELETES the cached
// copy, while serve_stale can only serve a copy that exists and has merely
// expired. Measured staleRescuable = 0. The two cannot both be the strategy.
//
// Apex freshness now comes from a bounded 300s edge TTL instead
// (APEX_EDGE_TTL_SECONDS in scripts/cf-locale-failover-setup.mjs), so no deploy
// needs to purge the zone. This flag stays for deliberate operator use (e.g. a
// cache-poisoning incident), and must not be wired back into a deploy workflow.
// Guarded by tests/cf-zone-purge-blast-radius.test.ts.
const ZONE_WIDE_OPT_IN = process.env.CF_PURGE_ZONE_WIDE === '1';

try {
  if (!targetFiles && !ZONE_WIDE_OPT_IN) {
    console.log(
      '⏭️  Zone-wide purge_everything is opt-in (set CF_PURGE_ZONE_WIDE=1) — skipping. ' +
        'Apex freshness comes from the 300s edge TTL; CDN freshness from the targeted per-key purge ' +
        '(scripts/ci/purge-changed-cdn-assets.mjs). See the header comment and #5162.',
    );
    process.exit(0);
  }
  const zoneId = await resolveZoneId();
  const purgeLabel = targetFiles ? `${targetFiles.length} file(s)` : 'purge_everything';

  // TARGETED MODE CLEARS EVERY CACHE VARIANT, NOT JUST THE HEADER-LESS ONE.
  //
  // `cdn.frontaliereticino.ch` answers with `Vary: Origin`, so the edge holds
  // TWO entries per URL: the one a header-less request creates (curl, CI probes)
  // and the one a cross-origin module `<script>`/`fetch` from the SPA creates —
  // the only one a real browser ever reads. A `files: ['<url>']` purge clears
  // the first alone.
  //
  // Measured on this zone 2026-08-06, same URL, one minute apart:
  //   files: ['…/assets/App.js']                → Origin variant stayed HIT, age climbed 20→28
  //   files: [{url, headers:{Origin: <site>}}]  → Origin variant went MISS
  //
  // Not a detail: deploy-it-pages-prep.sh purges exactly these keys after every
  // R2 sync, so the bundle browsers boot stayed stale up to its `max-age`
  // (7 days) behind the one CI could see. That shipped an /aziende/<slug>/ page
  // whose HTML carried a hydration island the served JS knew nothing about —
  // 19h of a dead «Segui questa azienda» behind a green pipeline (#5012).
  //
  // Both calls carry the SAME url list, as separate POSTs rather than one
  // doubled list, so MAX_TARGETED_FILES keeps meaning "URLs" and not "cache
  // entries".
  const purgeVariants = targetFiles
    ? purgeBodiesForUrls(targetFiles)
    : [{ label: 'purge_everything', purge_everything: true }];

  for (const { label, ...purgeBody } of purgeVariants) {
    const { json } = await cf('POST', `/zones/${zoneId}/purge_cache`, purgeBody);
    if (!json?.success) {
      console.error(`❌ ${purgeLabel} [${label}] failed: ${JSON.stringify(json?.errors)}`);
      warnStaleEdge(
        `${purgeLabel} [${label}] API call failed: ${JSON.stringify(json?.errors)}`,
        targetFiles ? `until the next successful purge of these URLs` : undefined,
      );
      process.exit(1);
    }
  }

  if (targetFiles) {
    console.log(`✅ Cloudflare edge cache purged for ${targetFiles.length} URL(s) × ${purgeVariants.length} variant(s) (zone ${zoneId}):`);
    for (const url of targetFiles) console.log(`   - ${url}`);
    console.log(
      '⏳ Not sleeping (targeted mode has no immediate-live-probe race like the full-zone path) — propagation is best-effort, up to ~30s worst case across edge PoPs (Cloudflare documented ceiling).',
    );
    // Say what this success does NOT cover, because the gap is invisible and
    // reading the ✅ above as "the browser now gets the new copy" cost 28 hours
    // on issue #4974. A `files` purge clears the variant matching the purge
    // REQUEST, which sends no `Origin`. Any response carrying `Vary: Origin`
    // also has a second, separate variant — the one a cross-origin `fetch()`
    // from the app receives — and this call does not touch it. Verified live:
    // the purge returned 200 for 19 URLs and the copy the browser received did
    // not move for 28 hours, while curl saw the fresh one throughout.
    console.log(
      '⚠️  Targeted purge clears the variant matching THIS request, which sends no '
      + '`Origin`. If a response ever varies on `Origin` again, the copy browsers get '
      + 'survives this ✅ untouched. A zone rule now rewrites that header on '
      + 'cdn.frontaliereticino.ch /assets/* and /data/* (the responses answer every '
      + 'origin identically, so varying on it was wrong), and '
      + 'scripts/ci/check-hydrated-article-parity.mjs asserts the property rather than '
      + 'trusting it — because nothing in this repo owns that rule.',
    );
    console.log(
      "⚠️  Same gap for `Vary: Accept-Encoding` (#5483), and there's no fix here: "
      + "Cloudflare's per-file purge headers support only Origin, CF-Device-Type and "
      + 'Accept-Language — Accept-Encoding is not a purgeable dimension, so a response '
      + 'that varies on it keeps a variant this ✅ cannot reach, on ANY host. The apex '
      + '(frontaliereticino.ch) is unaffected in practice — it-apex-html-cache overrides '
      + 'Edge TTL to a self-invalidating 300s (scripts/cf-locale-failover-setup.mjs), so '
      + 'that variant expires on its own regardless of this purge. A host without that '
      + 'bound (e.g. a future respect_origin rule with a real multi-day TTL) would not '
      + 'have the same safety net.',
    );
  } else {
    console.log(`✅ Cloudflare edge cache purged (zone ${zoneId}).`);
    console.log(`⏳ Settling ${PURGE_SETTLE_MS}ms for the purge to propagate across edge PoPs before the caller probes LIVE_BASE_URL...`);
    await new Promise(resolve => setTimeout(resolve, PURGE_SETTLE_MS));
  }
} catch (err) {
  console.error(`❌ Cloudflare API request failed: ${err.message}`);
  warnStaleEdge(`network error contacting Cloudflare API: ${err.message}`);
  process.exit(1);
}
