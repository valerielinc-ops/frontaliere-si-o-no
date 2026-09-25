/**
 * cdn-chunk-graph.mjs — full JS/CSS chunk graph check for the live CDN.
 *
 * WHY THIS EXISTS
 * ---------------
 * Bundle files on cdn.frontaliereticino.ch have STABLE names (never content
 * hashed — tests/stable-asset-names.test.ts). A deploy re-uploads the changed
 * keys to R2 and purges exactly those keys (scripts/ci/purge-changed-cdn-assets.mjs).
 * When that purge misses a key, the edge keeps serving the previous
 * generation of it next to the new generation of its importers, and the
 * browser fails at module link time:
 *
 *     SyntaxError: './shared-services.js' does not provide an export named …
 *
 * 2026-09-25: deploy 36088944074 changed 3945 keys, the purge stopped at 1000,
 * `JobBoard.js` was new and `shared-services.js` old at the edge, and the job
 * board was down for ~1h30 (app_error ~40× baseline). 40 chunks were still at
 * their July version. The runtime watchdog was running, but it compared only
 * five hand-picked files — neither of those two — and the one stale file it
 * DID see that morning (`/assets/index.css`, run 36096588819) it refused to
 * purge because the build markers said "rollout in progress".
 *
 * WHAT IT DOES
 * ------------
 * 1. Fetches the entry pages of all four locales (home, calculator, job board,
 *    job-board listing + one job ad found on it, article index + one article
 *    found on it) and collects every CDN asset they reference.
 * 2. Walks the module graph from there: static imports, re-exports, dynamic
 *    `import()`, Vite's `__vite__mapDeps` preload lists (absolute CDN URLs),
 *    and relative `"./x.js"` literals (workers & co., discovery only).
 * 3. For every chunk, reads the edge copy in BOTH cache variants — with
 *    `Origin: https://frontaliereticino.ch` (the one a browser's module
 *    `<script crossorigin>` reads) and without it (curl, crawlers, CI) — and
 *    the origin copy through a cache-busted HEAD. HEAD is not answered from the
 *    edge cache on this zone (`cf-cache-status: DYNAMIC`, measured 2026-09-25),
 *    so it reads R2 without storing one cache entry per probe; the edge side
 *    has to be a GET for the same reason.
 * 4. Compares edge vs origin validators (ETag, then Last-Modified; body hash
 *    when a validator is missing) and link-checks every named/default import
 *    and re-export against the exports of the chunk the EDGE serves, per
 *    variant — the exact check the browser performs.
 *
 * The result carries `purgeUrls`: every chunk whose edge copy differs from R2
 * (or is a cached failure while R2 has it). A purge can only converge the edge
 * on R2, the single refill source, which is the state the deploy's own
 * per-key purge already intends after every upload.
 *
 * Read-only: this module never purges by itself (see purgeUrlsInBatches, which
 * the workflow invokes explicitly) and never prints response bodies.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Localized section slugs: imported from their single sources of truth rather
// than restated (AGENTS.md #6; the TI job-board slugs are also guarded by
// tests/seo/cathedral-no-ti-hardcodes.test.ts). Both modules are pure .mjs, so
// the watchdog keeps running under bare `node` without `npm ci`.
import { SECTION_LEGACY_TI } from '../../build-plugins/shared/cantonResolvers.mjs';
import { ARTICLE_SECTION_CORE } from '../../build-plugins/shared/articleSectionCore.mjs';
// The job board's "all offers" listing uses the same localized slug as the
// article archives (services/router.ts CANTON_HUB_EXACT_SLUGS lists
// tutti/all/alle/tous for the job sections).
import { ARCHIVE_ALL_SLUG } from '../lib/article-archive-assets.mjs';
// Cloudflare's `files` purge cap, shared with cf-purge-cache.mjs (which
// rejects longer lists) — batches must never exceed it.
import { MAX_TARGETED_FILES } from '../lib/cf-purge-limits.mjs';
// Which HTTP statuses are worth retrying, and how to read Retry-After: one
// definition for every fetch path in the repo (stdlib-only module).
import { RETRYABLE_STATUS, parseRetryAfterMs } from '../lib/transient-fetch.mjs';
// NOT imported from ./purge-changed-cdn-assets.mjs (its `batch` helper): that
// script's entry guard calls pathToFileURL(process.argv[1]) at module scope,
// which throws when the importer runs as `node --input-type=module` from a
// heredoc — exactly how runtime-reliability-watch.yml loads the watchdog.

export const SITE_ORIGIN = 'https://frontaliereticino.ch';
export const CDN_ASSETS_BASE = 'https://cdn.frontaliereticino.ch/assets/';
export const BROWSER_ORIGIN_HEADER = SITE_ORIGIN;
export const VARIANTS = /** @type {const} */ (['browser', 'plain']);

/** Chunks we fetch at most per run; beyond this the result is `truncated`. */
export const DEFAULT_MAX_CHUNKS = 2500;
/** Wall-clock budget for one crawl (the verify step runs a second one). */
export const DEFAULT_BUDGET_MS = 5 * 60_000;
/** Chunks in flight; each costs three requests (two edge GETs, one origin HEAD). */
export const DEFAULT_CONCURRENCY = 4;
/** Per-request timeout; transient failures (timeout, network, 5xx) retry twice. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Ceiling of URLs one run may purge — the same bound the deploy's own
 * changed-key purge applies (MAX_KEYS_PER_RUN in purge-changed-cdn-assets.mjs):
 * 100 `files` calls per variant, well inside Cloudflare's purge rate limit.
 */
export const MAX_PURGE_URLS_PER_RUN = 3000;
/**
 * A module with more dynamic imports than this is a CONTENT loader, not
 * application code: `blogBodyLoader.js` alone maps 24,724 article-body chunks
 * (`<slug>.<locale>.js`, each `export default` of prose), measured 2026-09-25.
 * Walking all of them on every run costs ~75k requests and ~15 minutes, twice
 * with the post-purge verification, and ~24k R2 reads per pass — for leaves
 * whose staleness shows old prose, never a link error (the loader only reads
 * `.default`). Their targets are therefore covered by a rotating window:
 * `DEFAULT_FANOUT_SAMPLE` per run, a different window every hour, so the
 * whole family is walked within ceil(n / sample) runs. The ~270 code chunks
 * are always checked in full.
 */
export const FANOUT_SAMPLE_THRESHOLD = 400;
export const DEFAULT_FANOUT_SAMPLE = 1000;
/** One rotation step per hour: consecutive runs land on different windows. */
export function defaultRotation(nowMs = Date.now()) {
  return Math.floor(nowMs / 3_600_000);
}
const TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 400;
const USER_AGENT = 'FrontaliereTicino-RuntimeReliability/1.0 (+https://frontaliereticino.ch)';
// Explicit, and without zstd: Node's fetch does not decode it.
const ACCEPT_ENCODING = 'gzip, deflate, br';

// Salary calculator section, per locale (services/router.ts tab slugs; the
// same values scripts/probe-urls.txt and llms-txt-generator.mjs use).
const CALCULATOR_SLUG = { it: 'calcola-stipendio', en: 'calculate-salary', de: 'gehalt-berechnen', fr: 'calculer-salaire' };

function localePrefix(locale) {
  return locale === 'it' ? '' : `/${locale}`;
}

function escapeRx(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Entry pages, per locale. `derive` pages are not fixed URLs: the first link on
 * the parent page matching `pattern` is followed (a job ad, an article), so the
 * check always exercises a page that exists today.
 */
export function buildEntryPages(locales = ['it', 'en', 'de', 'fr']) {
  const pages = [];
  for (const locale of locales) {
    const prefix = localePrefix(locale);
    const jobs = `${prefix}/${SECTION_LEGACY_TI[locale]}/`;
    const jobsAll = `${jobs}${ARCHIVE_ALL_SLUG[locale]}/`;
    const articles = `${prefix}/${ARTICLE_SECTION_CORE.frontaliere.indexSlug[locale]}/`;
    pages.push(
      { locale, kind: 'home', path: `${prefix}/` },
      { locale, kind: 'calculator', path: `${prefix}/${CALCULATOR_SLUG[locale]}/` },
      { locale, kind: 'jobs', path: jobs },
      {
        locale,
        kind: 'jobs-all',
        path: jobsAll,
        derive: {
          kind: 'job-ad',
          // A job ad is a single slug under the section, emitted WITHOUT the
          // trailing slash; category/listing pages always carry one.
          pattern: new RegExp(`^${escapeRx(jobs)}[a-z0-9]+(?:-[a-z0-9]+){2,}$`),
        },
      },
      {
        locale,
        kind: 'articles',
        path: articles,
        derive: {
          kind: 'article',
          pattern: new RegExp(`^${escapeRx(articles)}[a-z0-9]+(?:-[a-z0-9]+){2,}/$`),
        },
      },
    );
  }
  return pages;
}

export const CHUNK_GRAPH_ENTRY_PAGES = buildEntryPages();

// ── Parsing ────────────────────────────────────────────────────────────────

const ASSET_EXT_RX = /\.(?:m?js|css)$/;

/** Canonical form of a CDN asset URL (no query, no fragment), or null. */
export function normalizeAssetUrl(raw, base = CDN_ASSETS_BASE) {
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  const assets = new URL(CDN_ASSETS_BASE);
  if (url.origin !== assets.origin || !url.pathname.startsWith(assets.pathname)) return null;
  if (!ASSET_EXT_RX.test(url.pathname)) return null;
  return `${url.origin}${url.pathname}`;
}

// The lookahead refuses a longer file name (`App.js.map` is not `App.js`).
const ABSOLUTE_ASSET_RX = /https:\/\/cdn\.frontaliereticino\.ch\/assets\/[A-Za-z0-9_./-]+?\.(?:m?js|css)(?![A-Za-z0-9_.-])/g;

/** Every CDN JS/CSS asset an HTML document references (script, preload, stylesheet, inline). */
export function extractAssetUrlsFromHtml(html) {
  const out = new Set();
  for (const match of String(html || '').matchAll(ABSOLUTE_ASSET_RX)) {
    const url = normalizeAssetUrl(match[0]);
    if (url) out.add(url);
  }
  return [...out];
}

/** Same-site `href` paths of an HTML document, in document order. */
export function extractSitePaths(html, siteOrigin = SITE_ORIGIN) {
  const out = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/href\s*=\s*"([^"#?]+)"/g)) {
    let path = match[1];
    if (path.startsWith(siteOrigin)) path = path.slice(siteOrigin.length);
    if (!path.startsWith('/') || path.startsWith('//')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function namesFromClause(clause, side) {
  // `a as b` → import side reads `a`, export side names `b`.
  return String(clause || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const pieces = part.split(/\s+as\s+/);
      const name = side === 'local' ? pieces[0] : pieces[pieces.length - 1];
      return name.replace(/^["']|["']$/g, '').trim();
    })
    .filter(Boolean);
}

const STRING = String.raw`"([^"\n]+)"|'([^'\n]+)'`;
// One static import declaration at the current position (sticky).
const IMPORT_DECL_RX = new RegExp(
  String.raw`import\s*(?:(?:([A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:\{([^}]*)\}|\*\s*as\s*[A-Za-z_$][\w$]*)?\s*from\s*)?(?:${STRING})\s*;?`,
  'y',
);

function skipTrivia(source, start) {
  let p = start;
  for (;;) {
    while (p < source.length && /\s/.test(source[p])) p++;
    if (source.startsWith('//', p)) {
      const end = source.indexOf('\n', p);
      p = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', p)) {
      const end = source.indexOf('*/', p + 2);
      p = end < 0 ? source.length : end + 2;
      continue;
    }
    return p;
  }
}

/**
 * Parse the linking surface of a Rollup/Vite ES chunk.
 *
 * Static imports are read from the module PROLOGUE only — the run of import
 * declarations Rollup emits at the top of every chunk, after Vite's optional
 * `const __vite__mapDeps=…;` line. Reading them anywhere in the file would let
 * a code sample inside a string literal masquerade as a dependency and file a
 * false "missing export".
 *
 * @returns {{
 *   imports: Array<{ url: string, spec: string, names: string[], kind: 'static' | 'dynamic' | 'reexport' | 'reexport-all' | 'preload' | 'loose' }>,
 *   exports: string[],
 *   exportAll: string[],
 * }}
 */
export function parseModuleLinks(source, moduleUrl) {
  const text = String(source || '');
  const imports = [];
  const exports = new Set();
  const exportAll = [];
  const seenRefs = new Set();
  const addRef = (spec, kind, names = []) => {
    const url = normalizeAssetUrl(spec, moduleUrl);
    if (!url) return;
    imports.push({ url, spec, names, kind });
    seenRefs.add(url);
  };

  // Prologue: static import declarations.
  let p = skipTrivia(text, 0);
  if (text.startsWith('const __vite__mapDeps', p)) {
    const end = text.indexOf('\n', p);
    p = skipTrivia(text, end < 0 ? text.length : end + 1);
  }
  for (;;) {
    IMPORT_DECL_RX.lastIndex = p;
    const m = IMPORT_DECL_RX.exec(text);
    if (!m) break;
    const [, defaultName, namedClause, dq, sq] = m;
    const names = [];
    if (defaultName) names.push('default');
    if (namedClause !== undefined) names.push(...namesFromClause(namedClause, 'local'));
    addRef(dq ?? sq, 'static', names);
    p = skipTrivia(text, IMPORT_DECL_RX.lastIndex);
  }

  // Exports and re-exports, at statement boundaries anywhere in the file
  // (Rollup emits them last). A spurious extra export can only hide a
  // defect, never invent one, so this side may scan the whole text.
  const exportRx = /(?:^|[;}\n])\s*export\s*(\{([^}]*)\}\s*(?:from\s*(?:"([^"\n]+)"|'([^'\n]+)'))?|\*\s*(?:as\s*([A-Za-z_$][\w$]*)\s*)?from\s*(?:"([^"\n]+)"|'([^'\n]+)')|default\b|(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/g;
  for (const m of text.matchAll(exportRx)) {
    const [, head, clause, fromDq, fromSq, starAs, starDq, starSq, fnName, className, varName] = m;
    if (clause !== undefined) {
      for (const name of namesFromClause(clause, 'exported')) exports.add(name);
      const from = fromDq ?? fromSq;
      if (from) addRef(from, 'reexport', namesFromClause(clause, 'local'));
    } else if (starDq ?? starSq) {
      if (starAs) {
        exports.add(starAs);
        addRef(starDq ?? starSq, 'reexport', []);
      } else {
        const url = normalizeAssetUrl(starDq ?? starSq, moduleUrl);
        if (url) exportAll.push(url);
        addRef(starDq ?? starSq, 'reexport-all', []);
      }
    } else if (head.startsWith('default')) {
      exports.add('default');
    } else {
      const name = fnName || className || varName;
      if (name) exports.add(name);
    }
  }

  // Dynamic imports: existence matters (a lazy route 404s), names cannot be
  // known statically.
  for (const m of text.matchAll(/\bimport\(\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*\)/g)) {
    addRef(m[1] ?? m[2], 'dynamic');
  }
  // Vite preload lists (`__vite__mapDeps`) carry absolute CDN URLs.
  for (const m of text.matchAll(ABSOLUTE_ASSET_RX)) {
    const url = normalizeAssetUrl(m[0]);
    if (url && !seenRefs.has(url)) addRef(m[0], 'preload');
  }
  // Remaining relative literals (`new URL("./worker.js", import.meta.url)`,
  // hand-written loaders): discovery only — a false match merely 404s.
  for (const m of text.matchAll(/["'`](\.\.?\/[A-Za-z0-9_./-]+?\.(?:m?js|css))["'`]/g)) {
    const url = normalizeAssetUrl(m[1], moduleUrl);
    if (url && !seenRefs.has(url)) addRef(m[1], 'loose');
  }

  return { imports, exports: [...exports], exportAll };
}

/** Reference kinds whose target MUST exist for the page to work. */
export const STRONG_REF_KINDS = new Set(['static', 'reexport', 'reexport-all', 'dynamic', 'preload']);

// ── Validators ─────────────────────────────────────────────────────────────

function normalizeEtag(value) {
  if (!value) return null;
  return String(value).trim().replace(/^W\//i, '').replace(/^"|"$/g, '') || null;
}

/**
 * Compare one edge observation with the origin (R2) observation.
 * Validators first (ETag, then Last-Modified); body hash only as a fallback.
 */
export function classifyEdgeVsOrigin(edge, origin) {
  // No answer, rate limited or challenged (see isInconclusive): nothing is
  // known about the cached copy, so neither "stale" nor purgeable.
  if (isInconclusive(edge) || isInconclusive(origin)) return 'error';
  const edgeOk = Boolean(edge?.ok);
  const originOk = Boolean(origin?.ok);
  if (!edgeOk && originOk) return 'cached_failure';
  if (edgeOk && !originOk) return 'fresh_failure';
  if (!edgeOk && !originOk) return 'unavailable';
  const edgeTag = normalizeEtag(edge.etag);
  const originTag = normalizeEtag(origin.etag);
  if (edgeTag && originTag) return edgeTag === originTag ? 'healthy' : 'stale';
  if (edge.lastModified && origin.lastModified) {
    return Date.parse(edge.lastModified) === Date.parse(origin.lastModified) ? 'healthy' : 'stale';
  }
  if (edge.hash && origin.hash) return edge.hash === origin.hash ? 'healthy' : 'stale';
  return 'unverifiable';
}

/** States a targeted purge can repair: the edge disagrees with an R2 copy that exists. */
export const PURGEABLE_STATES = new Set(['stale', 'cached_failure']);

// ── Link check ─────────────────────────────────────────────────────────────

/**
 * Resolve the export set of `url` in one variant, following `export *`.
 * Returns null when the module is not JavaScript or was not served.
 */
function exportsOf(url, modules, cache, stack = new Set()) {
  if (cache.has(url)) return cache.get(url);
  const mod = modules.get(url);
  if (!mod) return null;
  if (stack.has(url)) return new Set(mod.exports);
  stack.add(url);
  const names = new Set(mod.exports);
  for (const dep of mod.exportAll) {
    const sub = exportsOf(dep, modules, cache, stack);
    if (sub) for (const name of sub) if (name !== 'default') names.add(name);
  }
  stack.delete(url);
  cache.set(url, names);
  return names;
}

/**
 * Static link check of one variant of the graph.
 *
 * @param {Map<string, { exports: string[], exportAll: string[], imports: Array<{url: string, names: string[], kind: string}> }>} modules
 *   parsed JS modules actually served in this variant (non-200 → absent)
 * @param {Map<string, boolean>} served  url → whether this variant answered 200
 * @returns {Array<{ from: string, to: string, name: string | null, reason: 'missing_export' | 'missing_module' }>}
 */
export function linkCheck(modules, served) {
  const broken = [];
  const cache = new Map();
  for (const [from, mod] of modules) {
    for (const ref of mod.imports) {
      if (!STRONG_REF_KINDS.has(ref.kind)) continue;
      if (served.get(ref.url) === false) {
        broken.push({ from, to: ref.url, name: null, reason: 'missing_module' });
        continue;
      }
      if (!ref.names.length || !/\.m?js$/.test(ref.url)) continue;
      const names = exportsOf(ref.url, modules, cache);
      if (!names) continue;
      for (const name of ref.names) {
        if (!names.has(name)) broken.push({ from, to: ref.url, name, reason: 'missing_export' });
      }
    }
  }
  return broken;
}

// ── Crawl ──────────────────────────────────────────────────────────────────

/**
 * The `rotation`-th window of `size` items over the sorted list. Windows tile
 * the list, so rotations 0..ceil(n/size)-1 cover every item exactly once.
 */
export function rotatingWindow(items, size, rotation) {
  const sorted = [...new Set(items)].sort();
  if (sorted.length <= size) return { picked: sorted, start: 0, index: 0, windows: 1 };
  const windows = Math.ceil(sorted.length / size);
  const index = ((Math.trunc(Number(rotation) || 0) % windows) + windows) % windows;
  const start = index * size;
  return { picked: sorted.slice(start, start + size), start, index, windows };
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function cacheBust(url, nonce) {
  const parsed = new URL(url);
  parsed.searchParams.set('ft_reliability', nonce);
  return parsed.href;
}

function coloOf(headers) {
  const ray = headers?.get?.('cf-ray') || '';
  const idx = ray.lastIndexOf('-');
  return idx > 0 ? ray.slice(idx + 1) : null;
}

/**
 * An observation that says nothing about the object: no HTTP answer (timeout,
 * network), rate limiting, or a Cloudflare challenge in front of it. The
 * runner shares datacenter IPs, so a 429/challenge is a property of the
 * PROBE, not of the edge copy — it must never read as a "cached failure" and
 * trigger a purge.
 */
export function isInconclusive(obs) {
  return !obs || obs.status === 0 || obs.status === 429 || Boolean(obs.mitigated);
}

/**
 * One HTTP observation with bounded retries on transient failures (network
 * error, timeout, and RETRYABLE_STATUS: 408/425/429/5xx). Other answers are
 * final.
 */
export async function observe(url, {
  fetchImpl = fetch,
  method = 'GET',
  origin = null,
  readBody = method === 'GET',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = TRANSIENT_RETRIES,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryAfterMs = 0;
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/javascript,text/css,*/*;q=0.8',
          'Accept-Encoding': ACCEPT_ENCODING,
          ...(origin ? { Origin: origin } : {}),
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      const body = readBody && method !== 'HEAD' ? await response.text() : null;
      const headers = response.headers;
      const result = {
        status: response.status,
        ok: response.ok,
        etag: headers?.get?.('etag') || null,
        lastModified: headers?.get?.('last-modified') || null,
        cacheStatus: headers?.get?.('cf-cache-status') || null,
        age: headers?.get?.('age') || null,
        colo: coloOf(headers),
        mitigated: headers?.get?.('cf-mitigated') || null,
        body,
        hash: response.ok && body !== null ? sha256(body) : null,
        error: null,
      };
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) return result;
      last = { ...result, error: `HTTP ${response.status}` };
      if (response.status === 429) {
        // Short cap: the whole walk has a 5-minute budget.
        retryAfterMs = parseRetryAfterMs(headers?.get?.('retry-after'), { capMs: 5_000 }) ?? 2_000;
      }
    } catch (error) {
      last = {
        status: 0,
        ok: false,
        etag: null,
        lastModified: null,
        cacheStatus: null,
        age: null,
        colo: null,
        mitigated: null,
        body: null,
        hash: null,
        error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error),
      };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(Math.max(retryAfterMs, RETRY_DELAY_MS * (attempt + 1)));
  }
  return last;
}

function publicObservation(obs) {
  if (!obs) return null;
  const { body: _body, ...rest } = obs;
  return rest;
}

async function runPool(worker, { concurrency, next, deadline, now }) {
  let active = 0;
  let stopped = false;
  return new Promise((resolve) => {
    const pump = () => {
      if (!stopped && now() > deadline) stopped = true;
      while (!stopped && active < concurrency) {
        const item = next();
        if (item === undefined) break;
        active++;
        Promise.resolve(worker(item))
          .catch(() => {})
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0) resolve({ stopped });
    };
    pump();
  });
}

/**
 * Crawl the live graph. Network only through `fetchImpl`, so tests drive it
 * with a fake CDN.
 */
export async function crawlChunkGraph({
  fetchImpl = fetch,
  siteOrigin = SITE_ORIGIN,
  entryPages = CHUNK_GRAPH_ENTRY_PAGES,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  budgetMs = DEFAULT_BUDGET_MS,
  maxChunks = DEFAULT_MAX_CHUNKS,
  fanoutThreshold = FANOUT_SAMPLE_THRESHOLD,
  fanoutSample = DEFAULT_FANOUT_SAMPLE,
  rotation = defaultRotation(),
  nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  now = () => Date.now(),
  sleep,
} = {}) {
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  const obsOpts = { fetchImpl, timeoutMs, ...(sleep ? { sleep } : {}) };

  // 1. Entry pages (+ one derived page each where configured).
  const entries = [];
  const seeds = new Map(); // url → first entry path that referenced it
  const addSeeds = (path, html) => {
    const urls = extractAssetUrlsFromHtml(html);
    for (const url of urls) if (!seeds.has(url)) seeds.set(url, path);
    return urls.length;
  };
  await runPool(async (page) => {
    const obs = await observe(`${siteOrigin}${page.path}`, obsOpts);
    const entry = {
      locale: page.locale,
      kind: page.kind,
      path: page.path,
      status: obs.status,
      error: obs.error,
      inconclusive: isInconclusive(obs),
      assets: obs.ok ? addSeeds(page.path, obs.body) : 0,
      derived: null,
    };
    entries.push(entry);
    if (obs.ok && page.derive) {
      const target = extractSitePaths(obs.body, siteOrigin).find((p) => page.derive.pattern.test(p));
      if (!target) {
        entry.derived = { kind: page.derive.kind, path: null, status: 0, error: 'no matching link on the page', assets: 0 };
      } else {
        const sub = await observe(`${siteOrigin}${target}`, obsOpts);
        entry.derived = {
          kind: page.derive.kind,
          path: target,
          status: sub.status,
          error: sub.error,
          assets: sub.ok ? addSeeds(target, sub.body) : 0,
        };
      }
    }
  }, {
    concurrency,
    next: (() => { let i = 0; return () => (i < entryPages.length ? entryPages[i++] : undefined); })(),
    deadline,
    now,
  });
  entries.sort((a, b) => (a.locale + a.kind).localeCompare(b.locale + b.kind));

  // 2. Breadth-first walk of the chunk graph.
  const queue = [...seeds.keys()];
  const referencedBy = new Map([...seeds].map(([url, path]) => [url, { from: path, kind: 'html' }]));
  const strongRefs = new Set(seeds.keys());
  const chunks = new Map();
  const modules = { browser: new Map(), plain: new Map() };
  const families = new Map(); // content loader url → sampling window
  let truncated = false;
  let cursor = 0;

  const enqueue = (ref, from) => {
    if (STRONG_REF_KINDS.has(ref.kind)) strongRefs.add(ref.url);
    if (referencedBy.has(ref.url)) return;
    referencedBy.set(ref.url, { from, kind: ref.kind });
    queue.push(ref.url);
  };

  const pool = await runPool(async (url) => {
    const [browser, plain, originHead] = await Promise.all([
      observe(url, { ...obsOpts, origin: BROWSER_ORIGIN_HEADER }),
      observe(url, obsOpts),
      observe(cacheBust(url, nonce), { ...obsOpts, method: 'HEAD' }),
    ]);
    let origin = originHead;
    const hasValidators = (o) => Boolean(o?.etag || o?.lastModified);
    if (origin.ok && (!hasValidators(origin) || !hasValidators(browser) || !hasValidators(plain))) {
      // No comparable validator: fall back to a cache-busted GET body hash.
      origin = await observe(cacheBust(url, `${nonce}-body`), obsOpts);
    }
    const record = {
      url,
      path: new URL(url).pathname,
      origin: publicObservation(origin),
      variants: {},
      states: {},
    };
    let previous = null;
    for (const [variant, obs] of [['browser', browser], ['plain', plain]]) {
      record.variants[variant] = publicObservation(obs);
      record.states[variant] = classifyEdgeVsOrigin(obs, origin);
      if (obs.ok && /\.m?js$/.test(url)) {
        // Both variants usually carry the same bytes: parse them once.
        const parsed = previous && previous.hash === obs.hash
          ? previous.parsed
          : parseModuleLinks(obs.body, url);
        previous = { hash: obs.hash, parsed };
        modules[variant].set(url, parsed);
        const dynamic = parsed.imports.filter((ref) => ref.kind === 'dynamic').map((ref) => ref.url);
        let sampled = null;
        if (dynamic.length > fanoutThreshold) {
          const window = rotatingWindow(dynamic, fanoutSample, rotation);
          sampled = new Set(window.picked);
          if (!families.has(url)) {
            families.set(url, {
              loader: new URL(url).pathname,
              total: new Set(dynamic).size,
              sampled: window.picked.length,
              window: window.index,
              windows: window.windows,
              rotation,
            });
          }
        }
        for (const ref of parsed.imports) {
          if (sampled && ref.kind === 'dynamic' && !sampled.has(ref.url)) continue;
          enqueue(ref, url);
        }
      }
    }
    chunks.set(url, record);
  }, {
    concurrency,
    next: () => {
      if (cursor >= queue.length) return undefined;
      if (cursor >= maxChunks) {
        truncated = true;
        return undefined;
      }
      return queue[cursor++];
    },
    deadline,
    now,
  });
  if (pool.stopped || cursor < queue.length) truncated = true;

  // 3. Link check per variant, on what the EDGE serves.
  const broken = [];
  for (const variant of VARIANTS) {
    // true = 200, false = definitive HTTP failure; an inconclusive observation
    // (timeout, 429, challenge) proves nothing and is left out of the check.
    const served = new Map();
    for (const [url, rec] of chunks) {
      const obs = rec.variants[variant];
      if (obs?.ok) served.set(url, true);
      else if (!isInconclusive(obs)) served.set(url, false);
    }
    for (const item of linkCheck(modules[variant], served)) broken.push({ ...item, variant });
  }

  // How many named bindings the link check actually verified, per variant: a
  // parser that silently stopped matching Rollup's output would show up here
  // as a collapse to zero long before anyone missed a real break.
  const namedImports = {};
  for (const variant of VARIANTS) {
    namedImports[variant] = 0;
    for (const mod of modules[variant].values()) {
      for (const ref of mod.imports) if (ref.kind === 'static' || ref.kind === 'reexport') namedImports[variant] += ref.names.length;
    }
  }

  const chunkList = [...chunks.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const rec of chunkList) {
    rec.strong = strongRefs.has(rec.url);
    rec.referencedBy = referencedBy.get(rec.url) || null;
  }
  return {
    checkedAt: new Date(startedAt).toISOString(),
    durationMs: now() - startedAt,
    entries,
    chunks: chunkList,
    broken,
    truncated,
    pending: Math.max(0, queue.length - cursor),
    families: [...families.values()],
    namedImports,
    colos: [...new Set(chunkList.flatMap((rec) => VARIANTS.map((v) => rec.variants[v]?.colo)).filter(Boolean))],
  };
}

// ── Verdict ────────────────────────────────────────────────────────────────

/**
 * Turn a crawl into a verdict: what is broken, what a targeted purge can fix.
 * Pure — the unit tests feed it hand-built crawls.
 */
export function evaluateChunkGraph(crawl) {
  const reasons = [];
  const entries = crawl?.entries || [];
  const chunks = crawl?.chunks || [];
  const broken = crawl?.broken || [];

  const failedEntries = entries.filter((entry) => !(entry.status >= 200 && entry.status < 300));
  const warnings = [];
  for (const entry of failedEntries) {
    const line = `chunk graph entry ${entry.path}: ${entry.error || `HTTP ${entry.status}`}`;
    // An entry the runner could not observe (timeout, 429, challenge) narrows
    // coverage; one that answered 404/5xx is a finding.
    if (entry.inconclusive) warnings.push(line);
    else reasons.push(line);
  }
  // A derived page that cannot be found only narrows coverage; it is reported
  // as a warning, not as a site failure.
  warnings.push(...entries
    .filter((entry) => entry.derived && !(entry.derived.status >= 200 && entry.derived.status < 300))
    .map((entry) => `chunk graph: no ${entry.derived.kind} checked from ${entry.path} (${entry.derived.error || `HTTP ${entry.derived.status}`})`));

  if (crawl?.error) reasons.push(`chunk graph: walk failed (${crawl.error})`);
  else if (chunks.length === 0) reasons.push('chunk graph: no CDN chunk discovered from the entry pages');
  if (crawl?.truncated) reasons.push(`chunk graph: coverage truncated (${chunks.length} checked, ${crawl.pending || 0} pending)`);

  const divergent = [];
  const originMissing = [];
  const missingBoth = [];
  let unverifiable = 0;
  let errors = 0;
  for (const rec of chunks) {
    const states = VARIANTS.map((v) => rec.states?.[v]);
    const purgeable = VARIANTS.filter((v) => PURGEABLE_STATES.has(rec.states?.[v]));
    if (purgeable.length) divergent.push({ url: rec.url, path: rec.path, variants: purgeable, states: rec.states });
    if (states.includes('fresh_failure') && rec.strong) originMissing.push(rec.path);
    if (states.every((s) => s === 'unavailable') && rec.strong) missingBoth.push(rec.path);
    if (states.includes('unverifiable')) unverifiable++;
    if (states.includes('error')) errors++;
  }
  // A few unanswered / rate-limited requests are noise; many mean the graph
  // was not really observed, which must not pass for health.
  const errorBudget = Math.max(5, Math.ceil(chunks.length * 0.05));
  if (errors > errorBudget) {
    reasons.push(`chunk graph: ${errors} of ${chunks.length} chunk(s) could not be observed (timeout/network/429/challenge)`);
  } else if (errors) {
    warnings.push(`chunk graph: ${errors} chunk(s) could not be observed (timeout/network/429/challenge)`);
  }
  if (divergent.length) {
    const count = (variant) => divergent.filter((d) => d.variants.includes(variant)).length;
    reasons.push(`chunk graph: ${divergent.length} chunk(s) differ edge vs origin (browser variant ${count('browser')}, plain ${count('plain')}): ${divergent.slice(0, 8).map((d) => d.path).join(', ')}${divergent.length > 8 ? ', …' : ''}`);
  }
  if (originMissing.length) {
    reasons.push(`chunk graph: ${originMissing.length} referenced chunk(s) served by the edge but missing at origin (not purged): ${originMissing.slice(0, 8).join(', ')}`);
  }
  if (missingBoth.length) {
    reasons.push(`chunk graph: ${missingBoth.length} referenced chunk(s) missing at edge and origin: ${missingBoth.slice(0, 8).join(', ')}`);
  }
  // Missing modules are already reported above per chunk; the named-import
  // breaks are the browser-visible SyntaxError.
  const exportBreaks = broken.filter((b) => b.reason === 'missing_export');
  if (exportBreaks.length) {
    const sample = exportBreaks.slice(0, 5).map((b) => `${new URL(b.from).pathname} → ${new URL(b.to).pathname} lacks '${b.name}' (${b.variant})`);
    reasons.push(`chunk graph: ${exportBreaks.length} broken named import(s): ${sample.join('; ')}`);
  }
  if (unverifiable) warnings.push(`chunk graph: ${unverifiable} chunk(s) without a comparable validator or body`);

  // Purge order: chunks on a broken link first (both ends), then the rest.
  const onBrokenLink = new Set(broken.flatMap((b) => [b.from, b.to]));
  const ordered = [
    ...divergent.filter((d) => onBrokenLink.has(d.url)),
    ...divergent.filter((d) => !onBrokenLink.has(d.url)),
  ].map((d) => d.url);
  const purgeUrls = ordered.slice(0, MAX_PURGE_URLS_PER_RUN);
  if (ordered.length > purgeUrls.length) {
    warnings.push(`chunk graph: ${ordered.length - purgeUrls.length} divergent chunk(s) over the ${MAX_PURGE_URLS_PER_RUN}-URL purge ceiling left for the next run`);
  }

  return {
    ok: reasons.length === 0,
    checked: chunks.length,
    entries: entries.length,
    divergent,
    broken,
    purgeUrls,
    reasons,
    warnings,
  };
}

/** Compact, stable identity of a graph verdict for the repair circuit. */
export function chunkGraphSignature(verdict) {
  if (!verdict) return null;
  return {
    broken: (verdict.broken || []).map((b) => `${b.variant}:${b.from}>${b.to}:${b.name ?? '*'}:${b.reason}`).sort(),
    divergent: (verdict.divergent || []).map((d) => `${d.url}:${[...d.variants].sort().join('+')}`).sort(),
    reasons: [...(verdict.reasons || [])].sort(),
  };
}

// ── Purge ──────────────────────────────────────────────────────────────────

/**
 * Purge `urls` through scripts/cf-purge-cache.mjs `--files=` in batches of at
 * most MAX_TARGETED_FILES. That script clears both cache variants (with and
 * without `Origin`) and never falls back to `purge_everything` in files mode.
 *
 * @returns {{ batches: number, purged: number, failed: Array<{ index: number, error: string }> }}
 */
export function purgeUrlsInBatches(urls, {
  exec = (args) => execFileSync(process.execPath, args, { stdio: 'inherit' }),
  purgeScript = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cf-purge-cache.mjs'),
  size = MAX_TARGETED_FILES,
} = {}) {
  const unique = [...new Set((urls || []).filter(Boolean))];
  const step = Math.max(1, Math.min(size, MAX_TARGETED_FILES));
  const batches = [];
  for (let i = 0; i < unique.length; i += step) batches.push(unique.slice(i, i + step));
  const failed = [];
  let purged = 0;
  for (const [index, group] of batches.entries()) {
    try {
      exec([purgeScript, `--files=${group.join(',')}`]);
      purged += group.length;
    } catch (error) {
      failed.push({ index, error: String(error?.message || error) });
    }
  }
  return { batches: batches.length, purged, failed };
}
