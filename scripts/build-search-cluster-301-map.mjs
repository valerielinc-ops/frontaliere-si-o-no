#!/usr/bin/env node
/**
 * Build data/search-cluster-301-map.json — a recovery map for the LEGACY
 * per-canton related-search cluster URLs that Google indexed under the old slug
 * format and that now hard-404.
 *
 * Background: related-search cluster pages were migrated from a per-canton,
 * salary-prefixed, nation-suffixed slug
 *     /cerca-lavoro-<canton>/ricerca-stipendio-<role>-svizzera/
 * to a single national hub keyed by the job city
 *     /cerca-lavoro-svizzera/ricerca-<role>-<city>/
 * The "stipendio" (salary) framing was deliberately consolidated onto the role,
 * and "<canton>" collapsed to "svizzera". The old indexed URLs were never
 * redirected → 404 (≈14k eyeball hits/day, the dominant residual-404 cohort).
 *
 * ALL 4 site locales carried the same legacy per-canton cluster shape (only the
 * section words differ):
 *   it  /cerca-lavoro-<canton>/ricerca-<body>[-svizzera]/
 *   en  /en/find-jobs-<canton>/search-<body>[-switzerland]/
 *   de  /de/jobs-(im|in)-<canton>/suche-<body>[-schweiz]/
 *   fr  /fr/trouver-emploi-<canton>/recherche-<body>[-suisse]/
 * Coverage was IT-only until 2026-07 (issue #2923, item 1): the multi-locale
 * boilerplate-strip helper this script needs lived in a `.ts` file plain
 * `node` can't import, so en/de/fr legacy orphans (≈59% of the indexed legacy
 * set) got zero candidate — see services/searchQueryBoilerplate.mjs docblock.
 *
 * This script maps each dead legacy URL to a LIVE target, VERIFIED against the
 * live cluster sitemaps so we never 301 to another 404:
 *   1. nationalize the legacy slug (strip leading salary/boilerplate/junk
 *      tokens + any trailing nation/salary suffix, swap <canton> → the
 *      locale's national aggregate section);
 *   2. if the resulting national cluster path is a live cluster → that is the
 *      SPECIFIC target (best relevance);
 *   3. otherwise, if a real Swiss municipality is detected in the slug body,
 *      fall back to that municipality's live per-city job page (its REAL
 *      canton, resolved from data/canton-municipalities.json — never the
 *      legacy URL's own canton, see note below) in the SAME locale;
 *   4. otherwise fall back to that municipality's canton job board, or (no
 *      city signal at all) the locale's national job board — always 200,
 *      always relevant, a safe never-wrong target.
 *
 * The map is consumed at build time by build-plugins/searchConsoleCompat.ts
 * (resolveSearchConsoleCompatTarget) so the compat bridge emits each legacy URL
 * pointing at its live target.
 *
 * Usage:
 *   node scripts/build-search-cluster-301-map.mjs            # fetch live sitemaps
 *   node scripts/build-search-cluster-301-map.mjs --live-file <path>  # offline
 *
 * Re-runnable: regenerate periodically (the live cluster set shifts with the job
 * data); a stale specific-target self-heals to the canton/national board on the
 * next run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELATED_SEARCH_JUNK_TERMS } from '../services/relatedSearchJunkTerms.mjs';
import {
  stripSearchQueryBoilerplate,
  SEARCH_QUERY_BOILERPLATE_TOKENS,
} from '../services/searchQueryBoilerplate.mjs';
import { createCantonResolvers, AGGREGATE_KEY } from '../build-plugins/shared/cantonResolvers.mjs';
import { readCompatPaths, writeCompatPaths } from './lib/compat-paths-store.mjs';
import { assertCompatFloor, COMPAT_PATHS_SANITY_FLOOR } from './lib/compat-paths-floor-guard.mjs';
import {
  DEFAULT_LIVE_CHECK_USER_AGENT,
  DEFAULT_LIVE_CHECK_TIMEOUT_MS,
  runWithConcurrency,
} from './lib/live-link-check.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const BASE = 'https://frontaliereticino.ch';
// Bounded parallelism for the per-city live-check pass below (issue #6774):
// there can be 600+ distinct city-page candidates, and running them one
// `await` at a time in series — with no per-request timeout at all — is what
// let the job blow past the 20min workflow ceiling (a single slow/hanging
// response stalled the whole run). Same fetch-liveness building block
// (runWithConcurrency) send-job-alerts.mjs and check-journalist-article-links.mjs
// already use for the same reason.
const LIVE_CHECK_CONCURRENCY = 10;
export const INDEXED = resolve(ROOT, 'data/indexed-cluster-urls.json');
export const OUT = resolve(ROOT, 'data/search-cluster-301-map.json');

export const LOCALES = ['it', 'en', 'de', 'fr'];

// Per-locale legacy URL shape: capture group 1 is the slug BODY right after
// THAT locale's OWN "search" section word (e.g. "ricerca-" for it), excluding
// the national/aggregate section itself (that is the live post-migration
// shape, not a legacy orphan).
//
// Deliberately NOT loosened to a locale-agnostic search-word alternation: a
// real (~0.3%, 28 of 9474) slice of the indexed legacy URLs mixes a
// canton-section in one locale with a search-word in ANOTHER (e.g.
// `/de/jobs-im-tessin/ricerca-…` — DE section, IT query word — a crawl/GSC
// artifact). These are intentionally left OUT of this map: when a `ricerca-`
// style path has no map entry, resolveSearchConsoleCompatTarget's
// `JOB_BOARD_SECTION_COMPAT_PATTERN` fallback (build-plugins/searchConsole
// Compat.ts) already canonicalizes it to the SAME canton section it was
// requested under — which `tests/search-console-compat.test.ts`'s "Section-
// preservation guard" locks in as the wrong-canton-drift invariant (#2041).
// This script's own "specific" target is ALWAYS the NATIONAL aggregate
// section by design (the live cluster hub is national, not per-canton), so
// force-mapping these 28 mixed-locale URLs here would REPLACE that better,
// section-preserving fallback with a worse cross-section one for no gain —
// confirmed by that guard test failing when this was tried. Leave them to the
// existing generic fallback; they are not an unresolved gap.
export const LOCALE_CONFIG = {
  it: {
    legacyBodyRx: /^\/cerca-lavoro-(?!svizzera\/)[a-z-]+\/ricerca-(.+?)\/?$/,
    searchPrefix: 'ricerca',
  },
  en: {
    legacyBodyRx: /^\/en\/find-jobs-(?!switzerland\/)[a-z-]+\/search-(.+?)\/?$/,
    searchPrefix: 'search',
  },
  de: {
    legacyBodyRx: /^\/de\/jobs-(?:im|in)-(?!schweiz\/)[a-z-]+\/suche-(.+?)\/?$/,
    searchPrefix: 'suche',
  },
  fr: {
    legacyBodyRx: /^\/fr\/trouver-emploi-(?!suisse\/)[a-z-]+\/recherche-(.+?)\/?$/,
    searchPrefix: 'recherche',
  },
};

// ── Canton URL-section resolution (single source of truth) ─────────────────
// Reused from build-plugins/shared/cantonResolvers.mjs — the SAME resolver the
// active page-emit and the canton-aware migration script use, so this
// candidate-generation script can never drift onto a canton-section shape the
// rest of the site does not actually serve (rule #6: no hand-rolled mirror).
const MUNI = JSON.parse(readFileSync(resolve(ROOT, 'data/canton-municipalities.json'), 'utf8'));
const CANTON_SLUGS = JSON.parse(readFileSync(resolve(ROOT, 'data/canton-url-slugs.json'), 'utf8'));
const resolvers = createCantonResolvers({ cantonSlugFile: CANTON_SLUGS, municipalitiesFile: MUNI });

/** Absolute root path for a locale + canton code (or AGGREGATE_KEY), e.g.
 * sectionRoot('en', 'VD') → '/en/find-jobs-vaud', sectionRoot('it', AGGREGATE_KEY) → '/cerca-lavoro-svizzera'. */
export function sectionRoot(locale, cantonCode) {
  const section = resolvers.resolveCantonSection(locale, cantonCode);
  return locale === 'it' ? `/${section}` : `/${locale}/${section}`;
}

// ── City → canton lookup (locale-agnostic: municipality names are effectively
// the same ASCII string across locales — "Rheinfelden", "Baden", "Lenzburg" —
// unlike canton names, which DO vary per locale and are resolved above via
// resolveCantonSection instead) ──────────────────────────────────────────────
function normalizeCitySlug(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const cityToCantonCode = new Map();
for (const [code, obj] of Object.entries(MUNI.cantons || {})) {
  for (const m of obj.municipalities || []) {
    const slug = normalizeCitySlug(m);
    if (slug && !cityToCantonCode.has(slug)) cityToCantonCode.set(slug, code);
  }
}

// Longest trailing municipality-slug in a hyphen-joined body ("progetti-morges"
// → "morges"; "compiti-wil-sg" → "wil-sg").
function detectTrailingCity(body) {
  if (!body) return null;
  const toks = body.split('-').filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const cand = toks.slice(i).join('-');
    if (cityToCantonCode.has(cand)) return cand;
  }
  return null;
}

// Generation-time liveness check (cached). City pages are 200 but not in any
// enumerable sitemap, so verify per-URL; a miss falls back to the canton board.
const liveCache = new Map();
async function isLive(pathUrl) {
  if (liveCache.has(pathUrl)) return liveCache.get(pathUrl);
  let ok = false;
  try {
    const res = await fetch(`${BASE}${pathUrl}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT },
      signal: AbortSignal.timeout(DEFAULT_LIVE_CHECK_TIMEOUT_MS),
    });
    ok = res.status === 200;
  } catch {
    ok = false;
  }
  liveCache.set(pathUrl, ok);
  return ok;
}

// Tolerated `indexed-cluster-urls.json` shapes: bare array, `{ urls: [...] }`,
// or any other object carrying exactly one array-valued property (the real
// on-disk shape is `{ ..., indexedPaths: [...] }`). Returns `undefined` when
// NONE of these match, so the caller can fail loud instead of silently
// falling back to an empty array.
export function resolveLegacyUrlsArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.urls)) return raw.urls;
    const found = Object.values(raw).find(Array.isArray);
    if (found) return found;
  }
  return undefined;
}

export function legacyClusterUrls(indexedPath) {
  const rawText = readFileSync(indexedPath, 'utf8');
  const raw = JSON.parse(rawText);
  const arr = resolveLegacyUrlsArray(raw);
  if (!Array.isArray(arr)) {
    console.error(
      `legacyClusterUrls: unexpected shape in ${indexedPath} — expected an array, an ` +
        '{ urls: [...] } object, or an object with at least one array-valued property. Got: ' +
        `${raw === null ? 'null' : typeof raw}. Aborting instead of writing an empty ` +
        'search-cluster-301-map.json.',
    );
    process.exit(1);
  }
  // Zero-entries guard: an unexpected shape that happens to resolve to a
  // tolerated variant (e.g. `{ urls: [] }`) but is genuinely empty must not
  // be treated the same as "no legacy URLs to recover" when the source file
  // itself carries real content — that combination is the exact silent-empty-
  // map failure mode this guard exists to catch (would zero out the entire
  // 301 recovery — ~14k hits/day — with no signal distinguishing it from a
  // normal run).
  if (arr.length === 0 && rawText.trim().length > 0) {
    console.error(
      `legacyClusterUrls: parsed 0 legacy URL candidates from ${indexedPath}, but the source ` +
        'file is non-empty — refusing to write an empty search-cluster-301-map.json. Check for ' +
        'an upstream shape/format change in indexed-cluster-urls.json.',
    );
    process.exit(1);
  }
  const urls = arr.map((u) => (typeof u === 'string' ? u : u.url || u.path || '')).filter(Boolean);
  const out = new Map(); // url → locale
  for (const u of [...new Set(urls)]) {
    for (const locale of LOCALES) {
      if (LOCALE_CONFIG[locale].legacyBodyRx.test(u)) {
        out.set(u, locale);
        break;
      }
    }
  }
  return out;
}

// Zero-map guard (issue #2918 item 2): even with a valid shape, if every URL
// fails to match a locale's legacyBodyRx (e.g. the source file's URLs
// changed format) the resulting Map is empty — same silent-zero-recovery
// failure mode as a bad shape. Fail loud instead of writing an empty map.
export function assertNonEmptyLegacyMap(legacy, indexedPath) {
  if (legacy.size === 0) {
    throw new Error(
      `legacyClusterUrls: parsed ${indexedPath} but matched ZERO legacy cluster URLs against any ` +
        'locale pattern — refusing to write an empty search-cluster-301-map.json (would silently ' +
        'zero out every previously-recovered redirect). Check the file contents and the ' +
        'LOCALE_CONFIG regexes.',
    );
  }
}

/**
 * Strip the legacy URL's own "search" section word, then iteratively strip
 * leading job-search boilerplate, trailing nation/salary/template suffixes
 * (via the shared multi-locale stripSearchQueryBoilerplate — the slug's
 * trailing noise word is not always in the URL's own locale, e.g. some DE
 * legacy slugs end in the English "-switzerland" rather than "-schweiz"; the
 * shared helper strips either regardless of which locale is being processed)
 * and leading junk search-terms, until stable.
 *
 * `stripSearchQueryBoilerplate()` itself deliberately NEVER empties its input
 * (see services/searchQueryBoilerplate.mjs — shared with display-facing
 * callers, e.g. tests/related-search-clusters.test.ts:193-196 pins
 * `stripSearchQueryBoilerplate('lavoro') === 'lavoro'` so a search box is
 * never left blank), so a body that IS entirely boilerplate words (e.g. the
 * legacy `/ricerca-lavoro/` slug) comes back unchanged instead of empty.
 * The pre-extraction `LEADING_BOILERPLATE` logic this replaced (#2917/#2924)
 * special-cased exactly this: `body === p → body = ''`, so the map-builder
 * falls through to the city/board fallback instead of treating a bare
 * boilerplate word as a "specific" cluster body. That all-boilerplate check
 * has to live HERE (the redirect-map call site), not inside the shared
 * helper, so it stays scoped to this caller only.
 */
export function nationalSlugBody(legacyPath, locale) {
  const m = legacyPath.match(LOCALE_CONFIG[locale].legacyBodyRx);
  if (!m) return null;
  let body = m[1];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    const query = body.replace(/-/g, ' ');
    const queryTokens = query.split(' ').filter(Boolean);
    if (
      queryTokens.length > 0 &&
      queryTokens.every((t) => SEARCH_QUERY_BOILERPLATE_TOKENS.has(t.toLowerCase()))
    ) {
      // Every remaining token is boilerplate noise (e.g. "lavoro", or
      // "offerte di lavoro") — no specific signal left, mirror the old
      // `body === p → body = ''` behavior instead of returning it unchanged.
      return null;
    }
    const strippedBody = stripSearchQueryBoilerplate(query).replace(/\s+/g, '-');
    if (strippedBody && strippedBody !== body) {
      body = strippedBody;
      changed = true;
      continue;
    }
    const first = body.split('-')[0];
    if (first && RELATED_SEARCH_JUNK_TERMS.has(first)) {
      body = body.slice(first.length + 1);
      changed = true;
    }
  }
  return body || null;
}

export async function fetchLiveClusterSet() {
  const live = new Set();
  for (let n = 1; n <= 20; n++) {
    const idx = String(n).padStart(3, '0');
    const url = `${BASE}/sitemap-search-clusters-${idx}.xml`;
    let xml;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT },
        signal: AbortSignal.timeout(DEFAULT_LIVE_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) break; // no more shards
      xml = await res.text();
    } catch {
      break;
    }
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      live.add(m[1].replace(BASE, ''));
    }
  }
  return live;
}

export function loadLiveFromFile(path) {
  return new Set(readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
}

async function main() {
  const args = process.argv.slice(2);
  const liveFileIdx = args.indexOf('--live-file');
  const live = liveFileIdx >= 0 ? loadLiveFromFile(args[liveFileIdx + 1]) : await fetchLiveClusterSet();
  if (live.size === 0) {
    console.error('No live cluster URLs loaded — aborting (would map everything to the board).');
    process.exit(2);
  }

  const verifyCity = !args.includes('--no-city-verify');
  const legacy = legacyClusterUrls(INDEXED);
  assertNonEmptyLegacyMap(legacy, INDEXED);
  const map = {};
  const byLocale = { it: 0, en: 0, de: 0, fr: 0 };
  let specific = 0;
  let cityPage = 0;
  let cityBoard = 0;
  let urlBoard = 0;
  const sortedLegacy = [...legacy.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Pass 1 (pure, no I/O): resolve each legacy URL down to either an
  // immediate "specific"/"board" target, or a city-page candidate that still
  // needs a liveness check. Kept separate from the fetch below so ALL city
  // checks can run concurrently instead of one `await` per loop iteration
  // (issue #6774 root cause: the old single sequential loop, combined with
  // an un-timed-out fetch in isLive(), let one slow/hanging check stall the
  // entire run past the workflow's 20min ceiling).
  const resolved = sortedLegacy.map(([oldUrl, locale]) => {
    const cfg = LOCALE_CONFIG[locale];
    const body = nationalSlugBody(oldUrl, locale);

    // 1) Specific live national cluster (de-junked role+city), best relevance.
    const national = body ? `${sectionRoot(locale, AGGREGATE_KEY)}/${cfg.searchPrefix}-${body}/` : null;
    if (national && live.has(national)) {
      return { oldUrl, locale, kind: 'specific', target: national };
    }

    // 2) City detected in the slug → the per-city job page in the city's REAL
    //    canton (e.g. "progetti morges" → /cerca-lavoro-vaud/morges/). Verified
    //    live per-URL (city pages are 200 but not sitemap-enumerable). The
    //    orphan URL's own canton is unreliable (these national clusters were
    //    ALL emitted under the legacy per-canton section regardless of the
    //    real city), so we resolve the city → its REAL canton from
    //    data/canton-municipalities.json, not from the URL.
    const rawBody = (oldUrl.match(/-(?:ricerca|search|suche|recherche)-(.+?)\/?$/)?.[1] || '');
    const city = detectTrailingCity(body) || detectTrailingCity(rawBody);
    if (city) {
      const cantonCode = cityToCantonCode.get(city);
      const cityUrl = `${sectionRoot(locale, cantonCode)}/${city}/`;
      // 3) City's REAL canton board (fixes the legacy ticino-prefix mislabel)
      //    is the fallback if the city page below turns out not to be live.
      return { oldUrl, locale, kind: 'city', cityUrl, cantonBoard: `${sectionRoot(locale, cantonCode)}/` };
    }

    // 4) No city signal (role-only national cluster, no live specific page) →
    //    the national board, in the SAME locale. NOT the URL's own canton:
    //    every legacy orphan carries the misleading legacy per-canton section
    //    prefix, so the national board is the honest generic home.
    return { oldUrl, locale, kind: 'board', target: `${sectionRoot(locale, AGGREGATE_KEY)}/` };
  });

  // Pass 2: warm the live-check cache for every DISTINCT city URL with
  // bounded concurrency instead of one fetch at a time in series.
  if (verifyCity) {
    const cityUrls = [...new Set(resolved.filter((r) => r.kind === 'city').map((r) => r.cityUrl))];
    await runWithConcurrency(cityUrls, LIVE_CHECK_CONCURRENCY, (cityUrl) => isLive(cityUrl));
  }

  // Pass 3: assemble the map from the resolved pieces + the now-warm cache.
  for (const r of resolved) {
    byLocale[r.locale]++;
    if (r.kind === 'specific') {
      map[r.oldUrl] = r.target;
      specific++;
      continue;
    }
    if (r.kind === 'board') {
      map[r.oldUrl] = r.target;
      urlBoard++;
      continue;
    }
    if (verifyCity && liveCache.get(r.cityUrl)) {
      map[r.oldUrl] = r.cityUrl;
      cityPage++;
    } else {
      map[r.oldUrl] = r.cantonBoard;
      cityBoard++;
    }
  }

  const total = specific + cityPage + cityBoard + urlBoard;
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        generated: 'see git author date',
        source: 'indexed-cluster-urls.json (it/en/de/fr) × live search-cluster sitemaps + per-city job pages',
        counts: {
          total,
          specific,
          cityPage,
          cityCantonBoard: cityBoard,
          urlCantonBoard: urlBoard,
          byLocale,
        },
        map,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `search-cluster-301-map: ${total} entries (it=${byLocale.it} en=${byLocale.en} de=${byLocale.de} fr=${byLocale.fr}) → ` +
    `${specific} specific clusters (${((100 * specific) / total).toFixed(1)}%), ${cityPage} per-city pages, ` +
    `${cityBoard} city-canton boards, ${urlBoard} national boards.`,
  );

  // Feed every resolved legacy URL into the seo-404-compat accumulator (issue
  // #4590 audit finding: 9922/9922 map entries were never accumulator-fed
  // since this script's creation, #2917 — legacyRedirectsPlugin.ts only emits
  // a real bridge/redirect page for paths present in readCompatPaths(), and
  // this map alone was never wired into that store). Computing a target for
  // `oldUrl` above IS the proof it's a dead legacy URL — no need to wait on
  // discover-404s-via-cloudflare.mjs (can't see these: they answer HTTP 200,
  // a soft-404 SPA fallback, never a real 4xx in the CF log it scans) or
  // discover-404s-via-inspection.mjs (never queues this URL family as an
  // inspection candidate at all).
  const compat = readCompatPaths(ROOT);
  const compatSet = new Set(compat.paths);
  const prevCompatCount = compatSet.size;
  for (const oldUrl of Object.keys(map)) compatSet.add(oldUrl);
  const addedCompatCount = compatSet.size - prevCompatCount;
  if (addedCompatCount > 0) {
    const updatedCompat = {
      ...compat,
      paths: [...compatSet].sort(),
      source: (compat.source || 'gsc-export').includes('search-cluster-301-map')
        ? compat.source
        : `${compat.source || 'gsc-export'}+search-cluster-301-map`,
      lastUpdated: new Date().toISOString().slice(0, 10),
    };
    assertCompatFloor(prevCompatCount, updatedCompat.paths.length, {
      floor: COMPAT_PATHS_SANITY_FLOOR,
      label: 'seo-404-compat (from build-search-cluster-301-map.mjs)',
    });
    writeCompatPaths(updatedCompat, ROOT);
  }
  console.log(
    `search-cluster-301-map: seo-404-compat accumulator +${addedCompatCount} new path` +
    `${addedCompatCount === 1 ? '' : 's'} (${compatSet.size} total).`,
  );
}

// Only build the map + hit the network when run as a CLI. Importing this
// module (e.g. the unit tests for `legacyClusterUrls`/`resolveLegacyUrlsArray`/
// `nationalSlugBody`, or the prune pass in scripts/prune-search-cluster-301-map.mjs,
// which needs its exported OUT/LOCALES/LOCALE_CONFIG/sectionRoot/
// fetchLiveClusterSet/loadLiveFromFile building blocks) must NOT trigger the
// live sitemap fetch or overwrite the committed map.
const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[build-search-cluster-301-map] fatal:', err.message);
    process.exitCode = 1;
  });
}
