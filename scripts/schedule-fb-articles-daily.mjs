#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
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
 * Metadata is read from the persisted source-of-truth files (no TS evaluation):
 *   - id / category / date  → data/{blog,swiss}-articles-data.ts registries
 *   - IT URL slug           → services/router{Blog,Swiss}Data.ts
 *   - og title / excerpt    → services/locales/blog-meta{,-ch}-it.ts via the
 *     shared static TypeScript translation reader.
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
  GRAPH_API,
} from './lib/social-post-utils.mjs';
import { ARTICLE_SECTION_CORE } from '../build-plugins/shared/articleSectionCore.mjs';
import { facebookUrl, FACEBOOK_CAMPAIGN_ARTICLE } from './lib/facebook-links.mjs';
import { loadSocialCopyPack, releaseUnpublishedSocialCopyAssignmentBestEffort, selectSocialCopyForPublish, socialCopyLedgerFields, socialCopyTrackingContent } from './lib/social-copy-pack.mjs';
import { parseStaticArticleTranslationSource } from '../packages/articles/engine/shared/articleStaticSource.mjs';
import {
  markSocialPublishReservationPublished,
  releaseSocialPublishReservation,
  reserveSocialPublishBatch,
  socialPublishContentFingerprint,
  socialPublishReservationKey,
} from './lib/social-publish-reservations.mjs';
import { isAmbiguousSocialPublishResponse } from './lib/social-publish-outcome.mjs';

export { buildArticleUrl, buildArticleCaption } from './lib/social-post-utils.mjs';

// ── Constants ───────────────────────────────────────────────

// Graph API base: one shared literal in social-post-utils.mjs (see its note).
const GRAPH_BASE = GRAPH_API;

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

function readOptionalSource(file) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
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
  const translations = parseStaticArticleTranslationSource(src, 'blog-meta-it.ts');
  const map = Object.create(null);
  for (const [id, fields] of translations) {
    for (const field of ['title', 'excerpt']) {
      const value = fields.get(field);
      if (value === undefined) continue;
      (map[id] ??= Object.create(null))[field] = value;
    }
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
    const metaPath = resolve(repoRoot, cfg.metaFile);
    const metaSource = readOptionalSource(metaPath);
    const metaMap = metaSource === null ? Object.create(null) : parseMetaMap(metaSource);
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
 * @param {(options: object) => Promise<object|null>} [opts.selectSocialCopyForPublishImpl]
 * @param {(copy: object) => Promise<boolean>} [opts.releaseSocialCopyAssignmentImpl]
 * @param {{ reserveBatch: Function, markPublished: Function, release: Function }} [opts.socialPublishReservations]
 */
export async function run(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || new Date();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;
  const socialCopyPack = opts.socialCopyPack || loadSocialCopyPack({
    onWarning: (message) => warn('⚠️', message),
  });
  const selectSocialCopy = opts.selectSocialCopyForPublishImpl || selectSocialCopyForPublish;
  const releaseSocialCopy = opts.releaseSocialCopyAssignmentImpl || undefined;
  const socialPublishReservations = opts.socialPublishReservations || {
    reserveBatch: reserveSocialPublishBatch,
    markPublished: markSocialPublishReservationPublished,
    release: releaseSocialPublishReservation,
  };

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
  const copyReservations = new Map();
  const releaseReservation = async (id, reason) => {
    const released = await releaseUnpublishedSocialCopyAssignmentBestEffort(copyReservations.get(id), {
      releaseBalancedImpl: releaseSocialCopy,
      reason,
      onFailure: (err) => warn('⚠️', `could not release social-copy reservation for ${id}: ${err.message}`),
    });
    if (released) copyReservations.delete(id);
    return released;
  };
  const releaseAllReservations = async (reason) => {
    for (const id of [...copyReservations.keys()]) await releaseReservation(id, reason);
  };
  const built = await Promise.allSettled(candidates.map(async (a) => {
    const socialCopy = await selectSocialCopy({
      pack: socialCopyPack,
      channel: 'facebook',
      kind: 'article',
      assignmentKey: a.id,
      dryRun,
    });
    copyReservations.set(a.id, socialCopy);
    return {
      articleId: a.id,
      section: a.section,
      url: a.url,
      message: buildArticleCaption({ ...a, socialCopy }),
      copyFields: socialCopyLedgerFields(socialCopy),
    };
  }));
  const buildFailure = built.find((result) => result.status === 'rejected');
  if (buildFailure) {
    await releaseAllReservations('Facebook article payload compilation failed before delivery');
    throw buildFailure.reason;
  }
  const payloads = built.map((result) => result.value);

  // 4. Dry-run vs real POST
  if (dryRun) {
    log('🏃', `DRY_RUN=1 — would post ${payloads.length} article(s)`);
    for (const p of payloads) log('  •', `${p.section}: ${p.url}`);
    return { ok: true, posted: 0, dryRun: true, payloads };
  }

  if (!pageId || !token) {
    warn('⚠️', 'FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN missing — skipping');
    await releaseAllReservations('Facebook credentials missing');
    return { ok: false, posted: 0, dryRun, payloads };
  }
  if (typeof fetchImpl !== 'function') {
    warn('⚠️', 'no fetch impl available — skipping');
    await releaseAllReservations('Facebook fetch implementation missing');
    return { ok: false, posted: 0, dryRun, payloads };
  }

  const publishAt = now;
  const publishReservationKeys = new Map(payloads.map((p) => [
    p.articleId,
    socialPublishReservationKey('facebook', 'article', p.articleId),
  ]));
  let reservationBatch;
  try {
    reservationBatch = await socialPublishReservations.reserveBatch({
      db: opts.socialPublishDb,
      platform: 'facebook',
      accountId: pageId,
      repoRoot,
      now,
      reservations: payloads.map((p) => ({
        key: publishReservationKeys.get(p.articleId),
        publishAt,
        nativeContentFingerprint: socialPublishContentFingerprint('facebook', {
          message: p.message,
          link: facebookUrl(p.url, FACEBOOK_CAMPAIGN_ARTICLE, socialCopyTrackingContent(p.articleId, p.copyFields)),
        }),
      })),
    });
  } catch (error) {
    const fatal = new Error(`Facebook shared publication gate failed: ${error.message}`, { cause: error });
    fatal.code = 'SOCIAL_PUBLISH_RESERVATION_REQUIRED';
    throw fatal;
  }
  const allowedKeys = new Set(reservationBatch.filter((result) => result.allowed).map((result) => result.key));
  const deliveryPayloads = payloads.filter((p) => allowedKeys.has(publishReservationKeys.get(p.articleId)));
  const releasePublishReservation = async (p, reason) => {
    try {
      await socialPublishReservations.release({
        db: opts.socialPublishDb,
        platform: 'facebook',
        accountId: pageId,
        key: publishReservationKeys.get(p.articleId),
        publishAt,
      });
    } catch (error) {
      warn('⚠️', `Facebook reservation remains held for ${p.articleId} after ${reason}: ${error.message}`);
    }
  };
  for (const p of payloads) {
    if (allowedKeys.has(publishReservationKeys.get(p.articleId))) continue;
    const reason = reservationBatch.find((result) => result.key === publishReservationKeys.get(p.articleId))?.reason || 'daily-cap';
    warn('🛑', `Facebook Page publication held for ${p.articleId}: ${reason}`);
    await releaseReservation(p.articleId, `Facebook Page shared publication gate: ${reason}`);
  }
  if (deliveryPayloads.length === 0) {
    log('🛑', 'Facebook Page shared daily publication cap is exhausted; no posts sent');
    return { ok: true, posted: 0, dryRun, payloads: [] };
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
  let uncertain = 0;
  for (const p of deliveryPayloads) {
    // Pre-flight: this immediate poster links to a freshly-built article page;
    // a slow build/deploy can leave it not-yet-live, so skip on a confirmed
    // 4xx rather than post a link that 404s (see isLandingPageLive doc).
    let pageIsLive = false;
    try {
      pageIsLive = await isLandingPageLive(p.url, { fetchImpl });
    } catch {
      pageIsLive = false;
    }
    if (!pageIsLive) {
      warn('🚧', `landing page not live yet for "${p.articleId}" (${p.url}) — skipping post`);
      await releaseReservation(p.articleId, 'Facebook article landing-page preflight failed');
      await releasePublishReservation(p, 'landing-page preflight failure');
      skipped += 1;
      continue;
    }
    // Tag before the rescrape: FB caches OG metadata per exact URL string, so
    // warming the bare URL leaves the one actually posted uncached. `p.url`
    // stays untagged — it is the ledger's dedup key.
    const link = facebookUrl(
      p.url,
      FACEBOOK_CAMPAIGN_ARTICLE,
      socialCopyTrackingContent(p.articleId, p.copyFields),
    );
    await rescrapeOg(link);
    const apiUrl = `${GRAPH_BASE}/${pageId}/feed`;
    const buildBody = () => new URLSearchParams({
      message: p.message,
      link,
      place: ARTICLE_PLACE_ID,
      access_token: token,
    });

    let data = null;
    let res = null;
    let attempt = 0;
    let deliveryUncertain = false;
    while (attempt < 2) {
      attempt += 1;
      res = null;
      data = null;
      try {
        res = await fetchImpl(apiUrl, { method: 'POST', body: buildBody() });
        data = await res.json();
      } catch (err) {
        deliveryUncertain = !res || res.ok === true || isAmbiguousSocialPublishResponse(res);
        warn('⚠️', `POST failed for ${p.articleId} (attempt ${attempt}): ${err.message}`);
        data = null;
      }
      if (isAmbiguousSocialPublishResponse(res) || (res?.ok && !data?.id)) deliveryUncertain = true;
      if (res?.ok && data?.id) break;
      const code = data?.error?.code;
      if (!deliveryUncertain && attempt < 2 && TRANSIENT_FB_ERROR_CODES.has(code)) {
        warn('⏳', `FB transient error ${code} for ${p.articleId}, retrying in 2s`);
        await sleepMs(2000);
        continue;
      }
      break;
    }

    if (res?.ok && data?.id) {
      copyReservations.delete(p.articleId);
      posted += 1;
      const publishedAt = new Date().toISOString();
      appendPosted(repoRoot, [{
        id: p.articleId,
        url: p.url,
        ts: publishedAt,
        fbPostId: data.id,
        ...p.copyFields,
      }]);
      try {
        await socialPublishReservations.markPublished({
          db: opts.socialPublishDb,
          platform: 'facebook',
          accountId: pageId,
          key: publishReservationKeys.get(p.articleId),
          publishAt,
          publishedAt,
        });
      } catch (error) {
        warn('⚠️', `Facebook article reservation remains held after accepted post ${p.articleId}: ${error.message}`);
      }
      log('✅', `${p.articleId} → ${data.id}`);
    } else {
      warn('⚠️', `FB API error for ${p.articleId}: ${JSON.stringify(data).slice(0, 300)}`);
      if (!deliveryUncertain && res && !res.ok) {
        await releaseReservation(p.articleId, 'Facebook explicitly rejected the article post');
        await releasePublishReservation(p, 'explicit API rejection');
      }
    }
    if (deliveryUncertain) uncertain += 1;
  }

  log('🏁', `posted ${posted}/${deliveryPayloads.length} article(s); cap held ${payloads.length - deliveryPayloads.length}${skipped ? ` (${skipped} skipped — landing not live yet)` : ''}`);
  return { ok: posted > 0, posted, skipped, uncertain, dryRun, payloads: deliveryPayloads };
}

// ── CLI ─────────────────────────────────────────────────────

const isDirectInvocation = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isDirectInvocation) {
  run().then(
    (result) => process.exit(result?.uncertain > 0 ? 1 : 0),
    (err) => {
      console.error('⚠️ scheduler crashed:', err?.message || err);
      process.exit(err?.code === 'SOCIAL_PUBLISH_RESERVATION_REQUIRED' ? 1 : 0); // quota gate fails closed; other legacy errors remain soft
    },
  );
}
