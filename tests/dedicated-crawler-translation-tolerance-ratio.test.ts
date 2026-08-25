/**
 * Translation-tolerance ratio floor (FRO-628, issue #3783 — ALTEN).
 *
 * `validateDedicatedLocaleCoverage`'s base translation tolerance (FRO-317,
 * `maxToleratedMissingDescriptions`) defaulted to 0 for any crawler that
 * didn't explicitly override it. A SINGLE untranslated locale on a SINGLE
 * job (one transient 429 mid-run) then hard-failed the whole run and
 * discarded every other successfully-crawled+translated job — not just the
 * affected one. ALTEN lost 3/3 jobs this way over 1 bad locale (#3783); the
 * same implicit-0 gap applies to every dedicated crawler that never set
 * `maxToleratedMissingDescriptions` (~105 of them).
 *
 * Fix: when the caller leaves the tolerance UNSET (not explicit 0), the gate
 * now floors it to a small size-proportional ratio instead. Callers that DO
 * set an explicit value — including 0, for sources whose content-quality
 * bar demands zero tolerance — keep it verbatim; the floor never overrides
 * an explicit choice.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateDedicatedLocaleCoverage } from '../scripts/lib/dedicated-crawler-common.mjs';

const STRICT_ENV = 'JOBS_TRANSLATION_RATIO_TEST_STRICT';
const NO_BOILERPLATE_COMPANY = 'Zqx Ephemeral Source Sarl';

// A fake-but-structurally-valid key: isAnyModelAvailable() only checks
// presence, never makes a network call, so this keeps the LLM-pool branch
// of isTranslationInfraDown() out of the way without hitting any real
// provider — letting these tests isolate the ratio-tolerance branch instead
// of always taking the (also-legitimate, separately tested in
// dedicated-crawler-translation-infra-gate.test.ts) infra-down defer path.
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

function makeTranslatedJob(slug: string, n: number) {
  const title = `Collaboratore Operativo ${n}`;
  return {
    slug,
    url: `https://example-source.test/jobs/${slug}/`,
    title,
    company: NO_BOILERPLATE_COMPANY,
    description: richDescriptionIt(),
    titleByLocale: { it: title, en: `Operations Associate ${n}` },
    descriptionByLocale: { it: richDescriptionIt(), en: richDescriptionEn() },
    slugByLocale: { it: slug, en: `${slug}-en` },
  };
}

/** IT description is rich (not thin) but the EN translation never landed. */
function makeUntranslatedJob(slug: string, n: number) {
  const title = `Collaboratore Operativo ${n}`;
  return {
    slug,
    url: `https://example-source.test/jobs/${slug}/`,
    title,
    company: NO_BOILERPLATE_COMPANY,
    description: richDescriptionIt(),
    titleByLocale: { it: title, en: `Operations Associate ${n}` },
    descriptionByLocale: { it: richDescriptionIt(), en: '' },
    slugByLocale: { it: slug, en: `${slug}-en` },
  };
}

function writeJobs(jobs: unknown[]): { dir: string; jobsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-translation-ratio-'));
  const jobsPath = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  return { dir, jobsPath };
}

function runGuard(jobsPath: string, overrides: Record<string, unknown> = {}) {
  process.env[STRICT_ENV] = '1';
  return validateDedicatedLocaleCoverage({
    strictEnvVar: STRICT_ENV,
    label: 'TranslationRatioTest',
    dataJobsPath: jobsPath,
    isTargetJob: () => true,
    locales: ['it', 'en'],
    minDescriptionChars: 120,
    minSourceDescriptionCharsForHardValidation: 120,
    checkSlug: false,
    untranslatedCheck: true,
    isTrustedDomain: () => true,
    getCascadeStatsFn: () => ({ calls: 0, successes: 0, byFieldType: {} }),
    ...overrides,
  } as Parameters<typeof validateDedicatedLocaleCoverage>[0]);
}

describe('validateDedicatedLocaleCoverage — translation tolerance ratio floor', () => {
  it('(#3783 repro) 1 untranslated among 3, tolerance unset → does NOT throw, no data lost', () => {
    const jobs = [
      makeTranslatedJob('good-0', 0),
      makeTranslatedJob('good-1', 1),
      makeUntranslatedJob('bad-0', 2),
    ];
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath)).not.toThrow();

    // Unlike the thin-source quarantine path, the tolerance path never
    // rewrites the dataset — all 3 jobs (including the flagged one) stay,
    // ready for translate-pending.yml to fill the gap.
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as unknown[];
    expect(after).toHaveLength(3);
  });

  it('explicit tolerance=0 is respected verbatim → same 1-among-3 gap still throws', () => {
    const jobs = [
      makeTranslatedJob('good-0', 0),
      makeTranslatedJob('good-1', 1),
      makeUntranslatedJob('bad-0', 2),
    ];
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath, { maxToleratedMissingDescriptions: 0 }))
      .toThrow(/localization validation failed/i);
  });

  it('systemic translation break (4/5 untranslated), tolerance unset → still throws', () => {
    const jobs = [
      makeTranslatedJob('good-0', 0),
      makeUntranslatedJob('bad-0', 1),
      makeUntranslatedJob('bad-1', 2),
      makeUntranslatedJob('bad-2', 3),
      makeUntranslatedJob('bad-3', 4),
    ];
    const { jobsPath } = writeJobs(jobs);

    // ratio floor = max(1, ceil(5 * 0.2)) = 1, well below the 4 actual gaps.
    expect(() => runGuard(jobsPath)).toThrow(/localization validation failed/i);
  });

  it('pre-existing explicit tolerance (e.g. 2) still tolerates exactly up to its own value', () => {
    const jobs = [
      makeTranslatedJob('good-0', 0),
      makeTranslatedJob('good-1', 1),
      makeTranslatedJob('good-2', 2),
      makeUntranslatedJob('bad-0', 3),
      makeUntranslatedJob('bad-1', 4),
    ];
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath, { maxToleratedMissingDescriptions: 2 })).not.toThrow();
  });

  it('pre-existing explicit tolerance (2) is not silently widened by the ratio floor', () => {
    const jobs = [
      makeTranslatedJob('good-0', 0),
      makeUntranslatedJob('bad-0', 1),
      makeUntranslatedJob('bad-1', 2),
      makeUntranslatedJob('bad-2', 3),
    ];
    const { jobsPath } = writeJobs(jobs);

    // 3 gaps > explicit tolerance of 2 — even though ratio floor for 4 jobs
    // (max(1, ceil(4*0.2))=1) is smaller still, the explicit value must win
    // in BOTH directions (never widened, never narrowed by the floor).
    expect(() => runGuard(jobsPath, { maxToleratedMissingDescriptions: 2 })).toThrow(/localization validation failed/i);
  });

  it('all translated → passes cleanly regardless of tolerance setting', () => {
    const jobs = [makeTranslatedJob('good-0', 0), makeTranslatedJob('good-1', 1)];
    const { jobsPath } = writeJobs(jobs);

    expect(() => runGuard(jobsPath)).not.toThrow();
  });

  it('(#6270 repro) 1 untranslated job across 3 non-source locales counts as 1 job, not 3 issues', () => {
    // grace-la-margna's exact shape: 4 locales (it/en/de/fr), source=en, 6
    // jobs, 1 job whose description never translated into it/de/fr — 3
    // TRANSLATION_ISSUES entries for a single job. Before the fix this was
    // compared as translationIssues.length (3) against the per-job ratio
    // floor (max(1, ceil(6*0.2))=2) and hard-failed the whole batch daily.
    const richEn =
      'We are looking for a motivated person to join our team in Ticino. ' +
      'The role involves daily operational responsibilities, collaboration ' +
      'with colleagues and direct contact with guests. We offer a dynamic ' +
      'work environment, continuous training, competitive employment ' +
      'conditions and genuine opportunities for professional growth.';

    function makeFullyTranslatedJob(slug: string, n: number) {
      const title = `Collaboratore Operativo ${n}`;
      const descFor = (localeTag: string) => `[${localeTag}] ${richEn} (variant ${n})`;
      return {
        slug,
        url: `https://example-source.test/jobs/${slug}/`,
        title,
        company: NO_BOILERPLATE_COMPANY,
        description: descFor('en'),
        titleByLocale: {
          it: `${title} IT`, en: title, de: `${title} DE`, fr: `${title} FR`,
        },
        descriptionByLocale: {
          it: descFor('it'), en: descFor('en'), de: descFor('de'), fr: descFor('fr'),
        },
        slugByLocale: {
          it: `${slug}-it`, en: slug, de: `${slug}-de`, fr: `${slug}-fr`,
        },
      };
    }

    const untranslatedJob = {
      slug: 'bad-multilocale-0',
      url: 'https://example-source.test/jobs/bad-multilocale-0/',
      title: 'Collaboratore Operativo X',
      company: NO_BOILERPLATE_COMPANY,
      description: richEn,
      titleByLocale: { en: 'Collaboratore Operativo X' },
      descriptionByLocale: { en: richEn, it: '', de: '', fr: '' },
      slugByLocale: { en: 'bad-multilocale-0' },
    };
    const jobs = [
      makeFullyTranslatedJob('good-0', 0),
      makeFullyTranslatedJob('good-1', 1),
      makeFullyTranslatedJob('good-2', 2),
      makeFullyTranslatedJob('good-3', 3),
      makeFullyTranslatedJob('good-4', 4),
      untranslatedJob,
    ];
    const { jobsPath } = writeJobs(jobs);

    expect(() =>
      runGuard(jobsPath, { locales: ['it', 'en', 'de', 'fr'] })
    ).not.toThrow();

    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as unknown[];
    expect(after).toHaveLength(6);
  });

  it('$GITHUB_STEP_SUMMARY gets a breadcrumb only for the NEW ratio-floor path, not for explicit tolerances', () => {
    const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-step-summary-'));

    // (a) unset tolerance, ratio floor absorbs the gap → summary written.
    const ratioSummaryPath = path.join(summaryDir, 'ratio-summary.md');
    fs.writeFileSync(ratioSummaryPath, '');
    const jobsA = [
      makeTranslatedJob('good-0', 0),
      makeTranslatedJob('good-1', 1),
      makeUntranslatedJob('bad-0', 2),
    ];
    const { jobsPath: jobsPathA } = writeJobs(jobsA);
    const priorSummary = process.env.GITHUB_STEP_SUMMARY;
    try {
      process.env.GITHUB_STEP_SUMMARY = ratioSummaryPath;
      runGuard(jobsPathA);
      const summaryA = fs.readFileSync(ratioSummaryPath, 'utf-8');
      expect(summaryA).toMatch(/tolerated 1 translation issue/i);

      // (b) explicit tolerance covers the same shape of gap → no new write.
      const explicitSummaryPath = path.join(summaryDir, 'explicit-summary.md');
      fs.writeFileSync(explicitSummaryPath, '');
      const jobsB = [
        makeTranslatedJob('good-0', 0),
        makeTranslatedJob('good-1', 1),
        makeUntranslatedJob('bad-0', 2),
      ];
      const { jobsPath: jobsPathB } = writeJobs(jobsB);
      process.env.GITHUB_STEP_SUMMARY = explicitSummaryPath;
      runGuard(jobsPathB, { maxToleratedMissingDescriptions: 1 });
      const summaryB = fs.readFileSync(explicitSummaryPath, 'utf-8');
      expect(summaryB).toBe('');
    } finally {
      if (priorSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = priorSummary;
    }
  });
});
