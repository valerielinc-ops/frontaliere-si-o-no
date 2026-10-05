#!/usr/bin/env node

/**
 * Measure the assembly Swiss-location gate without writing any job artifact.
 *
 * Usage:
 *   node scripts/audit-swiss-location-gate.mjs
 *   node scripts/audit-swiss-location-gate.mjs --json data/jobs/by-crawler
 */

import fs from 'node:fs';
import path from 'node:path';
import { applySwissLocationGate } from './assemble-jobs-dataset.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dataDir = path.resolve(args.find((arg) => !arg.startsWith('--')) || 'data/jobs/by-crawler');
const files = fs.readdirSync(dataDir)
  .filter((file) => file.endsWith('.json'))
  .sort();

const byReason = new Map();
const byLocality = new Map();
const byCrawler = new Map();
let totalJobs = 0;
let keptJobs = 0;
let malformedFiles = 0;

const increment = (map, key, amount = 1) => map.set(key, (map.get(key) || 0) + amount);

for (const file of files) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  } catch {
    malformedFiles++;
    continue;
  }
  if (!Array.isArray(payload?.jobs)) {
    malformedFiles++;
    continue;
  }

  totalJobs += payload.jobs.length;
  const result = applySwissLocationGate(payload.jobs);
  keptJobs += result.jobs.length;
  for (const row of result.dropped || []) {
    const job = row.job || {};
    const reason = row.reason || 'unknown';
    const locality = String(job.addressLocality || job.location || '').trim() || '(missing)';
    const crawler = String(payload.crawlerKey || job.companyKey || file.replace(/\.json$/, ''));
    increment(byReason, reason);
    increment(byCrawler, crawler);
    const entry = byLocality.get(locality) || { locality, total: 0, reasons: {} };
    entry.total++;
    entry.reasons[reason] = (entry.reasons[reason] || 0) + 1;
    byLocality.set(locality, entry);
  }
}

const sortCounts = (entries) => entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const report = {
  dataDir,
  files: files.length,
  malformedFiles,
  totalJobs,
  keptJobs,
  excludedJobs: totalJobs - keptJobs,
  exclusionRate: totalJobs ? Number(((totalJobs - keptJobs) / totalJobs * 100).toFixed(2)) : 0,
  byReason: Object.fromEntries(sortCounts([...byReason.entries()])),
  top20Localities: [...byLocality.values()]
    .sort((a, b) => b.total - a.total || a.locality.localeCompare(b.locality))
    .slice(0, 20),
  top10Crawlers: sortCounts([...byCrawler.entries()]).slice(0, 10)
    .map(([crawler, count]) => ({ crawler, count })),
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Swiss gate audit: ${report.dataDir}`);
  console.log(`files=${report.files} jobs=${report.totalJobs} kept=${report.keptJobs} excluded=${report.excludedJobs} rate=${report.exclusionRate}%`);
  console.log('by reason:');
  for (const [reason, count] of Object.entries(report.byReason)) console.log(`  ${reason}: ${count}`);
  console.log('top 20 localities:');
  for (const entry of report.top20Localities) console.log(`  ${entry.locality}: ${entry.total} (${JSON.stringify(entry.reasons)})`);
  if (report.malformedFiles > 0) console.log(`malformed files: ${report.malformedFiles}`);
}
