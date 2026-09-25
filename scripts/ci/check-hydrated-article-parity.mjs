#!/usr/bin/env node
/**
 * check-hydrated-article-parity.mjs — does the client actually have the
 * articles the server rendered?
 *
 * THE CLASS THIS PROTECTS, not the symptom. An article hub is produced twice:
 * the SSG writes the cards into the HTML, and React then re-renders the same
 * list from data the client fetches. Nothing compares the two. When they
 * disagree the server's cards are REMOVED on hydration, so the page a crawler
 * reads and the page a person reads differ, and the person sees the older one.
 *
 * Measured 2026-08-06 on the live hub: 104 articles in the HTML, 7 after
 * hydration, the six most recent absent — while every single-surface check
 * read green. The article's own URL returned 200, the sitemap, the RSS, the
 * news ticker and the corpus API all listed it. Only the COMPOSITION of two
 * surfaces showed the hole, which is why this gate compares two surfaces and
 * no existing gate could have caught it.
 *
 * ============================================================================
 * WHY THIS SENDS AN `Origin` HEADER, AND WHY THAT IS THE WHOLE POINT
 * ============================================================================
 *
 * The CDN responses carry `Vary: Origin`, so the edge keeps a SEPARATE cached
 * variant for requests that send one. A cross-origin `fetch()` from the app
 * sends `Origin`; `curl`, a direct navigation, and every naive CI probe do
 * not. Cloudflare's purge-by-URL clears the variant matching the purge
 * request — which carries no `Origin` — so the app's variant is never cleared
 * and lives to its `max-age`.
 *
 * Measured on one URL within the same second (2026-08-06):
 *
 *   Origin sent (what a browser does)  → last-modified 2026-08-05T19:08:32Z
 *   no Origin  (what a checker does)   → last-modified 2026-08-06T07:50:46Z
 *
 * A gate that fetched without `Origin` would therefore be GREEN while every
 * real visitor was served a copy up to 24h old. That is exactly how the defect
 * survived 28 hours. Do not "simplify" these headers away.
 *
 * WHAT IT COMPARES
 *   side A — the articles the SSG wrote into `.ssg-article-grid`, resolved
 *            from their URL slug to their id through the publisher's
 *            `slugs.json`.
 *   side B — the ids the client actually holds: the compiled registry chunk
 *            plus the runtime overlay index.
 *
 * ON IDS, NEVER ON SLUGS. The registry is keyed by `id`; the URL carries a
 * per-locale `slug`, and the two differ on most evergreen articles
 * (`stipendio-netto-2026` vs `stipendio-netto-frontaliere-2026`) and on EVERY
 * non-Italian URL. Grepping rendered slugs inside the bundles is what made an
 * earlier investigation report "zero matches" against a perfectly healthy
 * corpus and go after the wrong root cause.
 *
 * An id in A that is missing from B is an article hydration drops. Reported
 * per-article, not as a count: a count reads as noise, the list reads as an
 * outage.
 *
 * Exit 0 when the client holds every rendered article, 1 otherwise.
 * Network trouble reaching a surface is exit 1 as well: this gate exists to be
 * believed, so it must never pass by failing to look.
 *
 * ============================================================================
 * THE VERDICT COMES BEFORE THE DIAGNOSIS — AND WHY THAT ORDER IS THE FIX
 * ============================================================================
 *
 * The `Origin` divergence above is the MECHANISM. The question this gate
 * answers is the OUTCOME: does the client hold what the server rendered. Those
 * are not the same, because the runtime overlay exists precisely to close the
 * gap a stale registry chunk opens — it is fetched under a five-minute
 * rotating key, so it is never the stale variant.
 *
 * This file used to `exit(1)` on divergence BEFORE comparing anything, so a
 * red run never said which articles were lost — only that the edge was split.
 * Measured 2026-08-07 on production: the browser's `blog-articles-data.js` was
 * 18h old and lacked 9 of the 100 rendered articles; the overlay supplied all
 * 9; net missing 0 on all eight landings. The gate was red while every visitor
 * saw a whole hub.
 *
 * That inversion had a cost the condition itself did not. The caller retries a
 * red verdict 8× at 45s — a ladder built for an article that has not
 * propagated YET — but an unpurged edge variant lives to its `max-age`, up to
 * 24h, and is global, so it failed identically on all eight landings:
 * 5m28s each, ~44 minutes against a `timeout-minutes: 15` job. Every run from
 * 02:55 to 09:50 was cancelled at landing 3 of 8, so the gate never reached
 * the step that opens the issue; a timeout scanner reported it instead, as two
 * duplicate issues that named nothing (#5279, #5280).
 *
 * So the order is now: compare, then diagnose. Divergence fails the run when
 * an article was really lost — it is then the explanation, and worth failing
 * on — and warns when the overlay absorbed it. `--fail-on-divergence` restores
 * the hard failure for a caller that wants to assert the zone property
 * directly; run that as a single cheap probe, never behind a retry ladder.
 *
 * Usage:
 *   node scripts/ci/check-hydrated-article-parity.mjs
 *   node scripts/ci/check-hydrated-article-parity.mjs --section=svizzera
 *   node scripts/ci/check-hydrated-article-parity.mjs --json
 *   node scripts/ci/check-hydrated-article-parity.mjs --fail-on-divergence
 */

import { readFileSync } from 'node:fs';
import {
  renderedSlugs, idsInRegistryChunk, missingFromClient, divergentSurfaces,
  divergenceVerdict,
} from '../lib/hydratedParity.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const SITE = flag('base', 'https://frontaliereticino.ch').replace(/\/$/, '');
const CDN = flag('cdn', 'https://cdn.frontaliereticino.ch').replace(/\/$/, '');
/** The publisher's API — the authority on which slug belongs to which id. */
const API = flag('api', 'https://nanakokyobashi-rgb.github.io/frontaliere-articles').replace(/\/$/, '');
const SECTION = flag('section', 'frontaliere');
const LOCALE = flag('locale', 'it');
const AS_JSON = has('json');
/**
 * Assert the zone property directly: fail on edge divergence even when the
 * overlay absorbed it. For a dedicated single probe — never behind a retry
 * ladder, because this condition does not heal within a retry window.
 */
const STRICT_DIVERGENCE = has('fail-on-divergence');

if (SECTION !== 'frontaliere' && SECTION !== 'svizzera') {
  console.error(`[hydrated-parity] unknown --section=${SECTION} (frontaliere|svizzera)`);
  process.exit(1);
}

/**
 * The hub path, derived from the section-slug map rather than written out
 * here. `scripts/lib/section-shard-slugs.json` declares itself the single
 * source of truth for these slugs and documents the derivation: `it` sits at
 * the root, every other locale under its own prefix. Reading it means a slug
 * rename cannot leave this gate probing a 404 and reporting "no cards" — which
 * would be a red gate for a reason that is not the defect.
 */
const SECTION_KEY = SECTION === 'svizzera' ? 'articolisvizzera' : 'articolifrontaliere';
const SLUGS = JSON.parse(
  readFileSync(new URL('../lib/section-shard-slugs.json', import.meta.url), 'utf8'),
);
const slug = SLUGS[SECTION_KEY]?.[LOCALE];
if (!slug) {
  console.error(`[hydrated-parity] no slug for ${SECTION_KEY}/${LOCALE} in section-shard-slugs.json`);
  process.exit(1);
}
const DEFAULT_HUB = LOCALE === 'it' ? `/${slug}/` : `/${LOCALE}/${slug}/`;
const HUB = flag('hub', DEFAULT_HUB);

/** The client surfaces, exactly as the app requests them. */
const CLIENT_SURFACES = SECTION === 'svizzera'
  ? [
      `${CDN}/assets/swiss-articles-data.js`,
      `${CDN}/assets/routerSwissData.js`,
      `${CDN}/assets/blog-meta-ch-${LOCALE}.js`,
    ]
  : [
      `${CDN}/assets/blog-articles-data.js`,
      `${CDN}/assets/routerBlogData.js`,
      `${CDN}/assets/blog-meta-${LOCALE}.js`,
    ];

/**
 * The chunks that carry the overlay MECHANISM rather than article data.
 *
 * Read for one reason: the `Origin` divergence check below. Nothing here is
 * parsed for ids — they are code — but a stale copy of this code is how the
 * whole safety net stops running, so leaving them out made the gate blind to
 * its own premise.
 *
 * Measured 2026-08-08, both of them, on the copy a browser is served:
 *
 *   assets/runtimeArticleResolution.js  Origin sent → 2026-08-05T11:35:07Z, age 37h
 *                                       no Origin   → 2026-08-07T02:43:20Z
 *   assets/BlogArticles.js              identical split, same two timestamps
 *
 * The older body is the pre-rotation client: it requests the overlay at the
 * BARE url. So production was running a client this gate did not model, and
 * every surface it did read was current.
 */
const CODE_SURFACES = [
  `${CDN}/assets/runtimeArticleResolution.js`,
  `${CDN}/assets/BlogArticles.js`,
];

/**
 * The runtime overlay index, read at BOTH urls it is reachable by.
 *
 * `services/articlesOverlay.ts` requests it under a five-minute rotating key,
 * and this gate used to read only that — reasoning that the rotating key is
 * never the stale variant, which is true. What that reasoning assumed is that
 * the client doing the requesting is the one in this repo. It is not
 * necessarily: the client is whatever the edge is serving, and on 2026-08-08
 * the edge was serving a chunk from three days earlier that asks for the bare
 * url (see CODE_SURFACES above).
 *
 * So the gate read a cache entry no visitor was requesting and passed, while
 * the entry every visitor DID request was 12 to 16 hours old across six of the
 * eight `blog-index-<section>-<locale>.json` files. Checking a url the app
 * never requests is the mistake this whole file is about; reading only the
 * rotating key was that mistake, one level up.
 *
 * `clientIds` is therefore built from the BARE read: the conservative set,
 * what every served client is guaranteed to hold. A rotating client can only
 * hold more, so a green verdict here is green for both — and once the bare url
 * is purged on every publish (nanakokyobashi-rgb/frontaliere-articles#34) the
 * two reads agree and the conservative choice costs nothing.
 *
 * `--overlay=` overrides the base url; the rotating key is derived from it.
 */
const OVERLAY_BASE = flag('overlay', `${CDN}/data/blog-index-${SECTION}-${LOCALE}.json`);
const OVERLAY_BUCKET = Math.floor(Date.now() / (5 * 60 * 1000));
const OVERLAY_ROTATED = `${OVERLAY_BASE}${OVERLAY_BASE.includes('?') ? '&' : '?'}v=${OVERLAY_BUCKET}`;

/** Browser-identical request headers. See the header comment — load-bearing. */
const BROWSER_HEADERS = {
  Origin: SITE,
  Referer: `${SITE}${HUB}`,
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  Accept: '*/*',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

async function getText(url, headers) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return {
    body: await res.text(),
    lastModified: res.headers.get('last-modified'),
  };
}


function fail(msg) {
  console.error(`[hydrated-parity] ${msg}`);
  process.exit(1);
}

const report = {
  section: SECTION,
  locale: LOCALE,
  hub: `${SITE}${HUB}`,
  renderedCount: 0,
  missing: [],
  surfaces: {},
};

let hub;
try {
  hub = await getText(`${SITE}${HUB}`, { 'User-Agent': BROWSER_HEADERS['User-Agent'] });
} catch (err) {
  fail(`could not read the hub — refusing to pass without looking: ${err.message}`);
}

const slugs = renderedSlugs(hub.body, HUB);
report.renderedCount = slugs.length;
if (slugs.length === 0) {
  fail(
    `no article cards found in ${SITE}${HUB} under .ssg-article-grid. Either the SSG `
    + 'stopped emitting the grid or its markup changed — both need a human, and '
    + 'neither may pass as "nothing to compare".',
  );
}

/**
 * Compare on ids, never on slugs.
 *
 * The registry the client renders from is keyed by `id`; the URL carries a
 * per-locale `slug`, and the two differ on most evergreen articles
 * (`stipendio-netto-2026` vs `stipendio-netto-frontaliere-2026`) and on EVERY
 * non-Italian URL. Grepping rendered slugs inside the bundles is what made an
 * earlier investigation report "zero matches" on a healthy corpus and chase
 * the wrong root cause. So: resolve each rendered slug to its id through the
 * publisher's own `slugs.json`, then ask whether the client HAS that id.
 *
 * That is the question this gate exists to answer — can the client render what
 * the server rendered — and it is deliberately NOT the same as "can it build
 * the href", which the runtime slug map answers separately.
 */
const reverseKey = SECTION === 'svizzera' ? 'swissReverse' : 'blogReverse';
let reverse;
try {
  const r = await getText(`${API}/slugs.json`, { 'User-Agent': BROWSER_HEADERS['User-Agent'] });
  reverse = JSON.parse(r.body)?.[reverseKey]?.[LOCALE];
  if (!reverse || typeof reverse !== 'object') {
    fail(`slugs.json has no ${reverseKey}.${LOCALE} map — cannot resolve rendered slugs to ids`);
  }
} catch (err) {
  fail(`could not read the publisher's slugs.json — refusing to pass without looking: ${err.message}`);
}

/**
 * Ids the client actually holds, kept in TWO sets rather than one.
 *
 * The compiled chunks are cacheable for a long time and are the surface the
 * `Origin` split makes stale; the overlay is refetched under a five-minute
 * rotating key and is not. Keeping them apart is what lets this gate say how
 * much of the hub is standing on the overlay alone — the headroom that decides
 * whether a stale chunk is survivable or an outage.
 */
const chunkIds = new Set();
for (const url of CLIENT_SURFACES) {
  try {
    const r = await getText(url, BROWSER_HEADERS);
    report.surfaces[url] = { bytes: r.body.length, lastModified: r.lastModified };
    for (const id of idsInRegistryChunk(r.body)) chunkIds.add(id);
  } catch (err) {
    fail(`client surface unreadable (${url}): ${err.message}`);
  }
}
const overlayIds = { bare: new Set(), rotated: new Set() };
for (const [which, url] of [['bare', OVERLAY_BASE], ['rotated', OVERLAY_ROTATED]]) {
  try {
    const r = await getText(url, BROWSER_HEADERS);
    report.surfaces[url] = { bytes: r.body.length, lastModified: r.lastModified };
    for (const a of JSON.parse(r.body)?.articles ?? []) {
      if (a && typeof a.id === 'string') overlayIds[which].add(a.id);
    }
  } catch (err) {
    fail(`overlay index unreadable (${url}): ${err.message}`);
  }
}

// The mechanism chunks carry no ids; they are read only so the divergence
// check below can see whether the client itself is being served stale.
for (const url of CODE_SURFACES) {
  try {
    const r = await getText(url, BROWSER_HEADERS);
    report.surfaces[url] = { bytes: r.body.length, lastModified: r.lastModified };
  } catch (err) {
    fail(`overlay mechanism chunk unreadable (${url}): ${err.message}`);
  }
}

// The conservative set — see OVERLAY_BASE. A client that rotates its key holds
// a superset of this, so parity proven here is proven for both clients.
const clientIds = new Set(chunkIds);
for (const id of overlayIds.bare) clientIds.add(id);
report.clientIds = clientIds.size;

/**
 * Ids the rotating key reaches and the bare one does not. Non-zero means the
 * edge is still holding an unpurged copy of the overlay index itself: harmless
 * for a client that rotates, invisible-article for one that does not, and
 * either way the publisher's purge did not do what its green step said.
 */
report.overlayRotationGap = [...overlayIds.rotated].filter((id) => !overlayIds.bare.has(id));

/**
 * The verdict, computed BEFORE the diagnosis below.
 *
 * A rendered article whose id the client does not hold is one hydration drops.
 * This is the question the gate exists to answer, so nothing may pre-empt it —
 * a run that fails without naming the lost articles has reported the weather,
 * not the defect.
 */
const missing = missingFromClient(slugs, reverse, clientIds);
report.missing = missing;

/**
 * How many rendered articles only the overlay can still render. Zero means the
 * compiled chunks are current; a number climbing toward the overlay's own
 * window is the early warning that the next stale chunk WILL drop articles.
 */
const absorbedByOverlay = missingFromClient(slugs, reverse, chunkIds);
report.absorbedByOverlay = absorbedByOverlay;

/**
 * Second, independent check: does the edge answer the SAME url differently
 * depending on whether the caller sends `Origin`?
 *
 * This is the mechanism behind the whole file, caught directly instead of
 * through its consequences. When the CDN answered `Vary: Origin` next to a
 * constant `Access-Control-Allow-Origin: *`, the edge kept two variants of
 * each object and the purge only ever cleared the one no browser requests.
 * The site then served visitors a copy up to 24h old while every header check
 * read current — including, on 2026-08-06, a ten-hour-old `App.js`.
 *
 * A zone rule now rewrites that `Vary` (the response provably does not vary by
 * origin), but nothing in this repo owns that rule, so this asserts the
 * property rather than trusting it. Re-checked once before failing: the two
 * requests are not atomic, and an object legitimately refreshed between them
 * would otherwise read as divergence.
 */
const readings = {};
for (const url of Object.keys(report.surfaces)) {
  let bare;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      bare = (await getText(url, { 'User-Agent': BROWSER_HEADERS['User-Agent'] })).lastModified;
    } catch { bare = null; }
    const withOrigin = report.surfaces[url].lastModified;
    if (!withOrigin || !bare || withOrigin === bare) break;
    // Disagreed — re-read the Origin side once before believing it.
    try {
      report.surfaces[url].lastModified = (await getText(url, BROWSER_HEADERS)).lastModified;
    } catch { /* keep the first reading */ }
  }
  readings[url] = { withOrigin: report.surfaces[url].lastModified, withoutOrigin: bare };
}
const divergent = divergentSurfaces(readings);
report.divergent = divergent;

/**
 * Fatal when an article was really lost — divergence is then the explanation
 * and worth failing on — a warning when the overlay absorbed it, and fatal on
 * demand under `--fail-on-divergence`. See divergenceVerdict() for what the
 * old unconditional failure cost.
 */
const verdict = divergenceVerdict({ divergent, missing, strict: STRICT_DIVERGENCE });
report.divergenceVerdict = verdict;

function printDivergence(stream) {
  for (const d of divergent) {
    stream(`[hydrated-parity]    ${d.url}`);
    stream(`[hydrated-parity]      Origin sent (a browser) : ${d.withOrigin}`);
    stream(`[hydrated-parity]      no Origin (curl, CI)    : ${d.withoutOrigin}`);
  }
  stream('');
  stream('[hydrated-parity]    Every other check reads the second copy and stays green while');
  stream('[hydrated-parity]    visitors get the first. Look at the `Vary` header on these paths:');
  stream('[hydrated-parity]    a `Vary: Origin` next to a constant `Access-Control-Allow-Origin: *`');
  stream('[hydrated-parity]    fragments the edge cache into a variant no purge ever clears.');
  stream('[hydrated-parity]    This does NOT heal on retry: the unpurged variant lives to its');
  stream('[hydrated-parity]    `max-age`, up to 24h. Re-running is spent time, not a second chance.');
}

if (AS_JSON) console.log(JSON.stringify(report, null, 2));

if (missing.length > 0) {
  console.error('');
  console.error(`[hydrated-parity] ❌ ${missing.length}/${slugs.length} rendered articles are absent from the client's data.`);
  console.error(`[hydrated-parity]    Hub: ${SITE}${HUB}`);
  console.error('[hydrated-parity]    These are in the HTML and will be REMOVED on hydration:');
  for (const s of missing.slice(0, 25)) console.error(`[hydrated-parity]      - ${HUB}${s}/`);
  if (missing.length > 25) console.error(`[hydrated-parity]      … and ${missing.length - 25} more`);
  console.error('');
  console.error('[hydrated-parity]    Surfaces read (last-modified is the edge copy the BROWSER gets):');
  for (const [url, meta] of Object.entries(report.surfaces)) {
    console.error(`[hydrated-parity]      ${meta.lastModified ?? 'unknown'}  ${url}`);
  }
  console.error('');
  console.error('[hydrated-parity]    A stale last-modified here while the origin is current means the');
  console.error('[hydrated-parity]    edge is serving an unpurged `Vary: Origin` variant — see the header');
  console.error('[hydrated-parity]    comment in this file and services/articlesOverlay.ts.');
  if (divergent.length > 0) {
    console.error('');
    console.error('[hydrated-parity]    The edge IS split right now, which is very likely the cause:');
    printDivergence((l) => console.error(l));
  }
  process.exit(1);
}

if (verdict === 'fatal') {
  // Only reachable under --fail-on-divergence: parity holds, but the caller
  // asked for the zone property itself to be asserted.
  console.error('');
  console.error('[hydrated-parity] ❌ the edge is serving a DIFFERENT copy to browsers than to checkers.');
  printDivergence((l) => console.error(l));
  process.exit(1);
}

if (!AS_JSON) {
  console.log(`[hydrated-parity] ✅ all ${slugs.length} rendered articles are present in the client's data (${SECTION}/${LOCALE}).`);
  if (report.overlayRotationGap.length > 0) {
    console.log('');
    console.log(`[hydrated-parity] ⚠️  the overlay index itself is stale at its BARE url: ${report.overlayRotationGap.length} article(s)`);
    console.log('[hydrated-parity]    are reachable only under the rotating key. The publisher purged this');
    console.log('[hydrated-parity]    file and reported success, so what is stale is a cache VARIANT its');
    console.log('[hydrated-parity]    purge did not name — see cf-purge-variants.mjs in both repos.');
    for (const id of report.overlayRotationGap.slice(0, 10)) console.log(`[hydrated-parity]      - ${id}`);
    if (report.overlayRotationGap.length > 10) {
      console.log(`[hydrated-parity]      … and ${report.overlayRotationGap.length - 10} more`);
    }
    console.log('[hydrated-parity]    Not failing: the rendered set is still whole. It stops being whole as');
    console.log('[hydrated-parity]    soon as one of these ids reaches the hub HTML.');
  }
  if (verdict === 'warn') {
    console.log('');
    console.log('[hydrated-parity] ⚠️  the edge is serving a DIFFERENT copy to browsers than to checkers,');
    console.log(`[hydrated-parity]    and the runtime overlay is absorbing it: ${absorbedByOverlay.length}/${slugs.length} rendered`);
    console.log('[hydrated-parity]    articles are reaching the visitor through the overlay ALONE.');
    printDivergence((l) => console.log(l));
    console.log('');
    console.log('[hydrated-parity]    Not failing: every rendered article still reaches the visitor. But');
    console.log('[hydrated-parity]    this is the overlay spending its headroom — if that count approaches');
    console.log('[hydrated-parity]    the overlay window, the next stale chunk drops articles for real.');
  }
  for (const [url, meta] of Object.entries(report.surfaces)) {
    console.log(`[hydrated-parity]    ${meta.lastModified ?? 'unknown'}  ${url}`);
  }
}
