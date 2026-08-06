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
 *   side A — the article slugs the SSG wrote into `.ssg-article-grid`.
 *   side B — the literal text of the data surfaces the client itself loads:
 *            the registry chunk, the slug map, and the runtime overlay index.
 *
 * A slug in A that appears nowhere in B is an article the client cannot
 * render or cannot link: hydration drops it. That is the failure, and it is
 * reported per-slug rather than as a count, because the count alone reads as
 * noise while the slugs read as an outage.
 *
 * Exit 0 when every rendered slug is present in the client's data, 1 otherwise.
 * Network trouble reaching a surface is exit 1 as well: this gate exists to be
 * believed, so it must never pass by failing to look.
 *
 * Usage:
 *   node scripts/ci/check-hydrated-article-parity.mjs
 *   node scripts/ci/check-hydrated-article-parity.mjs --section=svizzera
 *   node scripts/ci/check-hydrated-article-parity.mjs --json
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const SITE = flag('base', 'https://frontaliereticino.ch').replace(/\/$/, '');
const CDN = flag('cdn', 'https://cdn.frontaliereticino.ch').replace(/\/$/, '');
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
 * `--overlay=` overrides the URL. It exists so this gate can be verified BY
 * MUTATION rather than trusted: pointing it at the un-bucketed
 * `…/blog-index-<section>-<locale>.json` reproduces the pre-fix client and
 * must turn the gate red. A gate that stays green when aimed at the known
 * defect is worse than no gate, so re-run that mutation whenever this file
 * changes.
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

/**
 * Slugs the SSG wrote into the hub's article grid.
 *
 * Scoped to `.ssg-article-grid` on purpose: the page also links articles from
 * the nav, the footer and the related rails, and those are not the list under
 * test. Anchored on the grid's own card class so a layout change that drops
 * the grid surfaces as "0 rendered" (a hard failure below) rather than as a
 * silently passing empty set.
 */
function renderedSlugs(html) {
  if (!html.includes('ssg-article-grid')) return [];
  const prefix = HUB.replace(/\/$/, '');
  const href = new RegExp(`href="${prefix}/([a-z0-9][a-z0-9-]{4,})/"`);
  const out = new Set();
  // Anchors carrying the grid's own card class, whatever the attribute order.
  // Matching the card rather than "everything after the grid marker" keeps the
  // nav, the footer and the related rails out of the comparison — they link
  // articles too, and counting them would make this gate red for reasons that
  // are not the defect.
  for (const [tag] of html.matchAll(/<a\b[^>]*>/g)) {
    if (!tag.includes('ssg-art-card')) continue;
    const m = tag.match(href);
    if (m) out.add(m[1]);
  }
  return [...out];
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

const slugs = renderedSlugs(hub.body);
report.renderedCount = slugs.length;
if (slugs.length === 0) {
  fail(
    `no article cards found in ${SITE}${HUB} under .ssg-article-grid. Either the SSG `
    + 'stopped emitting the grid or its markup changed — both need a human, and '
    + 'neither may pass as "nothing to compare".',
  );
}

// Every client surface, fetched the way the client fetches it.
let clientText = '';
for (const url of [...CLIENT_SURFACES, OVERLAY_URL]) {
  try {
    const r = await getText(url, BROWSER_HEADERS);
    clientText += `\n${r.body}`;
    report.surfaces[url] = { bytes: r.body.length, lastModified: r.lastModified };
  } catch (err) {
    fail(`client surface unreadable (${url}): ${err.message}`);
  }
}

// A slug the client's own data never mentions is one it cannot render or link.
const missing = slugs.filter((s) => !clientText.includes(s));
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
