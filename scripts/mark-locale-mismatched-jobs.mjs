#!/usr/bin/env node
/**
 * Mark jobs whose descriptionByLocale entries are stored under the wrong
 * locale with `needsRetranslation: true`, so the translate-pending pipeline
 * re-generates consistent translations on the next run.
 *
 * Detection mirrors tests/job-locale-consistency.test.ts: we use
 * `detectLanguageWithConfidence` from scripts/lib/detect-language.mjs and
 * flag any description ≥120 chars where the detected language differs from
 * the stored locale with confidence ≥0.65.
 *
 * PERSISTENCE — the part this script got wrong until 2026-08-11. It wrote the
 * flag to `data/jobs.json` ONLY. That file is a gitignored build artefact
 * re-assembled from `data/jobs/by-crawler/*.json` at the top of every run, so
 * every mark was discarded before the cascade could drain it: the same jobs
 * were re-detected and re-flagged five times a day, forever, and the
 * descriptions backlog never moved. Both writes are now required — see
 * scripts/lib/job-mark-persistence.mjs for the full account.
 *
 * NO CAP, DELIBERATELY. Its sibling `mark-mistranslated-jobs.mjs` carries a
 * per-run cap and a queue ceiling because the TITLE detector fires on ~22k jobs
 * and only the quota-bound AI cascade can repair them. Descriptions are two
 * orders of magnitude smaller (~100 offenders at the 2026-08-11 measurement)
 * and the dominant family here is the source-copy shape, which the free Argos
 * mop-up repairs without touching quota. Capping this pass would re-create the
 * stall it exists to clear.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { persistMarksToSlices } from './lib/job-mark-persistence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const LOCALES = ['it', 'en', 'de', 'fr'];

const jobs = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));
let flagged = 0;
const flaggedSlugs = new Set();
let slugless = 0;

for (const job of jobs) {
  // Skip jobs already flagged, and jobs the pipeline gave up on after repeated
  // failed retranslation runs (relocalize-pending-jobs sets localeMismatchSuppressed).
  // Re-flagging the latter is what made the needsRetranslation backlog loop forever.
  if (job.needsRetranslation || job.localeMismatchSuppressed) continue;
  let jobHasMismatch = false;
  for (const locale of LOCALES) {
    const description = String(job.descriptionByLocale?.[locale] || '').trim();
    if (description.length < 120) continue;
    const detected = detectLanguageWithConfidence(description, locale);
    if (detected.confidence >= 0.65 && detected.lang !== locale && LOCALES.includes(detected.lang)) {
      jobHasMismatch = true;
      break;
    }
  }
  if (jobHasMismatch) {
    job.needsRetranslation = true;
    flagged++;
    // The slice write matches on slug; a record without one can only ever be
    // marked in the artefact, so it is counted and reported rather than
    // silently folded into the success line.
    const slug = String(job.slug || '').trim();
    if (slug) flaggedSlugs.add(slug);
    else slugless += 1;
  }
}

if (flagged > 0) {
  writeJsonAtomic(DATA_JOBS_PATH, jobs);
  const {
    totalMarked, slicesChanged, unresolved, duplicated, racesResolved, racesLost,
  } = persistMarksToSlices(flaggedSlugs, { root: ROOT });
  console.log(`Flagged ${flagged} job(s) with needsRetranslation=true.`);
  console.log(`Persisted ${totalMarked} mark(s) across ${slicesChanged} committed slice(s).`);
  if (duplicated > 0) {
    // Not a failure — every copy was marked, which is the policy. It is
    // reported because a duplicated slug is the shape in which a mark gets
    // lost later: assembly keeps one copy per identity, and a crawler that
    // re-crawls the winning slice drops the flag from it (#5645).
    console.log(
      `ℹ️  ${duplicated} flagged slug(s) live in more than one committed slice; every copy was marked.`
    );
  }
  if (racesResolved > 0) {
    console.log(
      `ℹ️  ${racesResolved} slice write(s) were rebuilt on fresher bytes — another writer`
        + ' committed to the same slice mid-pass and its content was kept.'
    );
  }
  if (racesLost > 0) {
    console.warn(
      `⚠️  ${racesLost} slice(s) abandoned after ${racesLost === 1 ? 'a writer' : 'writers'} kept winning the`
        + ' compare-and-swap: those marks did NOT reach the committed half and will evaporate.'
    );
  }
  if (unresolved > 0 || slugless > 0) {
    // Loud on purpose: a mark that reached only the artefact is a mark that
    // will evaporate, which is exactly the failure this script was fixed for.
    console.warn(
      `⚠️  ${unresolved + slugless} flagged job(s) were not persisted to any slice`
        + ` (${slugless} without a slug, ${unresolved} with no matching slice record).`
        + ' Those marks live only in the build artefact and will not survive re-assembly.'
    );
  }
} else {
  console.log('No locale mismatches found.');
}