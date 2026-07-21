/**
 * Unit tests for the per-job FAQ builder at
 * `build-plugins/shared/jobPostingFaq.ts`.
 *
 * Verifies the builder is deterministic, produces exactly 4 non-empty Q&A
 * pairs (required by the FAQPage validity gate — see
 * scripts/audit-faqpage-validity.mjs), and that answers are genuinely
 * job-specific (varies with salary/company/canton) rather than a static
 * template repeated verbatim across jobs — the whole point of not using
 * AI-per-job generation for this high-volume page type.
 */
import { describe, it, expect } from 'vitest';
import { buildJobPostingFaqPairs, type BuildJobPostingFaqOptions } from '../../build-plugins/shared/jobPostingFaq';
import { buildJobPostingSchema, type JobInput } from '../../build-plugins/shared/jobPostingSchema';

const BASE_OPTS = { locale: 'it', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/dettaglio-offerta/test-slug/' };

const TICINO_JOB: JobInput = {
  id: 'job-1',
  title: 'Contabile',
  company: 'Acme SA',
  addressLocality: 'Lugano',
  canton: 'TI',
  contract: 'full-time',
  salaryMin: 70000,
  salaryMax: 90000,
  salaryCurrency: 'CHF',
  url: 'https://acme.example.com/jobs/contabile',
};

const GENEVA_JOB: JobInput = {
  ...TICINO_JOB,
  id: 'job-2',
  company: 'Beta SA',
  addressLocality: 'Ginevra',
  canton: 'GE',
};

function faqOptsFor(job: JobInput, isTicino: boolean, cantonDisplay: string): BuildJobPostingFaqOptions {
  return {
    locale: 'it',
    jobUrl: job.url as string,
    cantonDisplay,
    isTicino,
  };
}

describe('buildJobPostingFaqPairs', () => {
  it('returns exactly 4 non-empty Q&A pairs', () => {
    const schema = buildJobPostingSchema(TICINO_JOB, BASE_OPTS);
    const pairs = buildJobPostingFaqPairs(schema, faqOptsFor(TICINO_JOB, true, 'Ticino'));
    expect(pairs).toHaveLength(4);
    for (const pair of pairs) {
      expect(pair.q.trim().length).toBeGreaterThan(0);
      expect(pair.a.trim().length).toBeGreaterThan(0);
    }
  });

  it('is a pure function — same input always returns the same output', () => {
    const schema = buildJobPostingSchema(TICINO_JOB, BASE_OPTS);
    const opts = faqOptsFor(TICINO_JOB, true, 'Ticino');
    const first = buildJobPostingFaqPairs(schema, opts);
    const second = buildJobPostingFaqPairs(schema, opts);
    expect(second).toEqual(first);
  });

  it('embeds the real company name and salary figures, not a generic placeholder', () => {
    const schema = buildJobPostingSchema(TICINO_JOB, BASE_OPTS);
    const pairs = buildJobPostingFaqPairs(schema, faqOptsFor(TICINO_JOB, true, 'Ticino'));
    const joined = pairs.map((p) => `${p.q} ${p.a}`).join(' ');
    expect(joined).toContain('Acme SA');
    expect(joined).toMatch(/70['’ ]?000/);
  });

  it('produces different answers for two different jobs (no cross-job duplication)', () => {
    const schemaA = buildJobPostingSchema(TICINO_JOB, BASE_OPTS);
    const schemaB = buildJobPostingSchema(GENEVA_JOB, BASE_OPTS);
    const pairsA = buildJobPostingFaqPairs(schemaA, faqOptsFor(TICINO_JOB, true, 'Ticino'));
    const pairsB = buildJobPostingFaqPairs(schemaB, faqOptsFor(GENEVA_JOB, false, 'Ginevra'));
    expect(pairsA).not.toEqual(pairsB);
    // Salary/contract/apply questions carry the company name — must differ.
    expect(pairsA[0].a).not.toBe(pairsB[0].a);
    expect(pairsA[3].a).not.toBe(pairsB[3].a);
  });

  it('gives Ticino jobs the detailed G-permit answer, not the generic canton answer', () => {
    const schema = buildJobPostingSchema(TICINO_JOB, BASE_OPTS);
    const pairs = buildJobPostingFaqPairs(schema, faqOptsFor(TICINO_JOB, true, 'Ticino'));
    const permitPair = pairs[2];
    expect(permitPair.a).toContain('20 km');
    expect(permitPair.a.toLowerCase()).toContain('ticino');
  });

  it('gives non-Ticino jobs the general cross-border answer referencing the correct canton', () => {
    const schema = buildJobPostingSchema(GENEVA_JOB, BASE_OPTS);
    const pairs = buildJobPostingFaqPairs(schema, faqOptsFor(GENEVA_JOB, false, 'Ginevra'));
    const permitPair = pairs[2];
    expect(permitPair.a).toContain('Ginevra');
  });

  it('supports all 4 locales without throwing and with locale-appropriate text', () => {
    const schema = buildJobPostingSchema(TICINO_JOB, BASE_OPTS);
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const pairs = buildJobPostingFaqPairs(schema, { ...faqOptsFor(TICINO_JOB, true, 'Ticino'), locale });
      expect(pairs).toHaveLength(4);
      for (const pair of pairs) {
        expect(pair.q.length).toBeGreaterThan(0);
        expect(pair.a.length).toBeGreaterThan(0);
      }
    }
  });

  it('mentions the apply URL hostname in the how-to-apply answer', () => {
    const schema = buildJobPostingSchema(TICINO_JOB, BASE_OPTS);
    const pairs = buildJobPostingFaqPairs(schema, faqOptsFor(TICINO_JOB, true, 'Ticino'));
    expect(pairs[3].a).toContain('acme.example.com');
  });

  // Regression guard: validate-dist run 29794187475 found 119 job pages
  // where a third-party ATS URL (Rheinmetall) encoded spaces/parens as
  // literal "_", producing a 3+-underscore run once interpolated verbatim
  // into this FAQ answer's prose — tripping audit:no-literal-markdown's
  // 0-tolerance separator-run gate even though the source isn't AI-translated
  // markdown. The answer must cite only the hostname, never the raw path.
  it('never leaks a 3+-underscore (or "=", "~") run from the raw ATS URL path', () => {
    const job: JobInput = {
      ...TICINO_JOB,
      url: 'https://www.rheinmetall.com/en/job/ux_ui___xr_designer__m_w_d_/1081238',
    };
    const schema = buildJobPostingSchema(job, BASE_OPTS);
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const pairs = buildJobPostingFaqPairs(schema, { ...faqOptsFor(job, true, 'Ticino'), locale });
      expect(pairs[3].a).not.toMatch(/[_=~]{3,}/);
      expect(pairs[3].a).toContain('rheinmetall.com');
    }
  });
});

describe('resolveJobCanton (shared resolver consumed by all 3 FAQ call sites)', () => {
  // Regression guard for PR #4595's review finding: services/seoService.ts
  // and build-plugins/jobsSeoPagesPlugin.ts each computed the FAQ's isTicino
  // flag with their OWN ad-hoc canton fallback (defaulting straight to 'TI'
  // whenever `canton`/`addressRegion` were unset, never checking `location`),
  // while components/community/JobBoard.tsx already used this resolver
  // correctly — for jobs with only a `location` naming a real non-Ticino
  // city (e.g. Valais hospital listings), that meant the FAQ's structured
  // data and visible accordion could disagree on the canton and serve the
  // wrong border-permit legal guidance. All 3 call sites were fixed to use
  // this same resolver; this test locks down its behavior for the exact
  // case the review flagged.
  it('resolves a Valais city via location, not a bare canton-missing TI default', async () => {
    const { resolveJobCanton } = await import('../../build-plugins/shared/cantonSection');
    expect(resolveJobCanton({ location: 'Sion' })).toBe('VS');
    expect(resolveJobCanton({ location: 'Sion' })).not.toBe('TI');
  });

  it('still defaults to TI only when canton is truly unresolvable (no canton, no known location)', async () => {
    const { resolveJobCanton } = await import('../../build-plugins/shared/cantonSection');
    expect(resolveJobCanton({})).toBe('TI');
  });
});
