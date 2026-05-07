#!/usr/bin/env node
// scripts/backtest-scoring.mjs
//
// Phase 2 backtest harness — replays historical headlines through the
// new cascadedScore() against the current evidence index and compares
// the new top-1 picks against the actually-published articles.
//
// Inputs (priority order):
//   --headlines <path> — JSON file: [{ headline, slug?, publishedAt? }, ...]
//   --performance <path> — defaults to data/article-performance.json;
//     reads `articles[].title` + `articles[].slug` to synthesize
//     historical headlines.
//   --evidence <path> — defaults to data/evidence-index.json.
//   --window-days <n> — only include articles published in last n days
//     (default 60).
//   --output <path> — write JSON report to disk (default stdout).
//
// Output: comparison table (avg sessions of new-algo top-1 picks vs
// actual published articles).
//
// IMPORTANT: this script does NOT publish articles or call any external
// service except the embedding API (only when the cascade reaches the
// embedding stage on a candidate). Safe to run locally with prod data.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 5.10

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { cascadedScore } from './lib/scoring/cascadedScore.mjs';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const DEFAULT_PERF = resolve(REPO_ROOT, 'data/article-performance.json');
const DEFAULT_EVIDENCE = resolve(REPO_ROOT, 'data/evidence-index.json');
const DEFAULT_WINDOW_DAYS = 60;

function parseArgs(argv) {
  const args = { windowDays: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--headlines' && next) { args.headlines = next; i += 1; }
    else if (flag === '--performance' && next) { args.performance = next; i += 1; }
    else if (flag === '--evidence' && next) { args.evidence = next; i += 1; }
    else if (flag === '--window-days' && next) { args.windowDays = Number(next); i += 1; }
    else if (flag === '--output' && next) { args.output = next; i += 1; }
    else if (flag === '--max' && next) { args.max = Number(next); i += 1; }
    else if (flag === '--no-embedding') { args.noEmbedding = true; }
  }
  return args;
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`backtest: failed to parse ${path}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Synthesize a historical-headline list from `data/article-performance.json`.
 * Each entry: { headline, slug, publishedAt, actualSessions }.
 *
 * @param {object} perf — parsed article-performance.json contents.
 * @param {number} windowDays
 * @returns {Array<{headline:string, slug:string|null, publishedAt:string|null, actualSessions:number|null}>}
 */
export function synthesizeHistoricalHeadlines(perf, windowDays) {
  const articles = Array.isArray(perf?.articles) ? perf.articles : [];
  const cutoffMs = Date.now() - windowDays * 86_400_000;
  const out = [];
  for (const art of articles) {
    const title = art?.title || '';
    if (!title) continue;
    const ts = art?.publishedAt ? Date.parse(art.publishedAt) : NaN;
    if (Number.isFinite(ts) && ts < cutoffMs) continue;
    out.push({
      headline: title,
      slug: art?.slug || null,
      publishedAt: art?.publishedAt || null,
      actualSessions: Number.isFinite(Number(art?.metrics?.sessions))
        ? Number(art.metrics.sessions)
        : (Number.isFinite(Number(art?.sessions)) ? Number(art.sessions) : null),
    });
  }
  return out;
}

/**
 * Look up GA4 sessions for a slug from the evidence index.
 *
 * @param {string|null} slug
 * @param {object} evidence
 * @returns {number|null}
 */
export function lookupActualSessions(slug, evidence) {
  if (!slug) return null;
  const pages = evidence?.ga4?.pages || {};
  const candidates = [
    `/articoli-frontaliere/${slug}/`,
    `/articoli-frontaliere/${slug}`,
  ];
  for (const path of candidates) {
    const entry = pages[path];
    if (entry && Number.isFinite(Number(entry.sessions))) return Number(entry.sessions);
  }
  return null;
}

/**
 * Run the cascade against every historical headline, compute summary
 * statistics, and emit a JSON report.
 *
 * @param {Array<{headline:string, slug:string|null, publishedAt:string|null, actualSessions:number|null}>} historical
 * @param {object} evidence
 * @param {{ noEmbedding?: boolean, max?: number }} [opts]
 * @returns {Promise<object>} report
 */
export async function runBacktest(historical, evidence, opts = {}) {
  const cap = Number.isFinite(Number(opts.max)) ? Number(opts.max) : historical.length;
  const limited = historical.slice(0, cap);

  // Embed-fn override: --no-embedding short-circuits the embedding stage
  // so the run completes without hitting OpenAI (useful when the only
  // goal is to verify GSC + cluster coverage).
  const cascadeOpts = opts.noEmbedding ? { embedFn: async () => null } : {};

  const scored = [];
  for (const entry of limited) {
    let breakdown;
    try {
      breakdown = await cascadedScore(entry.headline, evidence, cascadeOpts);
    } catch (err) {
      console.error(`backtest: cascade failed for "${entry.headline.slice(0, 60)}": ${err?.message || err}`);
      continue;
    }
    if (!breakdown) continue;
    scored.push({
      headline: entry.headline,
      slug: entry.slug,
      actualSessions: entry.actualSessions ?? lookupActualSessions(entry.slug, evidence),
      stage: breakdown.stage,
      rawScore: breakdown.rawScore,
      confidence: breakdown.confidence,
      finalScore: breakdown.finalScore,
    });
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);

  const stageCounts = scored.reduce((acc, s) => {
    acc[s.stage] = (acc[s.stage] || 0) + 1;
    return acc;
  }, {});

  // "New algo" pick = top by finalScore. "Old algo" pick = the actually-
  // published article (proxy until we wire live-replay vs the legacy
  // scorer). Both averages are over the SAME headline set so the diff
  // reveals whether the cascade pushes high-traffic headlines to the top.
  const top10 = scored.slice(0, 10);
  const avgNew = mean(top10.map((s) => s.actualSessions).filter(Number.isFinite));
  const allReal = scored.map((s) => s.actualSessions).filter(Number.isFinite);
  const avgAll = mean(allReal);

  return {
    runAt: new Date().toISOString(),
    inputHeadlineCount: historical.length,
    scoredCount: scored.length,
    stageCounts,
    avgSessionsTop10New: Number.isFinite(avgNew) ? Number(avgNew.toFixed(2)) : null,
    avgSessionsAllPublished: Number.isFinite(avgAll) ? Number(avgAll.toFixed(2)) : null,
    improvementRatio: (Number.isFinite(avgNew) && Number.isFinite(avgAll) && avgAll > 0)
      ? Number((avgNew / avgAll).toFixed(3))
      : null,
    sample: scored.slice(0, 20),
  };
}

function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidencePath = args.evidence || DEFAULT_EVIDENCE;
  const evidence = loadJson(evidencePath);
  if (!evidence) {
    console.error(`backtest: evidence index missing at ${evidencePath}`);
    process.exit(1);
  }

  let historical;
  if (args.headlines) {
    historical = loadJson(args.headlines);
    if (!Array.isArray(historical)) {
      console.error(`backtest: --headlines must be a JSON array`);
      process.exit(1);
    }
  } else {
    const perf = loadJson(args.performance || DEFAULT_PERF);
    if (!perf) {
      console.error(`backtest: no input headlines (pass --headlines or ensure ${args.performance || DEFAULT_PERF} exists)`);
      process.exit(1);
    }
    historical = synthesizeHistoricalHeadlines(perf, args.windowDays);
  }
  if (historical.length === 0) {
    console.error('backtest: 0 historical headlines — nothing to score');
    process.exit(1);
  }

  console.error(`backtest: scoring ${historical.length} historical headlines`);
  const report = await runBacktest(historical, evidence, {
    noEmbedding: args.noEmbedding,
    max: args.max,
  });

  const json = JSON.stringify(report, null, 2);
  if (args.output) {
    writeFileSync(args.output, json + '\n');
    console.error(`backtest: report → ${args.output}`);
  } else {
    process.stdout.write(json + '\n');
  }
  process.exit(0);
}

const isDirect = (() => {
  try {
    return resolve(process.argv[1] || '') === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((err) => {
    console.error(`backtest: uncaught ${err?.message || err}`);
    process.exit(1);
  });
}
