#!/usr/bin/env node
/**
 * One-shot, idempotent source switch for kanton-aargau (issue 5253).
 *
 * The crawler moves from the Umantis back office (tenant 12705, 423 rows,
 * ~110 posted 2020-2022, the same title under several ids, a synthesised
 * blurb as body) to the canton's official job market (ag.ch jobs-proxy +
 * jobs.ag.ch, 64-66 open vacancies with full ads). The two sources share no
 * vacancy identity, so every Umantis-era record would sit in miss grace and
 * then retire in one write of ~85%: the slice writer's shrink guard would
 * refuse it, and its source verification would find the Umantis application
 * forms still answering 200 — the crawler would stay stuck on the old slice.
 *
 * So the switch is done here, where it can be proven, instead of at crawl
 * time: every Umantis-era record moves to the expired archive (its routes
 * stay served as soft landings) and the active slice is left empty for the
 * first job-market crawl. Only 5 of the 66 job-market titles match an
 * Umantis title exactly, so there is no continuity worth carrying over. The
 * post-push byte guard accepts this commit as a proven archive move
 * (`isProvenArchiveMovePrune`: strict subset, every removed job archived with
 * a valid `expiredAt`). The run aborts if any locale route would be lost.
 *
 * Re-running is a no-op once the slice holds no Umantis-era record; on a
 * conflict with a crawler commit, take `main`'s slices and run it again.
 *
 * Usage (repo root):
 *   node scripts/migrate-kanton-aargau-to-job-market.mjs          # dry-run
 *   node scripts/migrate-kanton-aargau-to-job-market.mjs --apply  # write
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveRemovedJobsToSlice, localeRouteKeys } from './lib/expired-jobs-archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY = 'kanton-aargau';

/** A record written by the retired Umantis-tenant parser. */
export function isUmantisEraAargauJob(job) {
  return /recruitingapp-12705\.umantis\.com/i.test(String(job?.url || ''));
}

/**
 * @param {object[]} jobs      active slice records
 * @param {string} expiredDir  expired archive directory
 * @returns {{ kept: object[], archived: number, routesBefore: number, routesAfter: number }}
 */
export function archiveUmantisEraJobs(jobs, expiredDir) {
  const retired = jobs.filter(isUmantisEraAargauJob);
  const kept = jobs.filter((job) => !isUmantisEraAargauJob(job));
  const archived = retired.length ? archiveRemovedJobsToSlice(retired, KEY, { dir: expiredDir }) : 0;
  const file = path.join(expiredDir, `${KEY}.json`);
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const before = new Set(retired.flatMap((job) => [...localeRouteKeys(job)]));
  const after = new Set(entries.flatMap((job) => [...localeRouteKeys(job)]));
  const lost = [...before].filter((route) => !after.has(route));
  if (lost.length) throw new Error(`${lost.length} locale routes lost (${lost.slice(0, 5).join(', ')})`);
  return { kept, archived, routesBefore: before.size, routesAfter: [...before].filter((r) => after.has(r)).length };
}

function main() {
  const apply = process.argv.includes('--apply');
  const activeFile = path.join(ROOT, `data/jobs/by-crawler/${KEY}.json`);
  const expiredDir = path.join(ROOT, 'data/jobs/expired/by-crawler');
  if (!fs.existsSync(activeFile)) {
    console.log('no kanton-aargau slice: nothing to do');
    return;
  }
  const payload = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
  const jobs = Array.isArray(payload) ? payload : payload.jobs || [];
  if (!jobs.some(isUmantisEraAargauJob)) {
    console.log('kanton-aargau slice already on the job market: nothing to do');
    return;
  }
  let dir = expiredDir;
  if (!apply) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aargau-switch-'));
    const existing = path.join(expiredDir, `${KEY}.json`);
    if (fs.existsSync(existing)) fs.copyFileSync(existing, path.join(dir, `${KEY}.json`));
  }
  const result = archiveUmantisEraJobs(jobs, dir);
  console.log(JSON.stringify({ active: jobs.length, kept: result.kept.length, archived: result.archived, routesBefore: result.routesBefore, routesAfter: result.routesAfter }));
  if (!apply) return;
  const next = Array.isArray(payload) ? result.kept : { ...payload, jobs: result.kept };
  fs.writeFileSync(activeFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log('applied');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
