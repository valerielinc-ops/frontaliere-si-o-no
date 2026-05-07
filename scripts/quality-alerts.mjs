#!/usr/bin/env node
// scripts/quality-alerts.mjs
//
// Phase 5 — quality-alerts daily runner. Loads evidence, quota state, the
// last N article sidecars and embedding meta, dispatches the four detector
// categories, applies snoozer logic, writes the GitHub job summary, and
// exits 1 when any P0/P1 alert is active (so the workflow fails and
// GitHub's native email goes out).
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 8

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectAlgorithm } from './lib/alerts/detectors/algorithm.mjs';
import { detectPipeline } from './lib/alerts/detectors/pipeline.mjs';
import { detectOutput } from './lib/alerts/detectors/output.mjs';
import { detectCost } from './lib/alerts/detectors/cost.mjs';
import {
  applySnoozer,
  loadSnoozes,
  saveSnoozes,
  updateSnoozeState,
} from './lib/alerts/snoozer.mjs';
import { writeJobSummary } from './lib/alerts/summaryWriter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

export const DEFAULT_PATHS = {
  evidenceIndex: join(ROOT, 'data', 'evidence-index.json'),
  embeddingsMeta: join(ROOT, 'data', 'article-embeddings-meta.json'),
  quotaState: join(ROOT, 'data', 'quota-state.json'),
  alertConfig: join(ROOT, 'data', 'alert-config.json'),
  alertSnoozes: join(ROOT, 'data', 'alert-snoozes.json'),
  alertsHistory: join(ROOT, 'data', 'quality-alerts-history.jsonl'),
  blogArticlesDir: join(ROOT, 'data', 'blog-articles'),
  blogMetaIt: join(ROOT, 'services', 'locales', 'blog-meta-it.ts'),
};

function safeReadJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function safeMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Read article sidecars from data/blog-articles/. Each file is JSON with
 * fields { slug, publishedAt, cluster, _pool, _pool_source, _score_breakdown }.
 * Tolerates missing dir / malformed entries.
 */
export function loadArticleSidecars(dir) {
  const out = [];
  try {
    if (!existsSync(dir)) return out;
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (!meta || typeof meta !== 'object') continue;
        if (!meta.slug) {
          const slugFromFile = f.replace(/\.json$/, '');
          meta.slug = slugFromFile;
        }
        out.push(meta);
      } catch {
        // skip malformed file
      }
    }
  } catch {
    // ignore — empty list returned
  }
  return out;
}

/**
 * Count articles in services/locales/blog-meta-it.ts by counting unique
 * slugs in `'blog.article.<slug>.title'` keys.
 */
export function countBlogMetaItArticles(path) {
  try {
    const src = readFileSync(path, 'utf-8');
    const re = /['"]blog\.article\.([a-z0-9-]+)\.title['"]/g;
    const slugs = new Set();
    let m;
    while ((m = re.exec(src))) slugs.add(m[1]);
    return slugs.size;
  } catch {
    return null;
  }
}

function appendHistory(path, alerts, now) {
  const stamp = new Date(now).toISOString();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const lines = alerts.map((a) => JSON.stringify({
      timestamp: stamp,
      id: a.id,
      severity: a.severity,
      message: a.message,
      evidence: a.evidence ?? null,
    }));
    if (lines.length === 0) {
      appendFileSync(path, `${JSON.stringify({ timestamp: stamp, id: 'heartbeat', severity: 'P3', message: 'no alerts' })}\n`, 'utf-8');
    } else {
      appendFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
    }
  } catch (err) {
    console.warn(`[history] append failed: ${err?.message || err}`);
  }
}

function readHistoryEntries(path, now) {
  const out = [];
  try {
    if (!existsSync(path)) return out;
    const raw = readFileSync(path, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && entry.timestamp) out.push(entry);
      } catch {
        // skip malformed
      }
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Read recent workflow log lines if a path is provided via env var. Used
 * only by D.4 (free-model exhausted heuristic). When unavailable, returns
 * an empty list and D.4 silently no-ops.
 */
function readRecentLogs() {
  const envPath = process.env.RECENT_LOGS_PATH;
  if (!envPath) return [];
  try {
    return readFileSync(envPath, 'utf-8').split('\n');
  } catch {
    return [];
  }
}

/**
 * Pure runner — returns the result object. Side-effecting `main()` wraps
 * this and writes to disk + sets the process exit code.
 *
 * @param {object} [opts] - test-time overrides for paths and clock
 */
export async function run(opts = {}) {
  const paths = { ...DEFAULT_PATHS, ...(opts.paths || {}) };
  const now = opts.now ?? Date.now();

  const evidence = safeReadJson(paths.evidenceIndex, {});
  const quotaState = safeReadJson(paths.quotaState, {});
  const config = safeReadJson(paths.alertConfig, {});
  const snoozeState = loadSnoozes({ path: paths.alertSnoozes });
  const embeddingsMeta = safeReadJson(paths.embeddingsMeta, null);
  const articles = opts.articles ?? loadArticleSidecars(paths.blogArticlesDir);
  const recentLogs = opts.recentLogs ?? readRecentLogs();
  const alertHistory = readHistoryEntries(paths.alertsHistory, now);

  const allAlerts = [];
  allAlerts.push(...detectAlgorithm({ articles, evidence, quotaState, config, now }));
  allAlerts.push(...detectPipeline({
    evidence,
    articles,
    evidenceIndexPath: paths.evidenceIndex,
    config,
    now,
    readMtime: opts.readMtime || safeMtime,
    countBlogArticles: opts.countBlogArticles || (() => countBlogMetaItArticles(paths.blogMetaIt)),
    embeddingsCount: opts.embeddingsCount || (() => (embeddingsMeta && Number.isFinite(embeddingsMeta.count) ? embeddingsMeta.count : null)),
  }));
  allAlerts.push(...detectOutput({ articles, evidence, quotaState, config, now }));
  allAlerts.push(...detectCost({ evidence, embeddingsMeta, alertHistory, recentLogs, config, now }));

  const { activeAlerts, snoozedAlerts } = applySnoozer(allAlerts, snoozeState, { now });
  const newSnoozeState = updateSnoozeState(snoozeState, allAlerts, config, { now });

  // Meta-alert when too many P0/P1 fire at once.
  const p0p1Count = activeAlerts.filter((a) => a.severity === 'P0' || a.severity === 'P1').length;
  if (p0p1Count >= (config.meta_alert_count_threshold || 5)) {
    activeAlerts.push({
      id: 'meta.system-distress',
      severity: 'P0',
      message: `${p0p1Count} P0/P1 alerts triggered simultaneously — system in distress`,
      mitigation: 'Pause article generation; run /investigate before next cron tick',
      evidence: { p0p1Count, threshold: config.meta_alert_count_threshold || 5 },
    });
  }

  if (!opts.dryRun) {
    saveSnoozes(newSnoozeState, { path: paths.alertSnoozes });
    appendHistory(paths.alertsHistory, allAlerts, now);
  }

  const summary = writeJobSummary(activeAlerts, snoozedAlerts, { now, targetPath: opts.summaryPath });
  const hasP0OrP1 = activeAlerts.some((a) => a.severity === 'P0' || a.severity === 'P1');

  return {
    activeAlerts,
    snoozedAlerts,
    newSnoozeState,
    summary,
    exitCode: hasP0OrP1 ? 1 : 0,
  };
}

async function main() {
  const result = await run();
  console.error(`QUALITY_ALERTS active=${result.activeAlerts.length} snoozed=${result.snoozedAlerts.length} exit=${result.exitCode}`);
  process.exit(result.exitCode);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error('quality-alerts crashed:', err);
    process.exit(1);
  });
}
