#!/usr/bin/env node
/**
 * cluster-orphan-queries.mjs
 *
 * Reads `data/gsc-orphan-queries.json` (a map { orphanSlug: [{query, clicks, impressions}] })
 * produced by `sync-gsc-orphans.mjs`, clusters queries by role + region tokens,
 * and writes `data/gsc-orphan-queries-clusters.json` consumed by
 * `build-plugins/orphanQueryLandingPlugin.ts`.
 *
 * Clustering rules:
 *   - Normalize + tokenize each query (lowercase, strip diacritics, remove
 *     stopwords, apply very-light multi-language stems).
 *   - Detect locale heuristically from diagnostic tokens (IT/DE/EN/FR).
 *   - Signature = `${locale}|<sorted role tokens>|<region tokens>`.
 *   - Merge queries sharing a signature into a cluster.
 *
 * Gates (applied here):
 *   - Cluster must reach ≥5 cumulative impressions (thin-content
 *     guardrails live downstream in the build plugin:
 *     `MIN_MATCHING_JOBS = 3` and `MIN_INDEXABLE_WORDS` decide
 *     indexability, so we can afford a lower impression floor here
 *     to surface more long-tail orphan queries as candidates).
 *   - Cluster canonical slug must NOT match a known job URL
 *     in `data/all-known-job-slugs.json` (skip to avoid doorway duplicates).
 *
 * Note: the "≥3 matching jobs" gate is data-dependent (jobs.json is large +
 * crawler slices live in data/jobs/by-crawler) and is enforced at BUILD TIME
 * by the plugin, not here. We only write the candidate clusters.
 *
 * Usage:
 *   node scripts/cluster-orphan-queries.mjs
 *   node scripts/cluster-orphan-queries.mjs --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalize,
  tokenize,
  detectLocale,
  splitRoleRegion,
  canonicalizeRegion,
  canonicalizeRole,
  slugify,
} from './lib/query-tokenizer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const MIN_CLUSTER_IMPRESSIONS = 5;

// Tokenization / stemming / locale-detection / role-region canonicalization
// (normalize, tokenize, detectLocale, splitRoleRegion, canonicalizeRegion,
// canonicalizeRole, slugify) live in scripts/lib/query-tokenizer.mjs — shared
// with scripts/mine-internal-search-terms.mjs (issue #4301) so the two
// scripts never drift on STOPWORDS/STEM_RULES/REGION_TOKENS (AGENTS.md #6).

// ─── Main ─────────────────────────────────────────────────────────
function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function main() {
  const inputPath = path.join(ROOT, 'data', 'gsc-orphan-queries.json');
  const knownSlugsPath = path.join(ROOT, 'data', 'all-known-job-slugs.json');
  const outputPath = path.join(ROOT, 'data', 'gsc-orphan-queries-clusters.json');

  const input = readJsonSafe(inputPath);
  if (!input || typeof input !== 'object') {
    console.warn(`[cluster-orphan-queries] missing or invalid ${inputPath} — writing empty clusters file`);
    const empty = { generatedAt: new Date().toISOString(), clusters: [] };
    if (!DRY_RUN) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(empty, null, 2) + '\n');
    }
    console.log('[cluster-orphan-queries] wrote 0 clusters');
    return;
  }

  // Flatten queries and dedup by normalized query text
  const queryMap = new Map(); // norm → aggregated
  for (const [, entries] of Object.entries(input)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const raw = String(e?.query || '').trim();
      if (!raw) continue;
      const norm = normalize(raw);
      if (!norm) continue;
      const existing = queryMap.get(norm);
      if (existing) {
        existing.clicks += Number(e.clicks) || 0;
        existing.impressions += Number(e.impressions) || 0;
      } else {
        queryMap.set(norm, {
          query: raw,
          normalized: norm,
          clicks: Number(e.clicks) || 0,
          impressions: Number(e.impressions) || 0,
        });
      }
    }
  }

  // Group by signature
  const sigToCluster = new Map();

  for (const q of queryMap.values()) {
    const tokens = tokenize(q.query);
    if (tokens.length === 0) continue;
    const locale = detectLocale(tokens);
    const { role, region } = splitRoleRegion(tokens);
    if (role.length === 0) continue; // need at least one role token
    const roleCanon = canonicalizeRole(role);
    const regionCanon = canonicalizeRegion(region);
    const sig = `${locale}|${roleCanon.join(',')}|${regionCanon.join(',')}`;

    if (!sigToCluster.has(sig)) {
      sigToCluster.set(sig, {
        signature: sig,
        locale,
        roleTokens: roleCanon,
        regionTokens: regionCanon,
        queries: [],
        totalImpressions: 0,
        totalClicks: 0,
      });
    }
    const c = sigToCluster.get(sig);
    c.queries.push({
      query: q.query,
      clicks: q.clicks,
      impressions: q.impressions,
    });
    c.totalImpressions += q.impressions;
    c.totalClicks += q.clicks;
  }

  // Build known slugs set (to avoid doorway duplicates against real job URLs)
  const knownSlugs = new Set();
  const known = readJsonSafe(knownSlugsPath) || {};
  if (known && typeof known === 'object') {
    for (const [k, entry] of Object.entries(known)) {
      if (typeof k === 'string') knownSlugs.add(k);
      if (entry && typeof entry === 'object') {
        for (const v of Object.values(entry)) {
          if (typeof v === 'string') {
            const parts = v.split('/').filter(Boolean);
            if (parts.length) knownSlugs.add(parts[parts.length - 1]);
          }
        }
      }
    }
  }

  // Pick canonical query (highest impressions) + derive slug
  const clusters = [];
  for (const c of sigToCluster.values()) {
    // Sort queries within cluster by impressions desc
    c.queries.sort((a, b) => b.impressions - a.impressions);
    if (c.queries.length === 0) continue;

    const canonicalQuery = c.queries[0].query;
    const canonicalSlug = slugify(canonicalQuery);

    // Gate 1: impressions
    if (c.totalImpressions < MIN_CLUSTER_IMPRESSIONS) continue;
    // Gate 2: avoid collision with an already-tracked job slug
    if (knownSlugs.has(canonicalSlug)) continue;

    clusters.push({
      clusterId: `${c.locale}-${canonicalSlug}`,
      locale: c.locale,
      canonicalQuery,
      canonicalSlug,
      roleTokens: c.roleTokens,
      regionTokens: c.regionTokens,
      totalImpressions: c.totalImpressions,
      totalClicks: c.totalClicks,
      queries: c.queries,
    });
  }

  // Sort by impressions desc for deterministic output
  clusters.sort((a, b) => b.totalImpressions - a.totalImpressions);

  const out = {
    generatedAt: new Date().toISOString(),
    sourceFile: 'data/gsc-orphan-queries.json',
    totalClusters: clusters.length,
    gates: { minClusterImpressions: MIN_CLUSTER_IMPRESSIONS },
    clusters,
  };

  if (DRY_RUN) {
    console.log('[cluster-orphan-queries] DRY RUN — would write', clusters.length, 'clusters');
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(out, null, 2) + '\n');
    console.log(`[cluster-orphan-queries] wrote ${clusters.length} clusters to ${path.relative(ROOT, outputPath)}`);
  }

  if (clusters.length > 0) {
    console.log('Top 10 clusters:');
    for (const c of clusters.slice(0, 10)) {
      console.log(`  ${String(c.totalImpressions).padStart(5)} imp  [${c.locale}]  "${c.canonicalQuery}"  → /${c.canonicalSlug}`);
    }
  }
}

main();
