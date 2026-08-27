/**
 * Per-item commit gate for NON-translation failures (#3789, follow-up of
 * #3788/#3783).
 *
 * `validateDedicatedLocaleCoverage` was still all-or-nothing for
 * non-translation blocking issues: one structurally invalid job (bad/missing
 * slug, untrusted domain) threw, the crawler exited non-zero, and the
 * generated crawler-group-*.yml commit gate (`if [ "$crawler_exit" -eq 0 ]`)
 * discarded the ENTIRE batch — valid jobs included.
 *
 * Fix under test: invalid jobs are QUARANTINED from the persisted dataset
 * (validation is NOT weakened — they stay excluded) while the valid jobs
 * survive and commit. Systemic failure (majority invalid = parser break) and
 * the every-job-invalid case still hard-fail loudly, keeping the previous
 * dataset intact.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateDedicatedLocaleCoverage } from '../scripts/lib/dedicated-crawler-common.mjs';

const STRICT_ENV = 'JOBS_PER_ITEM_GATE_TEST_STRICT';
const NO_BOILERPLATE_COMPANY = 'Zqx Ephemeral Source Sarl';
const BAD_HOST = 'https://evil-untrusted.example';

// Fake-but-present key: isAnyModelAvailable() only checks presence (no network
// call), keeping the infra-down defer branch of isTranslationInfraDown() out
// of the way so these tests isolate the per-item non-translation gate.
const PRIOR_GROQ_KEY = process.env.GROQ_API_KEY;
beforeEach(() => {
  process.env.GROQ_API_KEY = 'test-fake-key-not-a-real-secret';
});
afterEach(() => {
  if (PRIOR_GROQ_KEY === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = PRIOR_GROQ_KEY;
});

function richDescriptionIt(): string {
  return (
    'Cerchiamo una persona motivata per unirsi al nostro team in Ticino. ' +
    'Il ruolo prevede responsabilità operative quotidiane, collaborazione con i ' +
    'colleghi e contatto diretto con i clienti. Offriamo un ambiente di lavoro ' +
    'dinamico, formazione continua, condizioni di impiego competitive e reali ' +
    'opportunità di crescita professionale all\'interno di un\'azienda solida e ' +
    'radicata sul territorio cantonale.'
  );
}

function richDescriptionEn(): string {
  return (
    'We are looking for a motivated person to join our team in Ticino. ' +
    'The role involves daily operational responsibilities, collaboration with ' +
    'colleagues and direct contact with customers. We offer a dynamic work ' +
    'environment, continuous training, competitive employment conditions and ' +
    'genuine opportunities for professional growth within a solid company ' +
    'rooted in the canton.'
  );
}

function makeJob(
  slug: string,
  n: number,
  opts: { badDomain?: boolean; untranslated?: boolean; crawlerMissStreak?: number } = {},
) {
  const title = `Collaboratore Operativo ${n}`;
  const host = opts.badDomain ? BAD_HOST : 'https://trusted-source.test';
  return {
    slug,
    url: `${host}/jobs/${slug}/`,
    title,
    company: NO_BOILERPLATE_COMPANY,
    description: richDescriptionIt(),
    titleByLocale: { it: title, en: `Operations Associate ${n}` },
    descriptionByLocale: { it: richDescriptionIt(), en: opts.untranslated ? '' : richDescriptionEn() },
    slugByLocale: { it: slug, en: `${slug}-en` },
    ...(opts.crawlerMissStreak ? { crawlerMissStreak: opts.crawlerMissStreak } : {}),
  };
}

function writeJobs(jobs: unknown[]): { jobsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-per-item-gate-'));
  const jobsPath = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  return { jobsPath };
}

// NOTE: hardenJobLocaleFields (which runs inside the guard) canonicalizes
// slugs from title+company, so on-disk slugs differ from the seeded ones.
// URLs are stable across hardening — assert on those.
function readJobIds(jobsPath: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
  return parsed
    .map((j: { url: string }) => String(j.url).replace(/^https?:\/\/[^/]+\/jobs\//, '').replace(/\/$/, ''))
    .sort();
}

function runGuard(jobsPath: string, overrides: Record<string, unknown> = {}) {
  process.env[STRICT_ENV] = '1';
  return validateDedicatedLocaleCoverage({
    strictEnvVar: STRICT_ENV,
    label: 'PerItemGateTest',
    dataJobsPath: jobsPath,
    isTargetJob: () => true,
    locales: ['it', 'en'],
    minDescriptionChars: 120,
    minSourceDescriptionCharsForHardValidation: 120,
    checkSlug: false,
    untranslatedCheck: true,
    isTrustedDomain: (url: string) => !String(url).startsWith(BAD_HOST),
    getCascadeStatsFn: () => ({ calls: 0, successes: 0, byFieldType: {} }),
    ...overrides,
  } as Parameters<typeof validateDedicatedLocaleCoverage>[0]);
}

describe('validateDedicatedLocaleCoverage — per-item gate for non-translation failures (#3789)', () => {
  it('one invalid job among many valid ones no longer discards the batch: it is quarantined, valid jobs survive', () => {
    const { jobsPath } = writeJobs([
      makeJob('valid-job-1', 1),
      makeJob('valid-job-2', 2),
      makeJob('valid-job-3', 3),
      makeJob('bad-domain-job', 4, { badDomain: true }),
    ]);

    expect(() => runGuard(jobsPath)).not.toThrow();
    expect(readJobIds(jobsPath)).toEqual(['valid-job-1', 'valid-job-2', 'valid-job-3']);
  });

  it('does NOT weaken validation: the invalid job is removed from the persisted dataset, not tolerated in place', () => {
    const { jobsPath } = writeJobs([
      makeJob('valid-job-1', 1),
      makeJob('valid-job-2', 2),
      makeJob('bad-domain-job', 3, { badDomain: true }),
    ]);

    runGuard(jobsPath);
    const parsed = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    expect(parsed.some((j: { url: string }) => j.url.includes('bad-domain-job'))).toBe(false);
    expect(parsed).toHaveLength(2);
  });

  it('systemic invalidity (majority of the batch) still hard-fails and leaves the dataset untouched', () => {
    const jobs = [
      makeJob('valid-job-1', 1),
      makeJob('bad-domain-job-1', 2, { badDomain: true }),
      makeJob('bad-domain-job-2', 3, { badDomain: true }),
    ];
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath)).toThrow(/localization validation failed/);
    // All 3 jobs still on disk: the previous data is preserved for the
    // workflow's non-zero-exit issue path, nothing is silently wiped.
    expect(readJobIds(jobsPath)).toEqual(['bad-domain-job-1', 'bad-domain-job-2', 'valid-job-1']);
  });

  it('a single-job source whose only job is invalid still hard-fails (quarantine would silently wipe the dataset)', () => {
    const { jobsPath } = writeJobs([makeJob('only-job-bad', 1, { badDomain: true })]);

    expect(() => runGuard(jobsPath)).toThrow(/localization validation failed/);
    expect(readJobIds(jobsPath)).toEqual(['only-job-bad']);
  });

  it('quarantine composes with the translation tolerance: 1 invalid + 1 untranslated among 5 → both survive-paths work', () => {
    const { jobsPath } = writeJobs([
      makeJob('valid-job-1', 1),
      makeJob('valid-job-2', 2),
      makeJob('valid-job-3', 3),
      makeJob('untranslated-job', 4, { untranslated: true }),
      makeJob('bad-domain-job', 5, { badDomain: true }),
    ]);

    // Unset tolerance → FRO-628 ratio floor tolerates the 1 untranslated job;
    // the invalid one is quarantined per-item. No throw, 4 jobs persist
    // (untranslated stays: it is recovered by translate-pending, not dropped).
    expect(() => runGuard(jobsPath)).not.toThrow();
    expect(readJobIds(jobsPath)).toEqual([
      'untranslated-job', 'valid-job-1', 'valid-job-2', 'valid-job-3',
    ]);
  });

  it('translation failures beyond an explicit zero tolerance still hard-fail even after an invalid job is quarantined', () => {
    const { jobsPath } = writeJobs([
      makeJob('valid-job-1', 1),
      makeJob('valid-job-2', 2),
      makeJob('untranslated-job', 3, { untranslated: true }),
      makeJob('bad-domain-job', 4, { badDomain: true }),
    ]);

    expect(() => runGuard(jobsPath, { maxToleratedMissingDescriptions: 0 }))
      .toThrow(/localization validation failed/);
  });

  it('a grace-period-retained job (crawlerMissStreak > 0) with an untrusted domain is NOT quarantined: it was carried over, not freshly fetched, and is already scheduled to age out on its own (#6598)', () => {
    const { jobsPath } = writeJobs([
      makeJob('valid-job-1', 1),
      makeJob('valid-job-2', 2),
      makeJob('retained-bad-domain-job', 3, { badDomain: true, crawlerMissStreak: 1 }),
    ]);

    expect(() => runGuard(jobsPath)).not.toThrow();
    expect(readJobIds(jobsPath)).toEqual([
      'retained-bad-domain-job', 'valid-job-1', 'valid-job-2',
    ]);
  });

  it('a fully valid batch still passes untouched', () => {
    const { jobsPath } = writeJobs([
      makeJob('valid-job-1', 1),
      makeJob('valid-job-2', 2),
    ]);

    expect(() => runGuard(jobsPath)).not.toThrow();
    expect(readJobIds(jobsPath)).toEqual(['valid-job-1', 'valid-job-2']);
  });
});
