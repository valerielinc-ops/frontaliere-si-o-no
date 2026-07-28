#!/usr/bin/env node
/**
 * Scheduled Facebook poster for new blog articles (frontaliere + svizzera).
 *
 * This is the SOLE automated path that announces new articles on the Facebook
 * Page. Previously articles were posted only as a side-effect of the
 * generate-article → deploy (`workflow_dispatch`) chain, gated inside
 * `post-deploy-publish.yml` — so any article created outside that exact path
 * (manual deploy, batch-faq, a missed gate) was never posted. This cron is a
 * standalone, ledger-deduped poster, mirroring the jobs scheduler
 * (`schedule-fb-jobs-daily.mjs`): it reads the article registries, picks the
 * most-recent never-posted articles within a recency window, posts them
 * immediately to `/{pageId}/feed`, and records them in
 * `data/fb-posted-articles.json` to dedup across runs.
 *
 * Why a recency window + per-run cap (and not the whole back-catalog): with an
 * empty ledger EVERY article looks "unposted". `FB_ARTICLE_MAX_AGE_DAYS`
 * (default 2) bounds candidates to genuinely-new articles, and
 * `FB_ARTICLE_VOLUME` (default 4) caps posts per run, so even the very first
 * run can't flood the Page. Old articles are intentionally never back-filled.
 *
 * Metadata is parsed from the persisted source-of-truth files (no TS compile):
 *   - id / category / date  → data/{blog,swiss}-articles-data.ts registries
 *   - IT URL slug           → services/router{Blog,Swiss}Data.ts
 *   - og title / excerpt    → services/locales/blog-meta{,-ch}-it.ts
 * (the same regex-extraction approach generate-article.yml already uses).
 *
 * Usage:
 *   FB_PAGE_ID=… FB_PAGE_ACCESS_TOKEN=… node scripts/schedule-fb-articles-daily.mjs
 *
 * Env:
 *   FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN — Graph API credentials (required to post).
 *   FB_ARTICLE_VOLUME=N      — max posts per run, default 4.
 *   FB_ARTICLE_MAX_AGE_DAYS=N — only consider articles dated within N days, default 2.
 *   DRY_RUN=1                — log payloads, no API call.
 *
 * Soft-fail: every error path logs and the CLI `process.exit(0)`s. The
 * workflow's commit step is gated on the ledger mutating, so a no-op run
 * leaves git untouched.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildArticleUrl,
  buildArticleCaption,
  loadLedger,
  appendLedger,
  ARTICLE_PLACE_ID,
  isLandingPageLive,
} from './lib/social-post-utils.mjs';
import { ARTICLE_SECTION_CORE } from '../build-plugins/shared/articleSectionCore.mjs';

export { buildArticleUrl, buildArticleCaption } from './lib/social-post-utils.mjs';

// ── Constants ───────────────────────────────────────────────

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const POSTED_TRIM_LIMIT = 1000;
const DEFAULT_VOLUME = 4;
const DEFAULT_MAX_AGE_DAYS = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Per-section source files. Sourced from ARTICLE_SECTION_CORE (issue #4881
// Fase 6, AGENTS.md #6) — the same canonical tuple services/articleSections.ts
// re-exports as ARTICLE_SECTIONS + the inline hub map in generate-article.yml
// — kept here as plain data (via a plain-data .mjs import, not TS) so this
// script needs no TS compilation.
export const SECTIONS = [
  {
    section: 'frontaliere',
    registry: ARTICLE_SECTION_CORE.frontaliere.registryFile,
    slugFile: ARTICLE_SECTION_CORE.frontaliere.slugDataFile,
    metaFile: `services/locales/${ARTICLE_SECTION_CORE.frontaliere.metaPrefix}-it.ts`,
  },
  {
    section: 'svizzera',
    registry: ARTICLE_SECTION_CORE.svizzera.registryFile,
    slugFile: ARTICLE_SECTION_CORE.svizzera.slugDataFile,
    metaFile: `services/locales/${ARTICLE_SECTION_CORE.svizzera.metaPrefix}-it.ts`,
  },
];

// ── Path helpers ────────────────────────────────────────────

function defaultRepoRoot() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '..');
}

function postedPath(repoRoot) {
  return resolve(repoRoot, 'data', 'fb-posted-articles.json');
}

// ── Source-file parsers (exported for tests) ────────────────

function readFileOrEmpty(file) {
  try {
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Parse `{ id, category, date }` from an article registry TS module
 * (`RAW_ARTICLES` / `RAW_SWISS_ARTICLES`). Object-block scan (split on `}`),
 * so it's robust to field reordering and to the `Article` interface block at
 * the top (its `id: string;` has no quoted value → no match). Entries without
 * a quoted id or a quoted date are skipped.
 *
 * @param {string} src
 * @returns {Array<{ id: string, category: string|undefined, date: string }>}
 */
export function parseArticleRegistry(src) {
  if (!src || typeof src !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const block of src.split('}')) {
    const id = block.match(/\bid:\s*'([^']+)'/)?.[1];
    const date = block.match(/\bdate:\s*'([^']+)'/)?.[1];
    if (!id || !date || seen.has(id)) continue;
    const category = block.match(/\bcategory:\s*'([^']+)'/)?.[1];
    seen.add(id);
    out.push({ id, category, date });
  }
  return out;
}

/**
 * Build `id → IT slug` map from a slug-data TS module (`BLOG_SLUGS` /
 * `SWISS_SLUGS`). Matches `'id': { … it: 'slug' … }`.
 *
 * @param {string} src
 * @returns {Record<string, string>}
 */
export function parseSlugMap(src) {
  if (!src || typeof src !== 'string') return {};
  const map = {};
  for (const m of src.matchAll(/["']([^"']+)["']:\s*\{[^}]*?\bit:\s*["']([^"']+)["']/g)) {
    map[m[1]] = m[2];
  }
  return map;
}

/**
 * Build `id → { title, excerpt }` from an IT blog-meta TS module. Keys look
 * like `'blog.article.{id}.title'` / `.excerpt`. The value regex handles
 * escaped apostrophes (`d\'ingresso`) and unescapes them.
 *
 * @param {string} src
 * @returns {Record<string, { title?: string, excerpt?: string }>}
 */
export function parseMetaMap(src) {
  if (!src || typeof src !== 'string') return {};
  const map = {};
  const re = /'blog\.article\.([^']+?)\.(title|excerpt)':\s*'((?:[^'\\]|\\.)*)'/g;
  for (const m of src.matchAll(re)) {
    const [, id, field, rawValue] = m;
    const value = rawValue.replace(/\\(['"\\])/g, '$1');
    if (!map[id]) map[id] = {};
    map[id][field] = value;
  }
  return map;
}

// ── Article loading ─────────────────────────────────────────

/**
 * Load all articles across sections, joining registry (id/category/date),
 * slug map (IT URL slug) and meta map (og title/excerpt). Articles missing a
 * slug or a title are dropped (can't build a useful post).
 *
 * @returns {Array<{ id, section, category, date, url, ogTitle, ogDescription }>}
 */
export function loadArticles(repoRoot, log = () => {}) {
  const articles = [];
  for (const cfg of SECTIONS) {
    const registry = parseArticleRegistry(readFileOrEmpty(resolve(repoRoot, cfg.registry)));
    const slugMap = parseSlugMap(readFileOrEmpty(resolve(repoRoot, cfg.slugFile)));
    const metaMap = parseMetaMap(readFileOrEmpty(resolve(repoRoot, cfg.metaFile)));
    let kept = 0;
    for (const entry of registry) {
      const slugIt = slugMap[entry.id];
      const meta = metaMap[entry.id] || {};
      const ogTitle = meta.title;
      const url = buildArticleUrl(cfg.section, slugIt);
      if (!url || !ogTitle) continue;
      articles.push({
        id: entry.id,
        section: cfg.section,
        category: entry.category,
        date: entry.date,
        url,
        ogTitle,
        ogDescription: meta.excerpt || '',
      });
      kept += 1;
    }
    log('ℹ️', `section ${cfg.section}: ${kept}/${registry.length} articles with slug+title`);
  }
  return articles;
}

// ── Selection (exported for tests) ──────────────────────────

/**
 * Pick never-posted articles dated within `maxAgeDays` of `now`, most-recent
 * first, capped at `limit`. The recency window is the primary anti-flood guard
 * for the first run (empty ledger). Registry dates are day-granularity
 * (`YYYY-MM-DD`); parsed as UTC midnight. Unparseable dates are dropped.
 *
 * @param {Array<object>} articles
 * @param {Set<string>} postedSet
 * @param {{ maxAgeDays?: number, limit?: number, now?: Date }} opts
 */
export function selectUnpostedArticles(articles, postedSet, opts = {}) {
  if (!Array.isArray(articles)) return [];
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULT_VOLUME;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const cutoff = now.getTime() - maxAgeDays * MS_PER_DAY;

  const withTs = [];
  for (const a of articles) {
    if (!a || !a.id || postedSet.has(a.id)) continue;
    const ts = Date.parse(a.date);
    if (!Number.isFinite(ts)) continue;
    if (ts < cutoff) continue;
    withTs.push({ article: a, ts });
  }
  withTs.sort((x, y) => y.ts - x.ts);
  return withTs.slice(0, Math.max(0, limit | 0)).map((x) => x.article);
}

// ── Posted-articles ledger I/O ──────────────────────────────

export function loadPosted(repoRoot) {
  return loadLedger(postedPath(repoRoot));
}

export function appendPosted(repoRoot, entries) {
  appendLedger(postedPath(repoRoot), entries, POSTED_TRIM_LIMIT);
}

// ── Main entry ──────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Date} [opts.now]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.repoRoot]
 * @param {(...a: unknown[]) => void} [opts.log]
 * @param {(...a: unknown[]) => void} [opts.warn]
 */
export async function run(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || new Date();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;

  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const limit = Number(env.FB_ARTICLE_VOLUME || DEFAULT_VOLUME);
  const maxAgeDays = Number(env.FB_ARTICLE_MAX_AGE_DAYS || DEFAULT_MAX_AGE_DAYS);
  const pageId = env.FB_PAGE_ID;
  const token = env.FB_PAGE_ACCESS_TOKEN;

  log('🗓️', `FB articles scheduler — limit=${limit}, maxAgeDays=${maxAgeDays}, dry=${dryRun}`);

  // 1. Load articles + ledger
  const articles = loadArticles(repoRoot, log);
  if (articles.length === 0) {
    log('ℹ️', 'no articles available, exiting');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }
  const ledger = loadPosted(repoRoot);
  const postedSet = new Set(ledger.posted.map((e) => e?.id).filter(Boolean));

  // 2. Pick recent never-posted articles
  const candidates = selectUnpostedArticles(articles, postedSet, { maxAgeDays, limit, now });
  if (candidates.length === 0) {
    log('ℹ️', 'no unposted articles within the recency window, exiting');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }
  log('ℹ️', `selected ${candidates.length} article(s) to post`);

  // 3. Build payloads
  const payloads = candidates.map((a) => ({
    articleId: a.id,
    section: a.section,
    url: a.url,
    message: buildArticleCaption(a),
  }));

  // 4. Dry-run vs real POST
  if (dryRun) {
    log('🏃', `DRY_RUN=1 — would post ${payloads.length} article(s)`);
    for (const p of payloads) log('  •', `${p.section}: ${p.url}`);
    return { ok: true, posted: 0, dryRun: true, payloads };
  }

  if (!pageId || !token) {
    warn('⚠️', 'FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN missing — skipping');
    return { ok: false, posted: 0, dryRun, payloads };
  }
  if (typeof fetchImpl !== 'function') {
    warn('⚠️', 'no fetch impl available — skipping');
    return { ok: false, posted: 0, dryRun, payloads };
  }

  // 5. POST one per article. Append to the ledger after each success so a
  //    partial failure still records what got through (prevents re-posting
  //    the survivors on the next run). Transient FB errors get one retry.
  const TRANSIENT_FB_ERROR_CODES = new Set([1, 2, 4, 17]);
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  // Force FB to re-scrape OG metadata before posting — best-effort, mirrors
  // the jobs scheduler. Without it FB may card the article with a stale
  // (pre-deploy) OG image.
  async function rescrapeOg(url) {
    try {
      const u = `${GRAPH_BASE}/?id=${encodeURIComponent(url)}&scrape=true&access_token=${encodeURIComponent(token)}`;
      await fetchImpl(u, { method: 'POST' });
    } catch {
      /* ignore — rescrape is best-effort */
    }
  }

  let posted = 0;
  let skipped = 0;
  for (const p of payloads) {
    // Pre-flight: this immediate poster links to a freshly-built article page;
    // a slow build/deploy can leave it not-yet-live, so skip on a confirmed
    // 4xx rather than post a link that 404s (see isLandingPageLive doc).
    if (!(await isLandingPageLive(p.url, { fetchImpl }))) {
      warn('🚧', `landing page not live yet for "${p.articleId}" (${p.url}) — skipping post`);
      skipped += 1;
      continue;
    }
    await rescrapeOg(p.url);
    const apiUrl = `${GRAPH_BASE}/${pageId}/feed`;
    const buildBody = () => new URLSearchParams({
      message: p.message,
      link: p.url,
      place: ARTICLE_PLACE_ID,
      access_token: token,
    });

    let data = null;
    let res = null;
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      try {
        res = await fetchImpl(apiUrl, { method: 'POST', body: buildBody() });
        data = await res.json();
      } catch (err) {
        warn('⚠️', `POST failed for ${p.articleId} (attempt ${attempt}): ${err.message}`);
        data = null;
      }
      if (res?.ok && data?.id) break;
      const code = data?.error?.code;
      if (attempt < 2 && TRANSIENT_FB_ERROR_CODES.has(code)) {
        warn('⏳', `FB transient error ${code} for ${p.articleId}, retrying in 2s`);
        await sleepMs(2000);
        continue;
      }
      break;
    }

    if (res?.ok && data?.id) {
      posted += 1;
      appendPosted(repoRoot, [{
        id: p.articleId,
        url: p.url,
        ts: new Date().toISOString(),
        fbPostId: data.id,
      }]);
      log('✅', `${p.articleId} → ${data.id}`);
    } else {
      warn('⚠️', `FB API error for ${p.articleId}: ${JSON.stringify(data).slice(0, 300)}`);
    }
  }

  log('🏁', `posted ${posted}/${payloads.length} article(s)${skipped ? ` (${skipped} skipped — landing not live yet)` : ''}`);
  return { ok: posted > 0, posted, skipped, dryRun, payloads };
}

// ── CLI ─────────────────────────────────────────────────────

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  run().then(
    () => process.exit(0),
    (err) => {
      console.error('⚠️ scheduler crashed:', err?.message || err);
      process.exit(0); // soft-fail
    },
  );
}
