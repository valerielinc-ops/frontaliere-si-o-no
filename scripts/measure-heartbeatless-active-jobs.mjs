#!/usr/bin/env node
/**
 * Count active crawler-slice records with no `crawledAt` heartbeat, grouped
 * by crawler.
 *
 *   node scripts/measure-heartbeatless-active-jobs.mjs [--dir data/jobs/by-crawler] [--json] [--max N]
 *
 * "Active" is `crawlerJobActivity(job) === 'active'`: grace rows
 * (`crawlerMissStreak > 0`) and rows carrying `expiredAt` are excluded, the
 * same denominator the crawler quality metrics use. Since the slice writer
 * stamps every active row it observes (lib/job-observation-heartbeat.mjs), the
 * target is 0 once each crawler has completed one successful run; a crawler
 * that keeps a non-zero count has not written its slice since, or writes it
 * outside `writeJobsCrawlerSlice`.
 *
 * `--max N` exits 1 when the count is above N, so the measure can serve as a
 * gate. Read-only: it never writes a file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import { measureHeartbeatlessActiveJobs } from './lib/job-observation-heartbeat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { dir: path.join(ROOT, 'data', 'jobs', 'by-crawler'), json: false, max: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--dir') args.dir = path.resolve(argv[++i] || '');
    else if (token === '--max') {
      const value = Number.parseInt(argv[++i] || '', 10);
      if (!Number.isInteger(value) || value < 0) throw new Error('--max needs a non-negative integer');
      args.max = value;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  return args;
}

/**
 * @param {string} dir
 * @returns {Array<{ file: string, jobs: unknown[] }>}
 */
function readSlices(dir) {
  return listSliceFileNames(dir).map((file) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const jobs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.jobs) ? parsed.jobs : []);
    return { file, jobs };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dir)) throw new Error(`Slice directory not found: ${args.dir}`);
  const report = measureHeartbeatlessActiveJobs(readSlices(args.dir));
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Active records without crawledAt: ${report.heartbeatless} of ${report.active} active (${report.total} slice records)`);
    for (const entry of report.byCrawler) {
      console.log(`  ${entry.crawler}: ${entry.heartbeatless}/${entry.active}`);
    }
  }
  if (args.max !== null && report.heartbeatless > args.max) {
    console.error(`::error::${report.heartbeatless} active records without crawledAt (max ${args.max}).`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
