#!/usr/bin/env node
/**
 * Facebook auto-posting pipeline — 3 posts/week (Mon/Wed/Fri)
 *
 * Reads top companies/titles from data/jobs-stats-history.json and the newest
 * blog article from data/blog-articles-data.ts + services/locales/blog-meta-it.ts,
 * then posts a rotating variant to the configured Facebook Page via the
 * Meta Graph API v18.0.
 *
 * Variants by weekday:
 *   Monday    → Top job / companies hiring summary
 *   Wednesday → Latest article teaser
 *   Friday    → Calcolatore (fiscal simulator) promo
 *
 * Environment variables:
 *   FB_PAGE_ACCESS_TOKEN  — Page access token (loaded from Firebase RC in CI)
 *   FB_PAGE_ID            — Facebook Page numeric ID
 *   DRY_RUN=1             — Skip HTTP calls, just log the would-be POST body
 *
 * Exit code is always 0 (soft failure) — this script must never block the cron.
 *
 * See also: scripts/post-to-linkedin.mjs (sibling LinkedIn pipeline).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const CANONICAL_ORIGIN = 'https://frontaliereticino.ch';
export const GRAPH_API_VERSION = 'v18.0';

// ─── Public helpers (exported for tests) ────────────────────────────────

/**
 * Choose which variant to post based on the given weekday.
 * 0 = Sunday, 1 = Monday, …, 6 = Saturday.
 * Monday → topJob, Wednesday → article, Friday → calcolatore.
 * Any other day falls back to `calcolatore` (keeps the script idempotent if
 * triggered manually outside cron).
 */
export function pickVariant(weekday) {
  if (weekday === 1) return 'topJob';
  if (weekday === 3) return 'article';
  if (weekday === 5) return 'calcolatore';
  return 'calcolatore';
}

/**
 * Build the final post text + link for the chosen variant.
 * Pure: takes fully materialised data, returns { message, link, variant }.
 */
export function buildPost(variant, data) {
  if (variant === 'topJob') {
    const companyCount = data.companyCount ?? 0;
    const topCompany = data.topCompany ?? 'aziende ticinesi';
    const topRole = data.topRole ?? 'nuove figure';
    const url = data.jobBoardUrl ?? `${CANONICAL_ORIGIN}/cerca-lavoro-ticino`;
    return {
      variant,
      message: `🔥 ${companyCount} aziende stanno assumendo questa settimana in Ticino. Top: ${topCompany} cerca ${topRole}. Vedi tutte: ${url}`,
      link: url,
    };
  }
  if (variant === 'article') {
    const articleTitle = data.articleTitle ?? 'Ultimo articolo dal blog di Frontaliere Ticino';
    const url = data.articleUrl ?? `${CANONICAL_ORIGIN}/blog`;
    return {
      variant,
      message: `📄 ${articleTitle}. Leggi: ${url}`,
      link: url,
    };
  }
  // calcolatore
  const url = data.calcolatoreUrl ?? `${CANONICAL_ORIGIN}/`;
  return {
    variant,
    message: `Quanto guadagneresti netto come frontaliere in Ticino nel 2026? Calcolo gratis: ${url}`,
    link: url,
  };
}

// ─── Data loaders (exported for tests) ──────────────────────────────────

/**
 * Read the latest entry from jobs-stats-history.json and derive:
 *   { companyCount, topCompany, topRole, jobBoardUrl }
 * Falls back to safe defaults if the file is missing / empty / malformed.
 */
export function loadJobStats(repoRoot = REPO_ROOT) {
  const fallback = {
    companyCount: 0,
    topCompany: null,
    topRole: null,
    jobBoardUrl: `${CANONICAL_ORIGIN}/cerca-lavoro-ticino`,
  };
  const filePath = resolve(repoRoot, 'data/jobs-stats-history.json');
  if (!existsSync(filePath)) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const latest = entries.length ? entries[entries.length - 1] : null;
  if (!latest) return fallback;

  const companyStats = Array.isArray(latest.companyStats) ? latest.companyStats : [];
  const titleStats = Array.isArray(latest.titleStats) ? latest.titleStats : [];
  const weight = (s) =>
    (Array.isArray(s.addedKeys) ? s.addedKeys.length : 0) +
    (Array.isArray(s.updatedKeys) ? s.updatedKeys.length : 0);

  const topCompanyEntry = [...companyStats].sort((a, b) => weight(b) - weight(a))[0] || null;
  const topTitleEntry = [...titleStats].sort((a, b) => weight(b) - weight(a))[0] || null;

  return {
    companyCount: companyStats.length,
    topCompany: topCompanyEntry?.name || null,
    topRole: topTitleEntry?.name || null,
    jobBoardUrl: `${CANONICAL_ORIGIN}/cerca-lavoro-ticino`,
  };
}

/**
 * Read ARTICLES from data/blog-articles-data.ts (parsed as plain text, not
 * imported — the file is TS and we want to stay pure-ESM) and the IT titles
 * from services/locales/blog-meta-it.ts. Returns the newest article.
 */
export function loadLatestArticle(repoRoot = REPO_ROOT) {
  const fallback = { articleTitle: null, articleUrl: `${CANONICAL_ORIGIN}/blog` };
  const articlesPath = resolve(repoRoot, 'data/blog-articles-data.ts');
  const metaPath = resolve(repoRoot, 'services/locales/blog-meta-it.ts');
  if (!existsSync(articlesPath)) return fallback;

  const articlesSrc = readFileSync(articlesPath, 'utf8');
  // Match objects of the form `{ id: 'slug', category: ..., date: '2026-...', ... }`
  const entryRe = /\{\s*id:\s*'([^']+)'[^}]*?date:\s*'([^']+)'/g;
  const entries = [];
  let m;
  while ((m = entryRe.exec(articlesSrc)) !== null) {
    entries.push({ id: m[1], date: m[2] });
  }
  if (!entries.length) return fallback;

  entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const latest = entries[0];

  let title = null;
  if (existsSync(metaPath)) {
    const metaSrc = readFileSync(metaPath, 'utf8');
    // Match: 'blog.article.<id>.title': 'Some title',
    const titleRe = new RegExp(
      `'blog\\.article\\.${latest.id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.title'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`,
    );
    const tm = metaSrc.match(titleRe);
    if (tm) title = tm[1].replace(/\\'/g, "'");
  }

  return {
    articleTitle: title,
    articleUrl: `${CANONICAL_ORIGIN}/blog/${latest.id}`,
  };
}

// ─── HTTP layer ─────────────────────────────────────────────────────────

export async function postToFacebook({ pageId, accessToken, message, link }, fetchImpl = fetch) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/feed`;
  const body = new URLSearchParams({ message, link, access_token: accessToken });
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
}

// ─── CLI entry point ────────────────────────────────────────────────────

export async function run({
  now = new Date(),
  env = process.env,
  repoRoot = REPO_ROOT,
  log = console.log,
  warn = console.warn,
  fetchImpl = fetch,
} = {}) {
  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const variant = pickVariant(now.getUTCDay());

  const stats = loadJobStats(repoRoot);
  const article = loadLatestArticle(repoRoot);
  const calcolatoreUrl = `${CANONICAL_ORIGIN}/`;

  const post = buildPost(variant, {
    ...stats,
    ...article,
    calcolatoreUrl,
  });

  log(`[fb-social] variant=${post.variant} weekday=${now.getUTCDay()} link=${post.link}`);
  log(`[fb-social] message=${post.message}`);

  if (dryRun) {
    log('[fb-social] DRY_RUN=1 — skipping Graph API call');
    return { ok: true, dryRun: true, post };
  }

  const pageId = env.FB_PAGE_ID;
  const accessToken = env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !accessToken) {
    warn('[fb-social] missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN — skipping post');
    return { ok: false, skipped: true, reason: 'missing-credentials', post };
  }

  try {
    const result = await postToFacebook(
      { pageId, accessToken, message: post.message, link: post.link },
      fetchImpl,
    );
    log(`[fb-social] response status=${result.status} post_id=${result.data?.id ?? 'n/a'}`);
    if (!result.ok) {
      warn(`[fb-social] Graph API error: ${JSON.stringify(result.data)}`);
    }
    return { ok: result.ok, status: result.status, post, response: result.data };
  } catch (err) {
    warn(`[fb-social] fetch failed: ${err?.message || err}`);
    return { ok: false, error: String(err?.message || err), post };
  }
}

// Allow `node scripts/social-schedule-fb.mjs` invocation
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  run().then(
    () => process.exit(0),
    (err) => {
      console.warn(`[fb-social] unexpected error: ${err?.message || err}`);
      process.exit(0); // soft-fail; cron must not break
    },
  );
}
