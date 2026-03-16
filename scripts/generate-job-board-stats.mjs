#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildJobsStatsArtifacts } from './lib/job-board-stats.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const DATA_HISTORY_PATH = path.join(ROOT, 'data', 'jobs-stats-history.json');
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

function readPreviousJobsFromHead() {
  try {
    const raw = execSync('git show HEAD:data/jobs.json', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function generateJobBoardStats(now = new Date().toISOString()) {
  const currentJobs = readJson(DATA_JOBS_PATH, []);
  const existingHistory = readJson(DATA_HISTORY_PATH, { version: 1, generatedAt: '', entries: [] });
  const previousJobs = Array.isArray(existingHistory?.entries) && existingHistory.entries.length > 0
    ? readPreviousJobsFromHead()
    : currentJobs;

  if (!Array.isArray(currentJobs)) {
    throw new Error('data/jobs.json must be a JSON array');
  }

  const { history, summary } = buildJobsStatsArtifacts({
    previousJobs,
    currentJobs,
    existingHistory,
    now,
  });

  writeJson(DATA_HISTORY_PATH, history, { compact: true });
  writeJson(DATA_SUMMARY_PATH, summary);
  writeJson(PUBLIC_SUMMARY_PATH, summary);

  return { history, summary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = generateJobBoardStats();
  console.log(`📈 Job board stats updated: ${result.summary.totals.activeJobs} active jobs, ${result.summary.history.length} daily points`);
}
