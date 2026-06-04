/**
 * Thin-source guard — ratio-gated abort (issues #1310/#1309/#1308/#1307/#1306/
 * #1305/#1304/#1287/#1286/#1282/#1280/#1209).
 *
 * The shared dedicated-crawler guard `validateDedicatedLocaleCoverage` used to
 * throw (abort the whole crawl + file a failure issue) the moment ANY single
 * job had a suspiciously-thin source description. Many legitimate sources
 * (listing-only ATS at hospitals/hotels/Nestlé) naturally have a couple of
 * ultra-short postings — those should NOT brick the run and discard every good
 * job. The build owns the thin-content INDEX gate (noindex + sitemap-exclude
 * <50-word pages); the crawler guard should only catch systemic PARSER BREAKS.
 *
 * After the fix the abort is ratio-gated:
 *   - few-thin-among-many (ratio < 0.5)  → no throw; thin jobs quarantined from
 *     the persisted dataset; good jobs commit.
 *   - majority/all thin (ratio >= 0.5)   → still throws (parser-break detection
 *     preserved).
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateDedicatedLocaleCoverage } from '../scripts/lib/dedicated-crawler-common.mjs';

const STRICT_ENV = 'JOBS_THIN_RATIO_TEST_STRICT';

/** A "good" job: rich IT base description well above the hard-validation floor. */
function richDescription(): string {
  return (
    'Cerchiamo una persona motivata per unirsi al nostro team in Ticino. ' +
    'Il ruolo prevede responsabilità operative quotidiane, collaborazione con i ' +
    'colleghi e contatto diretto con i clienti. Offriamo un ambiente di lavoro ' +
    'dinamico, formazione continua, condizioni di impiego competitive e reali ' +
    'opportunità di crescita professionale all\'interno di un\'azienda solida e ' +
    'radicata sul territorio cantonale.'
  );
}

// Distinct titles are required so hardening derives distinct slugs — identical
// titles collapse to one slug and the per-slug thin map dedups, hiding the ratio.
// `company` is intentionally one that matches NO boilerplate key so the thin
// descriptions are not auto-enriched before the guard runs.
const NO_BOILERPLATE_COMPANY = 'Qzx Volatile Source Gmbh';

function makeGoodJob(slug: string, n: number) {
  const desc = richDescription();
  const title = `Collaboratore Operativo ${n}`;
  return {
    slug,
    url: `https://example-source.test/jobs/${slug}/`,
    title,
    company: NO_BOILERPLATE_COMPANY,
    description: desc,
    titleByLocale: { it: title },
    descriptionByLocale: { it: desc },
    slugByLocale: { it: slug },
  };
}

/** A thin job: ultra-short UI-noise base description (classifyThinSource → suspicious). */
function makeThinJob(slug: string, n: number) {
  const title = `Posizione Sottile ${n}`;
  return {
    slug,
    url: `https://example-source.test/jobs/${slug}/`,
    title,
    company: NO_BOILERPLATE_COMPANY,
    description: 'Stampa', // ultra-short + UI-noise → suspicious thin source
    titleByLocale: { it: title },
    descriptionByLocale: { it: 'Stampa' },
    slugByLocale: { it: slug },
  };
}

function writeJobs(jobs: unknown[]): { dir: string; jobsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-thin-ratio-'));
  const jobsPath = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  return { dir, jobsPath };
}

function runGuard(jobsPath: string) {
  process.env[STRICT_ENV] = '1';
  return validateDedicatedLocaleCoverage({
    strictEnvVar: STRICT_ENV,
    label: 'ThinRatioTest',
    dataJobsPath: jobsPath,
    isTargetJob: () => true,
    locales: ['it'],
    minDescriptionChars: 120,
    minSourceDescriptionCharsForHardValidation: 120,
    checkSlug: false,
    untranslatedCheck: false,
    isTrustedDomain: () => true,
  });
}

describe('validateDedicatedLocaleCoverage — ratio-gated thin-source abort', () => {
  it('(a) few thin among many → does NOT throw and quarantines the thin jobs', () => {
    // 8 good + 2 thin = 20% thin, below the 0.5 systemic threshold.
    const jobs = [
      ...Array.from({ length: 8 }, (_, i) => makeGoodJob(`good-${i}`, i)),
      makeThinJob('thin-a', 0),
      makeThinJob('thin-b', 1),
    ];
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath)).not.toThrow();

    // The 2 thin jobs are quarantined from the persisted dataset; the 8 good
    // jobs survive. (Hardening rewrites slugs, so assert by count + surviving
    // descriptions rather than the original thin slugs.)
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as Array<{ description: string }>;
    expect(after).toHaveLength(8);
    expect(after.every((j) => j.description !== 'Stampa')).toBe(true);
  });

  it('(b) majority thin → still throws (parser-break detection preserved)', () => {
    // 2 good + 8 thin = 80% thin, at/above the systemic threshold.
    const jobs = [
      ...Array.from({ length: 2 }, (_, i) => makeGoodJob(`good-${i}`, i)),
      ...Array.from({ length: 8 }, (_, i) => makeThinJob(`thin-${i}`, i)),
    ];
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath)).toThrow(/thin-source investigation failed/i);
  });

  it('(b2) all thin → still throws (clear total extraction break)', () => {
    const jobs = Array.from({ length: 5 }, (_, i) => makeThinJob(`thin-${i}`, i));
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath)).toThrow(/thin-source investigation failed/i);
  });

  it('(c) tiny source, single thin at 50% → does NOT throw (>=2 absolute floor)', () => {
    // 1 good + 1 thin = 50% ratio, but only ONE thin job. A parser break
    // manifests as MANY thin jobs, so a lone naturally-short posting on a tiny
    // listing source must never brick the run despite hitting the ratio.
    const jobs = [makeGoodJob('good-0', 0), makeThinJob('thin-0', 0)];
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath)).not.toThrow();
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as Array<{ description: string }>;
    expect(after).toHaveLength(1);
    expect(after[0].description).not.toBe('Stampa');
  });

  it('all good → passes cleanly with no quarantine', () => {
    const jobs = Array.from({ length: 5 }, (_, i) => makeGoodJob(`good-${i}`, i));
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath)).not.toThrow();
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as unknown[];
    expect(after).toHaveLength(5);
  });
});
