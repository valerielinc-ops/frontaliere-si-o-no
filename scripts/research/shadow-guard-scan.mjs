#!/usr/bin/env node
/**
 * shadow-guard-scan.mjs — PHASE 1, READ-ONLY. Exhaustive, deterministic census
 * of the queue: how many slots the CURRENT `existing-good` guard blocks, and how
 * many of those the LANGUAGE-AWARE guard would stop blocking.
 *
 * Needs no Argos and no LLM, because `existingIsBad` does not look at the
 * candidate: whether the current guard blocks a slot is decided entirely by
 * `existing` and `sourceText`. So the ceiling of the change is computable over
 * the WHOLE corpus, not a sample. What the sample is still needed for is the
 * other half — whether the CANDIDATE survives the new candidate-side check.
 *
 * Writes nothing to data/.
 */
import fs from 'node:fs';
import path from 'node:path';

import { listSliceFileNames } from '../lib/crawler-slice-files.mjs';
import { needsWork, missingSlots } from '../local-mt-mopup.mjs';
import { titleLooksUntranslated } from '../lib/job-locale-utils.mjs';

const MIN_DESC_CHARS = 120;
const MIN_TITLE_CHARS = 3;

const slicesDir = process.argv[2];
const outPath = process.argv[3] || '/dev/stdout';
if (!slicesDir || !fs.existsSync(slicesDir)) {
  console.error('usage: shadow-guard-scan.mjs <slices-dir> [out.json]');
  process.exit(1);
}

const add = (o, k) => { o[k] = (o[k] || 0) + 1; };

const stats = {
  scannedJobs: 0,
  candidateJobs: 0,
  slots: 0,
  slotsByField: {},
  slotsByLocale: {},
  // The slot has a non-empty existing value that the CURRENT guard calls good.
  blockedByExistingGood: 0,
  blockedByField: {},
  blockedByLocale: {},
  // Of those, the ones the language-aware guard would unblock.
  unblocked: 0,
  unblockedByField: {},
  unblockedByLocale: {},
  unblockedByReason: {},
  unblockedByCompany: {},
  blockedCompanies: {},
  // slot was queued because of titleLooksUntranslated in the first place
  queuedByLanguage: 0,
};

const companyKey = (job) => String(job?.company || '').trim().toLowerCase().replace(/\s+/g, ' ') || '(unknown)';

for (const file of listSliceFileNames(slicesDir)) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(slicesDir, file), 'utf-8')); } catch { continue; }
  if (!data || !Array.isArray(data.jobs)) continue;
  for (const job of data.jobs) {
    stats.scannedJobs++;
    if (!needsWork(job)) continue;
    const slots = missingSlots(job);
    if (!slots.length) continue;
    stats.candidateJobs++;
    const srcLang = job.sourceLang || 'it';
    const sourceTitle = (job.title || job.titleByLocale?.[srcLang] || '').trim();
    const sourceDesc = (job.description || job.descriptionByLocale?.[srcLang] || '').trim();
    for (const { locale, field } of slots) {
      const sourceText = field === 'title' ? sourceTitle : sourceDesc;
      if (!sourceText) continue;
      const bag = field === 'title' ? 'titleByLocale' : 'descriptionByLocale';
      const existing = String(job[bag]?.[locale] || '').trim();
      stats.slots++;
      add(stats.slotsByField, field);
      add(stats.slotsByLocale, locale);

      const verdict = field === 'title'
        ? titleLooksUntranslated({
            title: existing,
            sourceTitle,
            sourceLang: srcLang,
            targetLocale: locale,
            company: job.company || '',
            location: job.location || '',
          })
        : { untranslated: false, reason: 'n/a-description' };
      if (verdict.untranslated) stats.queuedByLanguage++;

      const oldExistingIsBad = existing.length < (field === 'title' ? MIN_TITLE_CHARS : MIN_DESC_CHARS)
        || existing.toLowerCase() === sourceText.toLowerCase();
      if (!existing || oldExistingIsBad) continue; // the guard never blocks here

      stats.blockedByExistingGood++;
      add(stats.blockedByField, field);
      add(stats.blockedByLocale, locale);
      add(stats.blockedCompanies, companyKey(job));

      if (!verdict.untranslated) continue;
      stats.unblocked++;
      add(stats.unblockedByField, field);
      add(stats.unblockedByLocale, locale);
      add(stats.unblockedByReason, verdict.reason);
      add(stats.unblockedByCompany, companyKey(job));
    }
  }
}

stats.blockedCompaniesCount = Object.keys(stats.blockedCompanies).length;
stats.unblockedCompaniesCount = Object.keys(stats.unblockedByCompany).length;
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
stats.topUnblockedCompanies = top(stats.unblockedByCompany, 20);
delete stats.blockedCompanies;
delete stats.unblockedByCompany;

fs.writeFileSync(outPath, JSON.stringify(stats, null, 2) + '\n');
console.error(`slots=${stats.slots} blocked=${stats.blockedByExistingGood} unblocked=${stats.unblocked}`);
