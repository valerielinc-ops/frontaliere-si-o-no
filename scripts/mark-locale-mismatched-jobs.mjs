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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');
const LOCALES = ['it', 'en', 'de', 'fr'];

const jobs = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));
let flagged = 0;

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
  }
}

if (flagged > 0) {
  writeJsonAtomic(DATA_JOBS_PATH, jobs);
  console.log(`Flagged ${flagged} job(s) with needsRetranslation=true.`);
} else {
  console.log('No locale mismatches found.');
}
