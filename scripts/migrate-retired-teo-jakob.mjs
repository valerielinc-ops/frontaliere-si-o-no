#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * One-shot, idempotent ownership handover from teo-jakob to teo-jakob-ag.
 *
 * Both keys were generated from detail-page seeds for the same Jobalino
 * tenant. The replacement crawler owns the tenant listing. This migration
 * canonicalises the retired detail URL to the same identity emitted by the
 * listing parser, rehomes its payload, and preserves every locale route.
 *
 * Usage:
 *   node scripts/migrate-retired-teo-jakob.mjs
 *   node scripts/migrate-retired-teo-jakob.mjs --apply
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  localeRouteKeys,
  mergeRetiredCrawlerJobs,
} from './reconcile-crawler-company-ownership.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RETIRED_KEY = 'teo-jakob';
const CANONICAL_KEY = 'teo-jakob-ag';
const JOBALINO_HOST = 'my.jobalino.ch';

function jobsOf(payload) {
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.jobs) ? payload.jobs : []);
}

function withJobs(payload, jobs) {
  return Array.isArray(payload) ? jobs : { ...payload, jobs };
}

export function canonicalizeTeoJakobJobalinoUrl(rawUrl = '') {
  const url = new URL(String(rawUrl || ''));
  if (url.hostname.toLowerCase() !== JOBALINO_HOST) {
    throw new Error('unexpected retired Teo Jakob host: ' + url.hostname);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const jobIndex = parts.indexOf('job');
  if (jobIndex < 0) throw new Error('unexpected retired Teo Jakob path: ' + url.pathname);
  let cursor = jobIndex + 1;
  let locale = '';
  if (/^(de|fr|it|en)$/i.test(parts[cursor] || '')) {
    locale = parts[cursor].toLowerCase();
    cursor += 1;
  }
  const vacancyId = parts[cursor] || '';
  cursor += 1;
  if (!/^[a-f0-9]{12,}$/i.test(vacancyId)) {
    throw new Error('missing Jobalino vacancy id in retired URL: ' + rawUrl);
  }
  if (parts[cursor] === CANONICAL_KEY) cursor += 1;
  const slug = parts[cursor] || '';
  if (!/^[a-z0-9_-]+$/i.test(slug)) {
    throw new Error('missing Jobalino vacancy slug in retired URL: ' + rawUrl);
  }
  const localePart = locale && locale !== 'de' ? locale + '/' : '';
  return 'https://' + JOBALINO_HOST + '/job/' + localePart + vacancyId + '/' + slug;
}

export function migrateRetiredTeoJakobJobs(canonicalJobs, retiredJobs) {
  const canonicalCompany = canonicalJobs[0]?.company || 'Teo Jakob AG';
  const rewrite = (job) => {
    const url = canonicalizeTeoJakobJobalinoUrl(job?.url);
    return {
      ...job,
      id: CANONICAL_KEY + '-' + createHash('sha1').update(url).digest('hex').slice(0, 12),
      company: canonicalCompany,
      companyKey: CANONICAL_KEY,
      companyDomain: JOBALINO_HOST,
      url,
      applyUrl: url,
      source: 'Teo Jakob AG Dedicated Parser (Jobalino)',
      sourceIdentity: 'url:' + url.toLowerCase().replace(/\/+$/, ''),
    };
  };
  // Canonicalise the surviving slice too: the old prospectored parser emitted
  // /job/{hash}/teo-jakob-ag/{slug}, while the listing emits
  // /job/{hash}/{slug}. Leaving the survivor untouched would duplicate its
  // first vacancy as soon as the repaired listing crawler runs.
  const rewrittenCanonical = canonicalJobs.map(rewrite);
  const rewrittenRetired = retiredJobs.map(rewrite);
  const result = mergeRetiredCrawlerJobs(rewrittenCanonical, rewrittenRetired, CANONICAL_KEY);
  const before = new Set([...canonicalJobs, ...retiredJobs].flatMap((job) => [...localeRouteKeys(job)]));
  const after = new Set(result.jobs.flatMap((job) => [...localeRouteKeys(job)]));
  const lost = [...before].filter((route) => !after.has(route));
  if (lost.length > 0) {
    throw new Error(lost.length + ' locale routes lost (' + lost.slice(0, 5).join(', ') + ')');
  }
  return {
    ...result,
    routesBefore: before.size,
    routesAfter: after.size,
  };
}

function main() {
  const apply = process.argv.includes('--apply');
  const canonicalFile = path.join(ROOT, 'data/jobs/by-crawler', CANONICAL_KEY + '.json');
  const retiredFile = path.join(ROOT, 'data/jobs/by-crawler', RETIRED_KEY + '.json');
  const retiredSummary = path.join(ROOT, 'data/jobs-crawler-summaries/by-crawler', RETIRED_KEY + '.json');
  if (!fs.existsSync(canonicalFile)) {
    throw new Error(CANONICAL_KEY + ' slice absent; refusing to delete retired jobs');
  }

  const canonical = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
  const retired = fs.existsSync(retiredFile)
    ? JSON.parse(fs.readFileSync(retiredFile, 'utf8'))
    : null;
  const canonicalJobs = jobsOf(canonical);
  const retiredJobs = jobsOf(retired);
  const result = migrateRetiredTeoJakobJobs(canonicalJobs, retiredJobs);
  const canonicalChanged = JSON.stringify(result.jobs) !== JSON.stringify(canonicalJobs);
  console.log(JSON.stringify({
    canonicalBefore: canonicalJobs.length,
    retired: retiredJobs.length,
    collapsed: result.collapsed,
    rehomed: result.rehomed,
    slugsTransferred: result.slugsTransferred,
    canonicalAfter: result.jobs.length,
    routesBefore: result.routesBefore,
    routesAfter: result.routesAfter,
  }));
  if (!apply) return;
  if (!retired && !canonicalChanged) {
    if (fs.existsSync(retiredSummary)) fs.rmSync(retiredSummary);
    console.log(RETIRED_KEY + ' slice already migrated: nothing to do');
    return;
  }

  writeJsonAtomic(canonicalFile, withJobs(canonical, result.jobs));
  if (fs.existsSync(retiredFile)) fs.rmSync(retiredFile);
  if (fs.existsSync(retiredSummary)) fs.rmSync(retiredSummary);
  console.log('applied');
}

if (process.argv[1] && (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})()) main();
