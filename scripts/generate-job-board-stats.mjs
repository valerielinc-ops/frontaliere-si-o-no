#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildJobsStatsArtifacts, buildJobKeysSnapshot } from './lib/job-board-stats.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const DATA_HISTORY_PATH = path.join(ROOT, 'data', 'jobs-stats-history.json');
const DATA_KEYS_SNAPSHOT_PATH = path.join(ROOT, 'data', 'jobs-keys-snapshot.json');
const DATA_SUMMARY_PATH = path.join(ROOT, 'data', 'jobs-stats.json');
const PUBLIC_SUMMARY_PATH = path.join(ROOT, 'public', 'data', 'jobs-stats.json');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`⚠️ Failed to parse ${path.relative(ROOT, filePath)}: ${error.message}`);
    return fallback;
  }
}

function writeJson(filePath, value, { compact = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  fs.writeFileSync(filePath, json + '\n', 'utf8');
}

/**
 * Reconstruct a minimal synthetic job object from a stable identity key so that
 * computeJobDiff can identify which jobs were present in the previous run.
 * We only need the fields that buildStableJobIdentity reads.
 */
function syntheticJobFromKey(key) {
  if (key.startsWith('url:')) return { url: key.slice(4) };
  if (key.startsWith('id:')) return { id: key.slice(3) };
  if (key.startsWith('slug:')) return { slug: key.slice(5) };
  if (key.startsWith('fallback:')) {
    try { return JSON.parse(key.slice(9)); } catch { /* fall through */ }
  }
  return {};
}

export function generateJobBoardStats(now = new Date().toISOString()) {
  const currentJobs = readJson(DATA_JOBS_PATH, []);
  const existingHistory = readJson(DATA_HISTORY_PATH, { version: 1, generatedAt: '', entries: [] });

  if (!Array.isArray(currentJobs)) {
    throw new Error('data/jobs.json must be a JSON array');
  }

  // Compute diff using a persisted keys snapshot rather than git-show (jobs.json is gitignored).
  // On first run (no snapshot), treat as bootstrap: no diff so no inflated added counts.
  const previousKeysList = readJson(DATA_KEYS_SNAPSHOT_PATH, null);
  const previousJobs = previousKeysList !== null
    ? previousKeysList.map(syntheticJobFromKey)
    : currentJobs; // bootstrap: no diff

  const { history, summary } = buildJobsStatsArtifacts({
    previousJobs,
    currentJobs,
    existingHistory,
    now,
  });

  writeJson(DATA_HISTORY_PATH, history, { compact: true });
  writeJson(DATA_SUMMARY_PATH, summary);
  writeJson(PUBLIC_SUMMARY_PATH, summary);

  // Persist a compact snapshot of current job keys so the next run can compute an accurate diff.
  writeJson(DATA_KEYS_SNAPSHOT_PATH, buildJobKeysSnapshot(currentJobs));

  return { history, summary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = generateJobBoardStats();
  console.log(`📈 Job board stats updated: ${result.summary.totals.activeJobs} active jobs, ${result.summary.history.length} daily points`);
}
