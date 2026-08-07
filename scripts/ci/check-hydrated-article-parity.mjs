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
 * Usage:
 *   node scripts/ci/check-hydrated-article-parity.mjs
 *   node scripts/ci/check-hydrated-article-parity.mjs --section=svizzera
 *   node scripts/ci/check-hydrated-article-parity.mjs --json
 */

import { readFileSync } from 'node:fs';
import {
  renderedSlugs, idsInRegistryChunk, missingFromClient, divergentSurfaces,
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
 * The runtime overlay index. Requested under the same rotating key the app
 * uses (services/articlesOverlay.ts) — checking a URL the app never requests
 * would be checking a different cache entry, which is the mistake this whole
 * file is about.
 */
const OVERLAY_BUCKET = Math.floor(Date.now() / (5 * 60 * 1000));
/**
 * `--overlay=` overrides the URL, so this gate can be aimed at the pre-fix
 * client (the un-bucketed `…/blog-index-<section>-<locale>.json`) and checked
 * against a known defect instead of trusted.
 *
 * Done on 2026-08-06 while production still had the drift: the gate named
 * exactly the six articles a browser had been dropping —
 * `frontalierieticinoaumento`, `frontaliere-nascita-figlio-anagrafe-2026`,
 * `borse-zurigo-chiude-in-verde-new-york-si-concede-una-fuga`,
 * `disavanzo-cantonale-ticino-frontalieri`,
 * `nascita-figlio-frontaliero-entro-20km`,
 * `mendrisio-strada-serpiano-urgenti-lavori` — matching the Chrome
 * measurement exactly.
 *
 * Be aware that this mutation reproduces ONLY while the stale variant is still
 * being served: once the edge copy catches up, the same command passes because
 * there is genuinely nothing missing. A green result from it therefore proves
 * nothing on its own — it is not a substitute for the recorded run above.
 */
const OVERLAY_URL = flag(
  'overlay',
  `${CDN}/data/blog-index-${SECTION}-${LOCALE}.json?v=${OVERLAY_BUCKET}`,
);

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

// Ids the client actually holds: the compiled registry plus the runtime
// overlay, both fetched the way the client fetches them.
const clientIds = new Set();
for (const url of CLIENT_SURFACES) {
  try {
    const r = await getText(url, BROWSER_HEADERS);
    report.surfaces[url] = { bytes: r.body.length, lastModified: r.lastModified };
    for (const id of idsInRegistryChunk(r.body)) clientIds.add(id);
  } catch (err) {
    fail(`client surface unreadable (${url}): ${err.message}`);
  }
}
try {
  const r = await getText(OVERLAY_URL, BROWSER_HEADERS);
  report.surfaces[OVERLAY_URL] = { bytes: r.body.length, lastModified: r.lastModified };
  for (const a of JSON.parse(r.body)?.articles ?? []) {
    if (a && typeof a.id === 'string') clientIds.add(a.id);
  }
} catch (err) {
  fail(`overlay index unreadable (${OVERLAY_URL}): ${err.message}`);
}
report.clientIds = clientIds.size;

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

if (divergent.length > 0) {
  console.error('');
  console.error('[hydrated-parity] ❌ the edge is serving a DIFFERENT copy to browsers than to checkers.');
  for (const d of divergent) {
    console.error(`[hydrated-parity]    ${d.url}`);
    console.error(`[hydrated-parity]      Origin sent (a browser) : ${d.withOrigin}`);
    console.error(`[hydrated-parity]      no Origin (curl, CI)    : ${d.withoutOrigin}`);
  }
  console.error('');
  console.error('[hydrated-parity]    Every other check reads the second copy and stays green while');
  console.error('[hydrated-parity]    visitors get the first. Look at the `Vary` header on these paths:');
  console.error('[hydrated-parity]    a `Vary: Origin` next to a constant `Access-Control-Allow-Origin: *`');
  console.error('[hydrated-parity]    fragments the edge cache into a variant no purge ever clears.');
  process.exit(1);
}

// A rendered article whose id the client does not hold is one hydration drops.
const missing = missingFromClient(slugs, reverse, clientIds);
report.missing = missing;

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
  process.exit(1);
}

if (!AS_JSON) {
  console.log(`[hydrated-parity] ✅ all ${slugs.length} rendered articles are present in the client's data (${SECTION}/${LOCALE}).`);
  for (const [url, meta] of Object.entries(report.surfaces)) {
    console.log(`[hydrated-parity]    ${meta.lastModified ?? 'unknown'}  ${url}`);
  }
}
