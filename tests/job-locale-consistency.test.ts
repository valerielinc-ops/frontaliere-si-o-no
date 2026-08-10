/**
 * job-locale-consistency — rate-based ratchets on wrong-language job content.
 *
 * Both assertions ratchet on a RATE, never on an absolute count. An absolute
 * threshold flickers in this repo as the dataset grows: the same defect density
 * crosses a fixed count purely because more jobs were crawled, so the gate goes
 * red for a reason nobody caused and gets raised instead of fixed. A rate moves
 * only when the *quality* moves.
 *
 * HISTORY. The description assertion was `it.skip(...)` from 2026-05-19 to
 * 2026-08-10 with a TODO describing this exact bug class ("translator pipeline
 * marked them translated without translating"), and it only ever inspected
 * descriptions — so the wrong-language TITLE defect that shipped German `<h1>`
 * on Italian pages had no gate at all. Un-skipped here, converted to a rate,
 * and extended to titles via `titleLooksUntranslated()`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectLanguageWithConfidence } from '../scripts/lib/detect-language.mjs';
import { titleLooksUntranslated } from '../scripts/lib/job-locale-utils.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');

interface Job {
  company?: string;
  slug?: string;
  title?: string;
  location?: string;
  sourceLang?: string;
  needsRetranslation?: boolean;
  localeMismatchSuppressed?: boolean;
  titleByLocale?: Record<string, string>;
  descriptionByLocale?: Record<string, string>;
}

// data/jobs.json is a gitignored build artefact: CI assembles it before vitest
// (.github/workflows/tests.yml "Assemble data/jobs.json"), but a sparse worktree
// does not have it and must not go red for that. Load defensively and skip with
// a loud message instead of throwing at describe-evaluation time, which is what
// the previous version did.
function loadJobs(): Job[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

describe('job-locale-consistency', () => {
  const jobs = loadJobs();
  const hasDataset = jobs !== null;
  if (!hasDataset) {
    console.warn(
      '[job-locale-consistency] data/jobs.json absent — ratchets skipped. '
        + 'Run `node scripts/assemble-jobs-dataset.mjs` to exercise them locally.'
    );
  }

  /**
   * DESCRIPTIONS — wrong-language text in a `descriptionByLocale` slot.
   *
   * Measured baseline 2026-08-10 on 26,051 non-flagged jobs / 104,139 eligible
   * description slots: 60 mismatches = 0.058%. The pre-existing absolute
   * threshold was `<= 10`, which the live dataset has exceeded since at least
   * 2026-05-19 — that is why the test was skipped rather than fixed. 0.15%
   * locks in the status quo with ~2.5x headroom for detector jitter and can
   * only be tightened from here.
   */
  it.skipIf(!hasDataset)(
    'localized descriptions are not stored under the wrong locale',
    { timeout: 180000 },
    () => {
      const MAX_RATE = 0.0015; // 0.15% — measured 0.058% on 2026-08-10
      const mismatches: string[] = [];
      let slots = 0;

      for (const job of jobs!) {
        // Jobs awaiting translation are expected to hold source-language
        // fallbacks until translate-pending processes them.
        if (job.needsRetranslation) continue;

        for (const locale of LOCALES) {
          const description = String(job.descriptionByLocale?.[locale] || '').trim();
          if (description.length < 120) continue;
          slots += 1;

          const detected = detectLanguageWithConfidence(description, locale);
          if (detected.confidence >= 0.65 && detected.lang !== locale) {
            mismatches.push(
              `${job.company || '?'}/${job.slug || '?'} [${locale}] => ${detected.lang} (${detected.confidence.toFixed(2)})`
            );
          }
        }
      }

      const rate = slots > 0 ? mismatches.length / slots : 0;
      expect(
        rate,
        `Descriptions stored under the wrong locale: ${mismatches.length}/${slots} = `
          + `${(rate * 100).toFixed(3)}% (max ${(MAX_RATE * 100).toFixed(3)}%)\n`
          + `${mismatches.slice(0, 20).join('\n')}`
      ).toBeLessThanOrEqual(MAX_RATE);
    }
  );

  /**
   * TITLES — a non-source `titleByLocale` slot that still reads as another
   * language once the employer/location names are stripped.
   *
   * MEASURED BASELINE 2026-08-10: 24,054 of 79,796 non-source title slots =
   * **30.14%** (26,605 jobs from `data/jobs/by-crawler/*.json`; per target
   * locale it 35.1%, en 32.4%, fr 26.8%, de 18.8%).
   *
   * MEASUREMENT CONTEXT — read before adjusting. The baseline was taken with
   * `titleLooksUntranslated()` as shipped by PR #5570, on a worktree branched
   * from it while it was still OPEN (not yet on main). So the number already
   * reflects the fixed detector, not the old one it replaces. #5570 also makes
   * `titleLooksUntranslatedFromSource` delegate to the same primitive, which
   * will raise the volume its 7 call sites in `dedicated-crawler-common.mjs`
   * flag — but that changes how many jobs carry `needsRetranslation`, and this
   * ratchet deliberately does NOT exclude flagged jobs from either side of the
   * ratio (the site serves them regardless), so that shift cannot move this
   * number on merge order alone.
   *
   * A "meaningful" threshold — anywhere near the ~3% one would want — would be
   * red on day one for a defect that predates this test by months, which is a
   * broken gate, not a gate. So this LOCKS IN THE STATUS QUO at 33.00% (+2.86pp
   * of headroom over the measurement, for crawl-mix drift and for the
   * assembled-vs-slices difference the baseline could not be taken across
   * locally) and can only ever be tightened.
   *
   * Tightening is tracked work, not a TODO to forget: the alert threshold in
   * `.github/workflows/job-title-locale-audit.yml` is 20%, and every weekly run
   * publishes the current rate into the tracking issue. Lower this constant as
   * the repair path (`scripts/mark-mistranslated-jobs.mjs` in
   * translate-pending.yml) drains the backlog.
   *
   * NOTE for whoever tightens it: part of the 30.14% is DETECTOR noise, not
   * broken pages — the audit's `topEvidence` table isolates it (e.g. the German
   * article `des` firing on correct French titles). Fix the lexicon in
   * `scripts/lib/job-locale-utils.mjs` first, re-measure, then lower this.
   */
  it.skipIf(!hasDataset)(
    'non-source job titles are not left in the source language',
    { timeout: 180000 },
    () => {
      const MAX_RATE = 0.33; // 33.00% — measured 30.14% on 2026-08-10
      const offenders: string[] = [];
      let slots = 0;
      let flagged = 0;

      for (const job of jobs!) {
        const sourceLang = String(job.sourceLang || 'it').toLowerCase();
        const titles = job.titleByLocale || {};
        const sourceTitle = String(titles[sourceLang] || job.title || '');

        for (const locale of LOCALES) {
          if (locale === sourceLang) continue;
          const title = String(titles[locale] || '').trim();
          if (!title) continue; // empty slot: a completeness defect, gated elsewhere
          slots += 1;

          const verdict = titleLooksUntranslated({
            title,
            sourceTitle,
            sourceLang,
            targetLocale: locale,
            company: job.company || '',
            location: job.location || '',
          });
          if (!verdict.untranslated) continue;
          flagged += 1;
          if (offenders.length < 20) {
            offenders.push(`${job.company || '?'}/${job.slug || '?'} [${locale}] ${verdict.reason} (${verdict.evidence}): ${title}`);
          }
        }
      }

      const rate = slots > 0 ? flagged / slots : 0;
      expect(
        rate,
        `Non-source titles still in a foreign language: ${flagged}/${slots} = `
          + `${(rate * 100).toFixed(2)}% (max ${(MAX_RATE * 100).toFixed(2)}%)\n`
          + 'Repair: node scripts/mark-mistranslated-jobs.mjs --dry-run\n'
          + 'Detail: npm run audit:job-title-locale\n'
          + `${offenders.join('\n')}`
      ).toBeLessThanOrEqual(MAX_RATE);
    }
  );
});
