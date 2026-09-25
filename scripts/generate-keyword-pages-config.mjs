#!/usr/bin/env node
/**
 * generate-keyword-pages-config.mjs
 *
 * Reads GSC orphan queries + existing editorial pages, identifies high-value
 * queries that don't yet have dedicated landing pages, clusters them, and
 * outputs data/keyword-pages-config.json consumed by jobsSeoPagesPlugin.
 *
 * Run: node scripts/generate-keyword-pages-config.mjs
 * Schedule: weekly via GitHub Actions after GSC sync
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  keywordPageSlugify as slugify,
  professionKeywordQuery,
} from './lib/keyword-page-paths.mjs';
import { isPromotable } from './lib/profession-taxonomy.mjs';
import { carryForwardGscClusterPages } from './lib/gsc-cluster-carry-forward.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GSC_PATH = path.join(ROOT, 'data/gsc-orphan-queries.json');
const OUTPUT_PATH = path.join(ROOT, 'data/keyword-pages-config.json');

// ── Helpers ──────────────────────────────────────────────────────────────

// `slugify` is imported (as `keywordPageSlugify`) from lib/keyword-page-paths.mjs:
// the weekly report predicts the URL a promotable profession will get, and it
// can only do that if it slugifies exactly the way this script does. One copy,
// no drift.

// Stop words to filter out when computing query similarity
const STOP_WORDS = new Set([
  'lavoro', 'lavori', 'offerte', 'offerta', 'di', 'in', 'per', 'a', 'al', 'e',
  'il', 'la', 'le', 'i', 'un', 'una', 'del', 'della', 'delle', 'dei', 'degli',
  'ticino', 'tessin', 'svizzera', 'switzerland', 'canton', 'cantone',
  'presso', 'come', 'con', 'da', 'gli', 'lo', 'nel', 'nella', 'sono',
  'posti', 'cerca', 'cerco', 'annunci', 'annuncio',
]);

function extractKeywords(query) {
  return query.toLowerCase().split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// Jaccard similarity between two keyword sets
function similarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Title case but keep Italian prepositions lowercase (di, in, per, a, al, etc.)
// Declared before the generation loop so titleCase() can access LOWERCASE_WORDS.
const LOWERCASE_WORDS = new Set(['di', 'in', 'per', 'a', 'al', 'e', 'il', 'la', 'le', 'i', 'un', 'una', 'del', 'della', 'delle', 'dei', 'degli', 'da', 'con', 'su', 'lo', 'gli', 'nel', 'nella']);
// Shared by GSC-cluster pages and profession-gap fed pages (#3396) so the
// two page families can't drift in title/description shape.
function buildKeywordPageCopy(query) {
  const titleCaseQuery = titleCase(query);
  const hasLocationInQuery = /\b(lugano|bellinzona|mendrisio|locarno|chiasso|stabio|ticino|tessin)\b/i.test(query);
  const titleSuffix = hasLocationInQuery ? '' : ' in Ticino';
  const seoTitle = `${titleCaseQuery}${titleSuffix} - Posizioni Aperte | Frontaliere Ticino`;
  // Cap title at ~60 chars for SERP display
  const finalTitle = seoTitle.length > 70 ? `${titleCaseQuery}${titleSuffix} | Frontaliere Ticino` : seoTitle;
  return {
    it: {
      title: finalTitle,
      description: `Offerte di lavoro per "${query}"${titleSuffix}. Annunci da aziende svizzere aggiornati quotidianamente con link diretto alla candidatura.`,
      heading: `${titleCaseQuery}${titleSuffix}`,
    },
  };
}

function titleCase(s) {
  return s.split(/\s+/).map((word, idx) => {
    if (idx === 0) return capitalize(word);
    if (LOWERCASE_WORDS.has(word.toLowerCase())) return word.toLowerCase();
    return capitalize(word);
  }).join(' ');
}

// ── Main ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(GSC_PATH)) {
  console.log('No GSC data found at', GSC_PATH);
  process.exit(0);
}

const gscData = JSON.parse(fs.readFileSync(GSC_PATH, 'utf-8'));

// 1. Aggregate queries across all slugs
let skippedInvalidQueries = 0;
const queryAgg = new Map();
for (const queries of Object.values(gscData)) {
  if (!Array.isArray(queries)) continue;
  for (const q of queries) {
    // Guard: q may be null/undefined, q.query may be missing/empty/non-string.
    // GSC exports occasionally include anonymized or malformed entries — skip them.
    if (!q || typeof q.query !== 'string') {
      skippedInvalidQueries++;
      continue;
    }
    const key = q.query.toLowerCase().trim();
    if (!key) {
      skippedInvalidQueries++;
      continue;
    }
    const existing = queryAgg.get(key) || { clicks: 0, impressions: 0 };
    existing.clicks += Number(q.clicks) || 0;
    existing.impressions += Number(q.impressions) || 0;
    queryAgg.set(key, existing);
  }
}
if (skippedInvalidQueries > 0) {
  console.warn(`⚠️  Skipped ${skippedInvalidQueries} GSC entries with missing/empty query field`);
}

// 2. Filter to qualifying queries (≥3 clicks OR ≥30 impressions)
const qualifying = [...queryAgg.entries()]
  .filter(([, v]) => v.clicks >= 3 || v.impressions >= 30)
  .sort((a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions);

console.log(`Total unique queries: ${queryAgg.size}`);
console.log(`Qualifying (≥3 clicks OR ≥30 imp): ${qualifying.length}`);

// 3. Cluster similar queries (Jaccard > 0.5 = same cluster)
const clusters = [];
const assigned = new Set();

for (const [query, metrics] of qualifying) {
  if (assigned.has(query)) continue;

  const keywords = extractKeywords(query);
  const cluster = { representative: query, queries: [{ query, ...metrics }], keywords };

  for (const [otherQuery, otherMetrics] of qualifying) {
    if (assigned.has(otherQuery) || otherQuery === query) continue;
    const otherKeywords = extractKeywords(otherQuery);
    if (similarity(keywords, otherKeywords) >= 0.5) {
      cluster.queries.push({ query: otherQuery, ...otherMetrics });
      assigned.add(otherQuery);
    }
  }

  assigned.add(query);
  cluster.totalClicks = cluster.queries.reduce((s, q) => s + q.clicks, 0);
  cluster.totalImpressions = cluster.queries.reduce((s, q) => s + q.impressions, 0);
  clusters.push(cluster);
}

// 4. Sort clusters by total clicks, keep top 50
clusters.sort((a, b) => b.totalClicks - a.totalClicks || b.totalImpressions - a.totalImpressions);
const topClusters = clusters.slice(0, 50);

// 5. Generate page config for each cluster
// Exclude generic queries that are already covered by the main listing page
const GENERIC_PATTERNS = [
  /^(offerte?\s+)?(di\s+)?lavoro?\s+(in\s+)?ticino$/,
  /^cerco\s+lavoro\s+(in\s+)?ticino$/,
  /^posti\s+(di\s+)?lavoro?\s+(in\s+)?ticino$/,
  /^annunci\s+(di\s+)?lavoro?\s+(in\s+)?ticino$/,
  /^lavoro?\s+ticino\s+(offerte?|annunci|posti)$/,
];

// Existing editorial page slugs that already cover a query
const COVERED_KEYWORDS = new Set([
  'infermieri', 'infermiere', 'part-time', 'part time', 'stage',
  'apprendistato', 'foglio ufficiale', 'gazzetta', 'lugano',
  'bellinzona', 'mendrisio', 'locarno', 'chiasso',
  'sanita', 'finanza', 'informatica', 'ingegneria', 'amministrazione',
  'ristorazione', 'vendita',
]);

const keywordPages = [];
for (const cluster of topClusters) {
  const query = cluster.representative;

  // Skip generic queries covered by main listing
  if (GENERIC_PATTERNS.some(p => p.test(query))) continue;

  // Skip if covered by existing editorial pages
  const queryLower = query.toLowerCase();
  const isCovered = [...COVERED_KEYWORDS].some(kw => queryLower.includes(kw));
  if (isCovered) continue;

  // Generate slug and copy
  const slug = slugify(query);
  if (!slug || slug.length < 5) continue;

  // Determine filter keywords for matching jobs
  const filterKeywords = extractKeywords(query);
  if (filterKeywords.length === 0) continue;

  keywordPages.push({
    slug,
    query: cluster.representative,
    filterKeywords,
    totalClicks: cluster.totalClicks,
    totalImpressions: cluster.totalImpressions,
    queryCount: cluster.queries.length,
    allQueries: cluster.queries.map(q => q.query),
    copy: buildKeywordPageCopy(query),
  });
}

// Previous run's config, read ONCE and shared by both carry-forward blocks
// below (GSC-cluster here, profession-gap further down) — a single source
// of "what did we publish last time" for both, instead of two independent
// reads that could read two different states if this script raced its own
// output (AGENTS.md #6).
let prevConfigPages = [];
try {
  prevConfigPages = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8')).pages || [];
} catch { /* first run or unreadable previous config — nothing to carry */ }

// ── GSC-cluster carry-forward (#5631) ─────────────────────────────────────
// The profession-gap feed below persists its own pages across
// regenerations; plain GSC-cluster pages (no `source` field, generated
// straight from the loop above) never got the same protection, even though
// this script rebuilds `keywordPages` from scratch every run and
// `topClusters` keeps only the top 50 by clicks. A cluster that ranks 51st
// this run is a real, still-live, still-indexed page with no memory of ever
// existing — it 301s on the next deploy for a ranking reason that has
// nothing to do with its own traffic. See scripts/lib/gsc-cluster-carry-
// forward.mjs for the full defect history and why the drop condition
// mirrors the profession-gap block's own supersession check.
const carriedGscPages = carryForwardGscClusterPages(prevConfigPages, {
  usedSlugs: new Set(keywordPages.map(p => p.slug)),
  genericPatterns: GENERIC_PATTERNS,
  coveredKeywords: COVERED_KEYWORDS,
});
if (carriedGscPages.length > 0) {
  console.log(`GSC-cluster carry-forward: ${carriedGscPages.length} page(s) kept alive despite falling out of the top-50 cluster ranking this run`);
}
keywordPages.push(...carriedGscPages);

// ── Profession-gap feed (#3396) ──────────────────────────────────────────
// data/profession-keyword-opportunities.json is produced weekly by
// scripts/profession-keyword-opportunities.mjs (on-site search ∪ crawler
// titles − existing coverage). Double-validated gaps become keyword pages.
//
// Carry-forward contract: fed pages get `source: 'profession-gap'` and
// PERSIST across regenerations — this script rebuilds the config from
// scratch, and once a fed page exists the opportunities file counts its
// profession as covered; without carry-forward the page would flip-flop
// weekly (URL churn). A carried page is dropped only when a DEDICATED
// landing (profession/nursing hub) takes over its profession.
const OPPORTUNITIES_PATH = path.join(ROOT, 'data/profession-keyword-opportunities.json');
const FEED_MAX_NEW_PAGES = 10; // per run

if (fs.existsSync(OPPORTUNITIES_PATH)) {
  try {
    const opp = JSON.parse(fs.readFileSync(OPPORTUNITIES_PATH, 'utf-8'));
    const dedicatedCovered = new Set(
      (opp.covered || [])
        .filter(row => /^(profession|nursing) landing/.test(String(row.coveredBy || '')))
        .map(row => row.id),
    );
    const usedSlugs = new Set(keywordPages.map(p => p.slug));
    const usedProfessions = new Set();

    // Carry forward previously fed pages (unless a dedicated landing took
    // over). Reuses `prevConfigPages`, read once above and shared with the
    // GSC-cluster carry-forward block (#5631) — one read of "what did we
    // publish last time", not two.
    for (const page of prevConfigPages) {
      if (page?.source !== 'profession-gap' || !page.professionId) continue;
      if (dedicatedCovered.has(page.professionId)) continue;
      if (usedSlugs.has(page.slug)) continue;
      keywordPages.push(page);
      usedSlugs.add(page.slug);
      usedProfessions.add(page.professionId);
    }

    // Feed new double-validated gaps (opportunities are already
    // coverage-subtracted and sorted by priority upstream).
    let fed = 0;
    for (const o of opp.opportunities || []) {
      if (fed >= FEED_MAX_NEW_PAGES) break;
      if (usedProfessions.has(o.id)) continue;
      // ONE predicate, shared with the weekly ranking that produced this file
      // (`isPromotable` in profession-taxonomy.mjs) — never a second floor
      // tuned locally. That is the #4564 failure mode: a stricter local gate
      // left rows the report marked promotable stuck there forever, never
      // becoming a page.
      //
      // It qualifies a row two ways. DEMAND (the original double validation):
      // people search it on-site AND there are ads to show them. SUPPLY: 12+
      // live ads and 5+ literal matches, for professions that read 0 on-site
      // *because* the site has no page for them yet — a circular signal that
      // parked eight professions with 12-65 live ads in the report
      // indefinitely. Both paths also require the literal feedFilter to be no
      // broader than the profession it names.
      //
      // Recomputed from the row rather than trusting `o.promotable`, so a
      // stale opportunities file written before the field existed still gates
      // correctly instead of failing open.
      if (!isPromotable(o)) continue;
      // Literal-match support: jobsSeoPagesPlugin filters with
      // `filterKeywords: [feedFilter]` (single substring) and skips pages
      // with <3 matching jobs — feeding below that produces a page that
      // silently never emits. Missing field (stale file) → treat as 0.
      if ((Number(o.feedFilterJobCount) || 0) < 3) continue;
      // Shared with the weekly report (lib/keyword-page-paths.mjs) so the URL
      // it prints under "Pagina" is the one this loop actually creates.
      const query = professionKeywordQuery(o.label);
      if (!query) continue;
      const label = query.replace(/\s+ticino$/, '');
      const slug = slugify(query);
      if (!slug || slug.length < 5 || usedSlugs.has(slug)) continue;
      if ([...COVERED_KEYWORDS].some(kw => query.includes(kw))) continue;
      const filterKeywords = [String(o.feedFilter || label)];
      keywordPages.push({
        slug,
        query,
        filterKeywords,
        totalClicks: Number(o.gscClicks) || 0,
        totalImpressions: Number(o.gscImpressions) || 0,
        queryCount: 1,
        allQueries: [query],
        source: 'profession-gap',
        professionId: o.id,
        copy: buildKeywordPageCopy(query),
      });
      usedSlugs.add(slug);
      usedProfessions.add(o.id);
      fed++;
    }
    if (fed > 0 || usedProfessions.size > 0) {
      console.log(`Profession-gap feed: ${fed} new page(s), ${usedProfessions.size - fed} carried forward`);
    }
  } catch (err) {
    console.error(`Profession-gap feed skipped: ${err?.message || err}`);
  }
}

// 6. Write config
const config = {
  generatedAt: new Date().toISOString(),
  totalQueriesAnalyzed: queryAgg.size,
  qualifyingQueries: qualifying.length,
  clustersFound: clusters.length,
  pages: keywordPages,
};

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
console.log(`\nGenerated ${keywordPages.length} keyword page configs → ${OUTPUT_PATH}`);
for (const p of keywordPages.slice(0, 15)) {
  console.log(`  ${p.totalClicks}c ${p.totalImpressions}i | /${p.slug}/ — "${p.query}"`);
}
if (keywordPages.length > 15) console.log(`  ... and ${keywordPages.length - 15} more`);
