#!/usr/bin/env node
/**
 * Audit evergreen blog articles for staleness.
 *
 * Reads data/blog-articles-data.ts, filters to evergreen categories
 * (fiscale, pratico, pensione), and flags articles whose freshness
 * date (updatedAt ?? date) is older than 6 months.
 *
 * Output: JSON on stdout with { totalEvergreen, staleCount, stale[] }.
 * Used by the evergreen-refresh-audit GitHub Actions workflow.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTICLES_PATH = resolve(__dirname, '..', 'data', 'blog-articles-data.ts');

const EVERGREEN_CATEGORIES = new Set(['fiscale', 'pratico', 'pensione']);
const STALE_THRESHOLD_MONTHS = 6;

// ── Parse the TypeScript articles array ────────────────────────────
function parseArticles() {
  const raw = readFileSync(ARTICLES_PATH, 'utf-8');

  // Strip TypeScript-only syntax so we can eval as plain JS
  const stripped = raw
    .replace(/^import\s+.*$/gm, '')
    .replace(/^export\s+interface\s+\w+\s*\{[^}]*\}/gm, '')
    .replace(/export\s+const/g, 'const')
    .replace(/:\s*Article\[\]/g, '')
    // Remove "as const" assertions
    .replace(/as\s+const/g, '')
    // Remove trailing type annotations on properties (e.g. `id: 'foo' as BlogArticleId`)
    .replace(/as\s+BlogArticleId/g, '');

  // Wrap in a function that returns the ARTICLES array
  const fn = new Function(`${stripped}; return ARTICLES;`);
  return fn();
}

// ── Compute months between two dates ───────────────────────────────
function monthsBetween(older, newer) {
  return (
    (newer.getFullYear() - older.getFullYear()) * 12 +
    (newer.getMonth() - older.getMonth())
  );
}

// ── Main ───────────────────────────────────────────────────────────
const now = new Date();
const articles = parseArticles();

const evergreen = articles.filter((a) => EVERGREEN_CATEGORIES.has(a.category));

const stale = evergreen
  .map((a) => {
    const freshnessDate = new Date(a.updatedAt || a.date);
    const ageMonths = monthsBetween(freshnessDate, now);
    return { id: a.id, category: a.category, date: a.date, updatedAt: a.updatedAt ?? null, ageMonths };
  })
  .filter((a) => a.ageMonths > STALE_THRESHOLD_MONTHS)
  .sort((a, b) => b.ageMonths - a.ageMonths); // oldest first

const result = {
  totalEvergreen: evergreen.length,
  staleCount: stale.length,
  stale,
};

console.log(JSON.stringify(result));
