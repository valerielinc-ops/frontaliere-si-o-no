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

const ROOT = path.resolve(import.meta.dirname, '..');
const GSC_PATH = path.join(ROOT, 'data/gsc-orphan-queries.json');
const OUTPUT_PATH = path.join(ROOT, 'data/keyword-pages-config.json');

// ── Helpers ──────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

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

// ── Main ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(GSC_PATH)) {
  console.log('No GSC data found at', GSC_PATH);
  process.exit(0);
}

const gscData = JSON.parse(fs.readFileSync(GSC_PATH, 'utf-8'));

// 1. Aggregate queries across all slugs
const queryAgg = new Map();
for (const queries of Object.values(gscData)) {
  for (const q of queries) {
    const key = q.query.toLowerCase().trim();
    if (!key) continue;
    const existing = queryAgg.get(key) || { clicks: 0, impressions: 0 };
    existing.clicks += q.clicks;
    existing.impressions += q.impressions;
    queryAgg.set(key, existing);
  }
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
    copy: {
      it: {
        title: `${capitalize(query)} | Frontaliere Ticino`,
        description: `Offerte di lavoro per "${query}" in Ticino. Annunci aggiornati quotidianamente da aziende svizzere.`,
        heading: capitalize(query),
      },
    },
  });
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
