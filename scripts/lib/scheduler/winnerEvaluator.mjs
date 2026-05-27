// scripts/lib/scheduler/winnerEvaluator.mjs
//
// Phase 4 winner evaluator: scans `data/blog-articles/<id>.json` sidecars,
// keeps articles published 14-30 days ago, looks them up in the GA4 page
// stats from `evidence-index.json`, and counts how many beat the cluster
// p50 baseline. Sidecar files only exist for articles published AFTER the
// Phase 3 merge — older articles do NOT have sidecars and are silently
// skipped. Articles whose page is not in the GA4 evidence are also
// skipped (no traffic data → cannot judge).
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 7.3

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_BLOG_ARTICLES_DIR = 'data/blog-articles';
export const WINNER_MIN_AGE_DAYS = 14;
export const WINNER_MAX_AGE_DAYS = 30;
export const DEFAULT_CLUSTER_FALLBACK_P50 = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   slug?: string,
 *   publishedAt?: string,
 *   cluster?: string|null,
 *   _pool?: 'proven'|'discovery'|'evergreen-fallback'|string,
 *   _pool_source?: string,
 *   _score_breakdown?: object,
 * }} ArticleSidecar
 */

/**
 * @typedef {{
 *   proven: { winners: number, total: number },
 *   discovery: { winners: number, total: number },
 *   skipped: {
 *     noSidecarDir: boolean,
 *     malformed: number,
 *     outOfWindow: number,
 *     noGa4: number,
 *     noPool: number,
 *   },
 *   perCluster: Record<string, { winners: number, total: number }>,
 * }} WinnerStats
 */

function emptyStats() {
  return {
    proven: { winners: 0, total: 0 },
    discovery: { winners: 0, total: 0 },
    skipped: {
      noSidecarDir: false,
      malformed: 0,
      outOfWindow: 0,
      noGa4: 0,
      noPool: 0,
    },
    perCluster: {},
  };
}

/**
 * Load every parseable JSON sidecar from `data/blog-articles/`. Returns an
 * array — never throws. Files that fail to parse are skipped and counted.
 *
 * @param {string} dir
 * @returns {{ articles: ArticleSidecar[], malformed: number, dirExists: boolean }}
 */
export function loadAllPublishedArticleMetas(dir = DEFAULT_BLOG_ARTICLES_DIR) {
  if (!existsSync(dir)) {
    return { articles: [], malformed: 0, dirExists: false };
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { articles: [], malformed: 0, dirExists: false };
  }
  const articles = [];
  let malformed = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, name), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') articles.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { articles, malformed, dirExists: true };
}

/**
 * Translate a sidecar slug into the GA4 page path. Phase 1 fetcher confirmed
 * GA4 reports paths WITH a trailing slash for Italian articles.
 *
 * @param {string} slug
 * @returns {string|null}
 */
export function slugToGa4Path(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const trimmed = slug.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return null;
  return `/articoli-frontaliere/${trimmed}/`;
}

/**
 * Evaluate winners for the 14-30d window.
 *
 * @param {object} evidence
 * @param {{ blogArticlesDir?: string, now?: number }} [opts]
 * @returns {WinnerStats}
 */
export function evaluateWinners(evidence, opts = {}) {
  const stats = emptyStats();
  const dir = opts.blogArticlesDir || DEFAULT_BLOG_ARTICLES_DIR;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const minAgeMs = WINNER_MIN_AGE_DAYS * MS_PER_DAY;
  const maxAgeMs = WINNER_MAX_AGE_DAYS * MS_PER_DAY;

  const { articles, malformed, dirExists } = loadAllPublishedArticleMetas(dir);
  stats.skipped.malformed = malformed;
  stats.skipped.noSidecarDir = !dirExists;

  const ga4Pages = (evidence && evidence.ga4 && evidence.ga4.pages) || {};
  const clusterStats = (evidence && evidence.clusterStats) || {};

  for (const article of articles) {
    if (!article || typeof article !== 'object') {
      stats.skipped.malformed += 1;
      continue;
    }
    const publishedAt = article.publishedAt;
    if (!publishedAt) {
      stats.skipped.malformed += 1;
      continue;
    }
    const ts = new Date(publishedAt).getTime();
    if (!Number.isFinite(ts)) {
      stats.skipped.malformed += 1;
      continue;
    }
    const ageMs = now - ts;
    if (ageMs < minAgeMs || ageMs > maxAgeMs) {
      stats.skipped.outOfWindow += 1;
      continue;
    }
    const path = slugToGa4Path(article.slug);
    if (!path) {
      stats.skipped.malformed += 1;
      continue;
    }
    const ga4 = ga4Pages[path];
    if (!ga4 || typeof ga4.sessions !== 'number') {
      stats.skipped.noGa4 += 1;
      continue;
    }
    const cluster = article.cluster || 'generic';
    const p50 = clusterStats[cluster]?.p50 ?? DEFAULT_CLUSTER_FALLBACK_P50;
    const isWinner = ga4.sessions > p50;

    let bucket;
    if (article._pool === 'discovery') {
      bucket = stats.discovery;
    } else if (article._pool === 'proven') {
      bucket = stats.proven;
    } else {
      // Evergreen-fallback / unknown pool → not part of proven|discovery
      // mix; do not count toward the tune decision (avoids polluting both
      // rates with a third category that never gets chosen by quota).
      stats.skipped.noPool += 1;
      continue;
    }
    bucket.total += 1;
    if (isWinner) bucket.winners += 1;

    if (!stats.perCluster[cluster]) {
      stats.perCluster[cluster] = { winners: 0, total: 0 };
    }
    stats.perCluster[cluster].total += 1;
    if (isWinner) stats.perCluster[cluster].winners += 1;
  }

  return stats;
}
