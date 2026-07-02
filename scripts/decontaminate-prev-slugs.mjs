#!/usr/bin/env node
/**
 * One-time decontamination pass for previousSlugs entries already
 * misattributed to the wrong job (see resolveRecoveryTarget in
 * backfill-prev-slugs-from-loss-events.mjs for the write-side guard that
 * prevents this going forward).
 *
 * Root cause: a loss event recorded during scan-prev-slug-losses.mjs's
 * git-history replay is keyed by a job.id snapshot up to 400 commits old.
 * backfill-prev-slugs-from-loss-events.mjs previously trusted that id was
 * still the same real posting today and wrote the recovered slug straight
 * onto whichever job currently holds it — corrupting an unrelated job's
 * previousSlugs whenever the id had been reused (e.g. a legacy collapsed-id
 * group later split by migrate-collapsed-job-ids.mjs, whose own
 * decontamination pass looked like a "loss" to the scan script and got
 * silently re-recovered onto the wrong job).
 *
 * This script re-validates every EXISTING previousSlugs / previousSlugsByLocale
 * entry against each job's own current stableSlugHash: entries that carry
 * another current job's disambiguator tail are moved to that job. Entries
 * whose tail matches no current job are left untouched — a trailing 6-char
 * segment with no confirmed owner isn't reliable evidence of contamination
 * (real slug words can coincidentally be 6 lowercase letters, e.g.
 * "-campus"), so there is no safe basis for dropping them.
 *
 * Usage:
 *   node scripts/decontaminate-prev-slugs.mjs            # dry-run report
 *   node scripts/decontaminate-prev-slugs.mjs --apply    # write changes
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableSlugHash } from './lib/dedicated-crawler-common.mjs';
import { resolveRecoveryTarget } from './backfill-prev-slugs-from-loss-events.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const APPLY = process.argv.includes('--apply');

function processFile(filePath) {
  const slice = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(slice.jobs)) return null;

  const bySuffixHash = new Map();
  for (const j of slice.jobs) {
    const h = stableSlugHash(j);
    if (h && !bySuffixHash.has(h)) bySuffixHash.set(h, j);
  }

  let moved = 0;
  const additions = new Map(); // targetJob -> locale -> Set(slug)

  const addToTarget = (targetJob, locale, slug) => {
    if (!additions.has(targetJob)) additions.set(targetJob, new Map());
    const localeMap = additions.get(targetJob);
    if (!localeMap.has(locale)) localeMap.set(locale, new Set());
    localeMap.get(locale).add(slug);
  };

  for (const job of slice.jobs) {
    const locales = job.previousSlugsByLocale;
    if (locales && typeof locales === 'object') {
      for (const [locale, arr] of Object.entries(locales)) {
        if (!Array.isArray(arr)) continue;
        const kept = [];
        for (const slug of arr) {
          const { targetJob, redirected } = resolveRecoveryTarget(job, slug, bySuffixHash);
          if (redirected) { moved++; addToTarget(targetJob, locale, slug); continue; }
          kept.push(slug);
        }
        locales[locale] = kept;
      }
    }
    if (Array.isArray(job.previousSlugs)) {
      job.previousSlugs = job.previousSlugs.filter((slug) => {
        const { redirected } = resolveRecoveryTarget(job, slug, bySuffixHash);
        return !redirected;
      });
    }
  }

  for (const [targetJob, localeMap] of additions) {
    if (!targetJob.previousSlugsByLocale || typeof targetJob.previousSlugsByLocale !== 'object') {
      targetJob.previousSlugsByLocale = {};
    }
    if (!Array.isArray(targetJob.previousSlugs)) targetJob.previousSlugs = [];
    for (const [locale, slugs] of localeMap) {
      if (!Array.isArray(targetJob.previousSlugsByLocale[locale])) targetJob.previousSlugsByLocale[locale] = [];
      for (const slug of slugs) {
        if (!targetJob.previousSlugsByLocale[locale].includes(slug)) targetJob.previousSlugsByLocale[locale].push(slug);
        if (!targetJob.previousSlugs.includes(slug)) targetJob.previousSlugs.push(slug);
      }
    }
  }

  if (moved === 0) return null;
  if (APPLY) writeJsonAtomic(filePath, slice);
  return { moved };
}

let totalMoved = 0;
let filesChanged = 0;
for (const name of fs.readdirSync(BY_CRAWLER_DIR).filter((f) => f.endsWith('.json'))) {
  const res = processFile(path.join(BY_CRAWLER_DIR, name));
  if (res) {
    filesChanged++;
    totalMoved += res.moved;
    console.log(`${name}: ${res.moved} moved`);
  }
}
console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${filesChanged} file(s), ${totalMoved} slug(s) redirected to their correct current owner.`);
if (!APPLY && filesChanged > 0) console.log('Re-run with --apply to write.');
