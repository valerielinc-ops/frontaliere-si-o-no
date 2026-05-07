#!/usr/bin/env node
/**
 * profile-cluster-emission.mjs
 *
 * Standalone profiler for the related-search clusters plugin's matching
 * phase. Reads the same inputs the plugin reads (data/jobs.json,
 * data/related-search-candidates.json, data/related-search-enriched.json),
 * runs the AND/OR-fill matching logic for each candidate at a configurable
 * frequency floor, and reports:
 *
 *   - candidates passing the floor
 *   - clusters surviving the per-page MIN_MATCHING_JOBS=3 quality gate
 *   - estimated total HTML emission size (avg page weight × N pages)
 *   - matching-phase wall time + RSS peak
 *
 * Why a standalone script:
 *   - The full vite build OOMs at low floors because of cumulative memory
 *     pressure from OTHER plugins (jobsSeoPagesPlugin, static-pages, etc.)
 *     processing ~120k pages alongside our cluster pages. We want to
 *     isolate the cluster plugin's contribution.
 *   - Standalone runs in seconds (no vite, no other plugins, no HTML
 *     emission) so the experiment workflow finishes quickly and we can
 *     iterate on floor settings without burning 12+ min of runner time.
 *
 * The matching logic is duplicated from build-plugins/relatedSearchClustersPlugin.ts
 * (same constants, same normalize/tokenize/score functions). If the plugin
 * changes, this script must be kept in sync — the workflow asserts the
 * baseline numbers don't drift unexpectedly.
 *
 * Usage:
 *   node scripts/profile-cluster-emission.mjs              # default sweep [1,2,3,5,10]
 *   node scripts/profile-cluster-emission.mjs --floor=3    # single floor
 *   node scripts/profile-cluster-emission.mjs --json       # machine-readable output
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Constants — keep in sync with build-plugins/relatedSearchClustersPlugin.ts
const MIN_MATCHING_JOBS = 3;
const MAX_JOBS_PER_PAGE = 30;
const SUPPORTED_LOCALES = ['it', 'en', 'de', 'fr'];

// ── CLI args
const args = process.argv.slice(2);
const getArg = (name) => {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
};
const SINGLE_FLOOR = Number(getArg('--floor') ?? '');
const JSON_OUT = args.includes('--json');
const FLOORS = Number.isFinite(SINGLE_FLOOR) && SINGLE_FLOOR > 0
  ? [SINGLE_FLOOR]
  : [1, 2, 3, 5, 10];

// ── Match helpers (duplicated from plugin)
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function tokenizeQuery(query) {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2);
}

function queryMatchScore(haystack, queryTokens) {
  if (queryTokens.length === 0) return 0;
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score++;
  }
  return score;
}

function buildJobHaystack(job, locale) {
  const title = job.titleByLocale?.[locale] ?? job.title ?? '';
  const description = job.descriptionByLocale?.[locale] ?? job.description ?? '';
  return normalizeText(`${title} ${job.company ?? ''} ${job.location ?? ''} ${description}`);
}

function jobIdentity(job) {
  return job.slug || job.id || `${job.company}-${job.title}`;
}

// ── Loaders
function loadJSON(file) {
  const full = path.join(ROOT, 'data', file);
  if (!fs.existsSync(full)) {
    console.error(`[profile] missing input: ${full}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(full, 'utf-8'));
}

function loadCandidates() {
  const raw = loadJSON('related-search-candidates.json');
  return Array.isArray(raw?.candidates) ? raw.candidates : [];
}

function loadJobs() {
  const raw = loadJSON('jobs.json');
  return Array.isArray(raw?.jobs) ? raw.jobs : (Array.isArray(raw) ? raw : []);
}

// ── Filter
function filterAndDedupeCandidates(all, minJobCount) {
  const passing = all.filter((c) =>
    c.jobCount >= minJobCount
    && c.editorialCollision === null
    && Array.isArray(c.sampleTerms)
    && c.sampleTerms.length > 0
    && SUPPORTED_LOCALES.includes(c.locale),
  );
  const bySlug = new Map();
  for (const c of passing) {
    const key = `${c.locale}::${c.slug}`;
    const existing = bySlug.get(key);
    if (!existing || (c.jobCount > existing.jobCount)) bySlug.set(key, c);
  }
  return Array.from(bySlug.values());
}

// ── Per-cluster match (mirrors plugin's buildClusterContext but only counts)
function countMatchesForCluster(candidate, jobs, haystackCache) {
  const sampleTerm = (candidate.sampleTerms || [])[0] || '';
  if (!sampleTerm) return 0;
  const tokens = tokenizeQuery(sampleTerm);
  if (tokens.length === 0) return 0;

  const fullScore = tokens.length;
  let andCount = 0;
  let orCount = 0;
  for (const job of jobs) {
    const cacheKey = `${candidate.locale}::${jobIdentity(job)}`;
    let haystack = haystackCache.get(cacheKey);
    if (haystack === undefined) {
      haystack = buildJobHaystack(job, candidate.locale);
      haystackCache.set(cacheKey, haystack);
    }
    const score = queryMatchScore(haystack, tokens);
    if (score === fullScore) andCount++;
    else if (score > 0) orCount++;
  }
  // AND first up to cap, then fill with OR
  return Math.min(andCount + orCount, MAX_JOBS_PER_PAGE);
}

// ── Main sweep
function runSweep() {
  const t0 = process.hrtime.bigint();
  const candidatesAll = loadCandidates();
  const jobs = loadJobs();
  const tLoad = Number(process.hrtime.bigint() - t0) / 1e6;

  const results = [];
  for (const floor of FLOORS) {
    const tStart = process.hrtime.bigint();
    const cands = filterAndDedupeCandidates(candidatesAll, floor);
    const haystackCache = new Map();
    let surviving = 0;
    let totalMatches = 0;
    for (const c of cands) {
      const matches = countMatchesForCluster(c, jobs, haystackCache);
      if (matches >= MIN_MATCHING_JOBS) {
        surviving++;
        totalMatches += matches;
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - tStart) / 1e6;
    const memMb = Math.round(process.memoryUsage().rss / 1e6);
    // Empirical: a cluster page weighs ~140 KB on disk (mid-range). Cluster
    // plugin emit time observed = ~13 s for 18,711 pages = ~0.7 ms/page.
    const estDistMb = Math.round((surviving * 140) / 1024);
    const estEmitSec = (surviving * 0.7) / 1000;
    results.push({
      floor,
      candidatesAfterFloor: cands.length,
      clustersSurviving: surviving,
      avgMatchesPerCluster: surviving === 0 ? 0 : Math.round((totalMatches / surviving) * 10) / 10,
      matchingPhaseMs: Math.round(elapsedMs),
      rssMb: memMb,
      estDistMb,
      estEmitSec: Math.round(estEmitSec * 10) / 10,
    });
  }

  return {
    inputs: {
      totalCandidates: candidatesAll.length,
      totalJobs: jobs.length,
      loadMs: Math.round(tLoad),
    },
    results,
  };
}

const out = runSweep();
if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`Loaded ${out.inputs.totalCandidates.toLocaleString()} candidates, ${out.inputs.totalJobs.toLocaleString()} jobs in ${out.inputs.loadMs} ms\n`);
  console.log('floor  cands→  surviving  avg-listings  match-time   RSS    est-dist  est-emit');
  console.log('─────  ──────  ─────────  ────────────  ──────────  ─────  ────────  ────────');
  for (const r of out.results) {
    const f = String(r.floor).padStart(4);
    const c = String(r.candidatesAfterFloor).padStart(6);
    const s = String(r.clustersSurviving).padStart(9);
    const a = String(r.avgMatchesPerCluster).padStart(12);
    const t = `${r.matchingPhaseMs} ms`.padStart(10);
    const m = `${r.rssMb} MB`.padStart(5);
    const d = `${r.estDistMb} MB`.padStart(8);
    const e = `${r.estEmitSec} s`.padStart(8);
    console.log(`${f}    ${c}  ${s}  ${a}  ${t}  ${m}  ${d}  ${e}`);
  }
  console.log('\nNotes:');
  console.log('  surviving  = clusters with ≥3 matching jobs (AND-tier + OR-fill)');
  console.log('  est-dist   = surviving × 140 KB (avg HTML page weight from prior builds)');
  console.log('  est-emit   = surviving × 0.7 ms (observed plugin emit rate)');
  console.log('  these estimate the cluster plugin\'s ISOLATED footprint — full-build OOM');
  console.log('  came from cumulative pressure with downstream plugins, not this plugin alone.');
}
