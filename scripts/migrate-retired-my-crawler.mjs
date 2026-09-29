#!/usr/bin/env node
/**
 * One-shot, idempotent retirement of the `my` crawler slice (issue 5253).
 *
 * `my` was a prospector spec keyed on the host label of my.jobalino.ch — a
 * key six different jobalino candidates were given — and promoted for
 * «Bellevue Parkhotel & Spa». The spec file was later overwritten by another
 * candidate's synthesis, so the production crawler published Fanzun AG's
 * «Initiativbewerbung» (a spontaneous-application form, not a vacancy) under
 * the Bellevue name. Bellevue's own page is also a «Spontanbewerbung». There
 * is no vacancy to keep and no crawler to hand the record to.
 *
 * The record is not re-published: it moves to the expired archive, where its
 * routes stay served as a soft landing (same path as the MPI AGE retirement,
 * #6901). The run aborts if any locale route would be lost.
 *
 * Re-running after the active slice is gone is a no-op; on a conflict with a
 * crawler commit, take `main`'s version of the slices and run it again.
 *
 * Usage (repo root):
 *   node scripts/migrate-retired-my-crawler.mjs          # dry-run
 *   node scripts/migrate-retired-my-crawler.mjs --apply  # write
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveRemovedJobsToSlice, localeRouteKeys } from './lib/expired-jobs-archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RETIRED_KEY = 'my';

/**
 * Archive the retired records in `expiredDir` and check that every locale
 * route they published is still served from the archive.
 *
 * @param {object[]} jobs  records of data/jobs/by-crawler/my.json
 * @param {string} expiredDir
 * @returns {{ archived: number, routesBefore: number, routesAfter: number }}
 */
export function archiveRetiredMyJobs(jobs, expiredDir) {
  const archived = archiveRemovedJobsToSlice(jobs, RETIRED_KEY, { dir: expiredDir });
  const file = path.join(expiredDir, `${RETIRED_KEY}.json`);
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const before = new Set(jobs.flatMap((job) => [...localeRouteKeys(job)]));
  const after = new Set(entries.flatMap((job) => [...localeRouteKeys(job)]));
  const lost = [...before].filter((route) => !after.has(route));
  if (lost.length) throw new Error(`${lost.length} locale routes lost (${lost.slice(0, 5).join(', ')})`);
  return { archived, routesBefore: before.size, routesAfter: after.size };
}

function main() {
  const apply = process.argv.includes('--apply');
  const activeFile = path.join(ROOT, 'data/jobs/by-crawler/my.json');
  const summaryFile = path.join(ROOT, 'data/jobs-crawler-summaries/by-crawler/my.json');
  const expiredDir = path.join(ROOT, 'data/jobs/expired/by-crawler');
  if (!fs.existsSync(activeFile)) {
    console.log('my slice already retired: nothing to do');
    if (apply && fs.existsSync(summaryFile)) fs.rmSync(summaryFile);
    return;
  }
  const payload = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
  const jobs = Array.isArray(payload) ? payload : payload.jobs || [];
  const dir = apply ? expiredDir : fs.mkdtempSync(path.join(os.tmpdir(), 'retire-my-'));
  const result = archiveRetiredMyJobs(jobs, dir);
  console.log(JSON.stringify({ active: jobs.length, ...result }));
  if (!apply) return;
  fs.rmSync(activeFile);
  if (fs.existsSync(summaryFile)) fs.rmSync(summaryFile);
  console.log('applied');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
