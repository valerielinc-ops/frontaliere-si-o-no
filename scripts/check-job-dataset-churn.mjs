#!/usr/bin/env node
/**
 * Job dataset churn guard CLI (#6702).
 *
 * Reads `data/jobs-stats-history.json` (already regenerated for "today" by
 * `assemble-jobs-dataset.mjs --stats`, which this script must run AFTER) and
 * flags a day whose `added`/`removed` blows past its own trailing baseline —
 * see `scripts/lib/job-dataset-churn-guard.mjs` for the detection method.
 *
 * Writes `data/job-dataset-churn-issues.json` (consumed by
 * `persist-job-stats.yml` to open a GitHub issue) when anomalies are found.
 *
 * Exit code:
 *   0 — no anomaly (or not enough history yet to judge)
 *   1 — one or more anomalies found (workflow will open an issue)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectChurnAnomalies } from './lib/job-dataset-churn-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'data', 'jobs-stats-history.json');
const ISSUES_PATH = path.join(ROOT, 'data', 'job-dataset-churn-issues.json');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`⚠️ Failed to parse ${path.relative(ROOT, filePath)}: ${error.message}`);
    return fallback;
  }
}

function main() {
  const history = readJson(HISTORY_PATH, { entries: [] });
  const anomalies = detectChurnAnomalies(history);

  if (anomalies.length === 0) {
    if (fs.existsSync(ISSUES_PATH)) fs.rmSync(ISSUES_PATH);
    console.log('✅ Job dataset churn within historical baseline.');
    return 0;
  }

  fs.writeFileSync(ISSUES_PATH, JSON.stringify(anomalies, null, 2));
  for (const anomaly of anomalies) {
    const hosts = anomaly.topHosts.map((h) => `${h.host} (${h.count})`).join(', ') || 'n/a';
    console.error(
      `🚨 ${anomaly.date}: ${anomaly.metric}=${anomaly.observed} vs baseline mean=${anomaly.baselineMean} ` +
      `stddev=${anomaly.baselineStddev} threshold=${anomaly.threshold} over ${anomaly.baselineDays}d — top hosts: ${hosts}`
    );
  }
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
