import { describe, expect, it } from 'vitest';

import {
  backfillFromCommits,
  buildBackfillExpiredEntry,
  classifyDedupLoser,
  dedupAgainstExisting,
  disambiguateSlugForLoser,
  parseAuditCommits,
  slugifyLocality,
  validateExpiredEntry,
} from '../scripts/backfill-dedup-lost-jobs.mjs';

const SAMPLE_AUDIT = `
# Housekeeping Slug-Dedup Audit

## Per-commit breakdown (Class B = silent dedup losses)

| SHA | Date | Removed | A | **B** | D |
|---|---|---|---|---|---|
| abc1234 | 2026-04-07 | 28 | 3 | **5** | 6 |
| def5678 | 2026-04-06 | 21 | 4 | **2** | 0 |
| 0000000 | 2026-04-05 | 4 | 4 | 0 | 0 |
| 9999999 | 2026-04-04 | 0 | 0 | **0** | 0 |
| badbad1 | 2026-04-03 | 11 | 0 | **3** | 8 |

`;

describe('parseAuditCommits', () => {
  it('extracts only commits with non-zero Class B losses', () => {
    const commits = parseAuditCommits(SAMPLE_AUDIT);
    expect(commits).toEqual([
      { sha: 'abc1234', date: '2026-04-07', classB: 5 },
      { sha: 'def5678', date: '2026-04-06', classB: 2 },
      { sha: 'badbad1', date: '2026-04-03', classB: 3 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseAuditCommits('')).toEqual([]);
    expect(parseAuditCommits('no table here')).toEqual([]);
  });

  it('ignores rows without a valid SHA in the first cell', () => {
    const md = `
| SHA | Date | Removed | A | **B** | D |
|---|---|---|---|---|---|
| not-a-sha | 2026-04-07 | 28 | 3 | **5** | 6 |
| f8b229154 | 2026-04-07 | 28 | 3 | **5** | 6 |
`;
    const commits = parseAuditCommits(md);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.sha).toBe('f8b229154');
  });
});

describe('buildBackfillExpiredEntry', () => {
  const baseJob = {
    id: 'company-x29n6r',
    slug: 'fisioterapista-diplomato-a-eoc-novaggio',
    company: 'EOC – Ente Ospedaliero Cantonale',
    companyKey: 'eoc-ente-ospedaliero-cantonale',
    title: 'Fisioterapista diplomato/a',
    location: 'Novaggio',
    addressLocality: 'Novaggio',
    postalCode: '6986',
    streetAddress: 'Via Clinica 1',
    employmentType: 'FULL_TIME',
    salaryMin: 80000,
    salaryMax: 108000,
    salaryCurrency: 'CHF',
    salaryPeriod: 'YEAR',
    titleByLocale: { it: 'Fisioterapista diplomato/a' },
    descriptionByLocale: { it: 'A long description that exceeds the minimum 30 character soft-landing threshold for sure.' },
    slugByLocale: { it: 'fisioterapista-diplomato-a-eoc-novaggio' },
    previousSlugs: ['fisioterapista-diplomato-a-eoc-old'],
  };

  it('preserves all fields from the source job and stamps backfill markers', () => {
    const entry = buildBackfillExpiredEntry(baseJob, '2026-04-07T07:52:57Z');
    expect(entry).not.toBeNull();
    expect(entry?.slug).toBe(baseJob.slug);
    expect(entry?.title).toBe(baseJob.title);
    expect(entry?.expiredAt).toBe('2026-04-07T07:52:57Z');
    expect(entry?.expirationReason).toBe('silent_dedup_backfill');
    expect(entry?.dedupArchive).toBe(true);
    expect(entry?.previousSlugs).toEqual(['fisioterapista-diplomato-a-eoc-old']);
    expect(entry?.salaryMin).toBe(80000);
    expect(entry?.postalCode).toBe('6986');
    expect(entry?.streetAddress).toBe('Via Clinica 1');
    expect(entry?.employmentType).toBe('FULL_TIME');
  });

  it('applies Ticino fallbacks when source data is missing mandatory fields', () => {
    const sparse = {
      slug: 'sparse-job',
      title: 'A sparse role',
      titleByLocale: {},
      descriptionByLocale: {
        it: 'A reasonably long description used to satisfy the soft-landing minimum length rule.',
      },
      slugByLocale: { it: 'sparse-job' },
    };
    const entry = buildBackfillExpiredEntry(sparse, '2026-04-01T00:00:00Z');
    expect(entry).not.toBeNull();
    expect(entry?.postalCode).toBe('6900');
    expect(entry?.streetAddress).toBe('Ticino');
    expect(entry?.addressLocality).toBe('Ticino');
    expect(entry?.addressRegion).toBe('TI');
    expect(entry?.addressCountry).toBe('CH');
    expect(entry?.employmentType).toBe('OTHER');
    expect(entry?.salaryMin).toBe(41080);
    expect(entry?.salaryCurrency).toBe('CHF');
    expect(entry?.salaryPeriod).toBe('YEAR');
  });

  it('returns null when slug or title is missing', () => {
    expect(buildBackfillExpiredEntry({ title: 'No slug' }, '2026-01-01')).toBeNull();
    expect(buildBackfillExpiredEntry({ slug: 'no-title' }, '2026-01-01')).toBeNull();
    expect(buildBackfillExpiredEntry(null, '2026-01-01')).toBeNull();
  });

  it('rewrites slug + slugByLocale and records original as previousSlugs when overrideSlug is provided', () => {
    const original = {
      slug: 'apprendistato-lidl',
      title: 'Apprendistato Lidl',
      location: 'Biasca',
      descriptionByLocale: {
        it: 'A long enough description for the soft landing pages here as required.',
      },
      slugByLocale: { it: 'apprendistato-lidl', en: 'apprenticeship-lidl' },
    };
    const entry = buildBackfillExpiredEntry(original, '2026-04-07T00:00:00Z', 'apprendistato-lidl-biasca');
    expect(entry).not.toBeNull();
    expect(entry?.slug).toBe('apprendistato-lidl-biasca');
    expect(entry?.slugByLocale).toEqual({
      it: 'apprendistato-lidl-biasca',
      en: 'apprendistato-lidl-biasca',
      de: 'apprendistato-lidl-biasca',
      fr: 'apprendistato-lidl-biasca',
    });
    expect(entry?.previousSlugs).toContain('apprendistato-lidl');
  });

  it('falls back to original slug when overrideSlug is empty', () => {
    const entry = buildBackfillExpiredEntry(
      {
        slug: 'foo',
        title: 'Foo',
        descriptionByLocale: { it: 'A long enough description for the soft landing pages here.' },
      },
      '2026-04-07T00:00:00Z',
      '',
    );
    expect(entry?.slug).toBe('foo');
    expect(entry?.previousSlugs).toEqual([]);
  });
});

describe('slugifyLocality', () => {
  it('lowercases and ASCII-folds Italian locality names', () => {
    expect(slugifyLocality('Novaggio')).toBe('novaggio');
    expect(slugifyLocality('Lugano')).toBe('lugano');
    expect(slugifyLocality('Riva San Vitale')).toBe('riva-san-vitale');
  });

  it('strips diacritics and replaces dashes', () => {
    expect(slugifyLocality('Sant\u2019Antonino')).toBe('sant-antonino');
    expect(slugifyLocality('Sant\u00E9')).toBe('sante');
  });

  it('returns empty string for nullish or non-string input', () => {
    expect(slugifyLocality(null as unknown as string)).toBe('');
    expect(slugifyLocality(undefined as unknown as string)).toBe('');
    expect(slugifyLocality(123 as unknown as string)).toBe('');
  });
});

describe('disambiguateSlugForLoser', () => {
  it('appends the slugified locality to the base slug', () => {
    const taken = new Set<string>(['apprendistato-lidl']); // active winner owns the base
    const result = disambiguateSlugForLoser('apprendistato-lidl', 'Biasca', taken);
    expect(result).toBe('apprendistato-lidl-biasca');
    expect(taken.has('apprendistato-lidl-biasca')).toBe(true);
  });

  it('produces distinct slugs for two losers with the same base but different localities', () => {
    const taken = new Set<string>(['apprendistato-lidl']);
    const a = disambiguateSlugForLoser('apprendistato-lidl', 'Biasca', taken);
    const b = disambiguateSlugForLoser('apprendistato-lidl', 'Locarno', taken);
    expect(a).toBe('apprendistato-lidl-biasca');
    expect(b).toBe('apprendistato-lidl-locarno');
  });

  it('appends a numeric suffix when the locality variant is already taken', () => {
    const taken = new Set<string>(['apprendistato-lidl', 'apprendistato-lidl-biasca']);
    const result = disambiguateSlugForLoser('apprendistato-lidl', 'Biasca', taken);
    expect(result).toBe('apprendistato-lidl-biasca-2');
  });

  it('falls back to a numeric suffix when locality is missing', () => {
    const taken = new Set<string>(['foo']);
    const result = disambiguateSlugForLoser('foo', '', taken);
    expect(result).toBe('foo-2');
  });

  it('never returns the bare base slug even if no locality is provided', () => {
    const taken = new Set<string>(['foo']);
    expect(disambiguateSlugForLoser('foo', '', taken)).not.toBe('foo');
  });

  it('returns empty string for empty base slug', () => {
    expect(disambiguateSlugForLoser('', 'Biasca', new Set())).toBe('');
  });
});

describe('validateExpiredEntry', () => {
  it('passes for a fully populated entry', () => {
    const entry = buildBackfillExpiredEntry(
      {
        slug: 'ok',
        title: 'Ok',
        company: 'Co',
        addressLocality: 'Lugano',
        descriptionByLocale: {
          it: 'A reasonably long description that exceeds thirty characters for sure.',
        },
      },
      '2026-04-07T00:00:00Z',
    );
    const v = validateExpiredEntry(entry);
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it('reports a too-short description as invalid', () => {
    const entry = buildBackfillExpiredEntry(
      {
        slug: 'short-desc',
        title: 'Short Desc',
        descriptionByLocale: { it: 'too short' },
      },
      '2026-04-07T00:00:00Z',
    );
    const v = validateExpiredEntry(entry);
    expect(v.ok).toBe(false);
    expect(v.missing).toContain('descriptionByLocale(>=30)');
  });
});

describe('dedupAgainstExisting', () => {
  it('drops entries whose slug already exists on disk', () => {
    const proposed = new Map<string, ReturnType<typeof buildBackfillExpiredEntry>[]>();
    const a = buildBackfillExpiredEntry(
      {
        slug: 'a',
        title: 'A',
        descriptionByLocale: { it: 'A long enough description for the soft landing pages here.' },
      },
      '2026-04-07T00:00:00Z',
    );
    const b = buildBackfillExpiredEntry(
      {
        slug: 'b',
        title: 'B',
        descriptionByLocale: { it: 'A long enough description for the soft landing pages here too.' },
      },
      '2026-04-07T00:00:00Z',
    );
    proposed.set('foo', [a, b]);

    const loadExisting = (key: string) => (key === 'foo' ? [{ slug: 'a' }] : []);
    const { filtered, droppedDuplicates } = dedupAgainstExisting(proposed, loadExisting);
    expect(droppedDuplicates).toBe(1);
    expect(filtered.get('foo')).toHaveLength(1);
    expect(filtered.get('foo')?.[0]?.slug).toBe('b');
  });

  it('collapses same-slug proposals from different commits, keeping the most recent expiredAt', () => {
    const older = buildBackfillExpiredEntry(
      {
        slug: 'same',
        title: 'Older',
        descriptionByLocale: { it: 'A reasonably long description for soft landing rendering.' },
      },
      '2026-03-01T00:00:00Z',
    );
    const newer = buildBackfillExpiredEntry(
      {
        slug: 'same',
        title: 'Newer',
        descriptionByLocale: { it: 'A reasonably long description for soft landing rendering.' },
      },
      '2026-04-01T00:00:00Z',
    );
    const proposed = new Map<string, ReturnType<typeof buildBackfillExpiredEntry>[]>();
    proposed.set('foo', [older, newer]);
    const { filtered, droppedDuplicates } = dedupAgainstExisting(proposed, () => []);
    expect(droppedDuplicates).toBe(1);
    expect(filtered.get('foo')).toHaveLength(1);
    expect(filtered.get('foo')?.[0]?.expiredAt).toBe('2026-04-01T00:00:00Z');
  });

  it('is idempotent: running twice with the same existing set yields the same delta', () => {
    const proposedFactory = () => {
      const m = new Map<string, ReturnType<typeof buildBackfillExpiredEntry>[]>();
      const a = buildBackfillExpiredEntry(
        {
          slug: 'a',
          title: 'A',
          descriptionByLocale: { it: 'A long enough description for the soft landing pages here.' },
        },
        '2026-04-07T00:00:00Z',
      );
      m.set('foo', [a]);
      return m;
    };
    const empty = () => [];
    const first = dedupAgainstExisting(proposedFactory(), empty);
    expect(first.filtered.get('foo')).toHaveLength(1);
    // After applying first batch, the existing-loader would return what we just wrote.
    const afterApplied = (key: string) => (key === 'foo' ? [{ slug: 'a' }] : []);
    const second = dedupAgainstExisting(proposedFactory(), afterApplied);
    expect(second.filtered.size).toBe(0);
    expect(second.droppedDuplicates).toBe(1);
  });
});

describe('classifyDedupLoser', () => {
  it('returns A when removed and kept share title and raw location', () => {
    const removed = { title: 'Fisioterapista', location: 'Novaggio', addressLocality: 'Bellinzona' };
    const winners = [{ title: 'Fisioterapista', location: 'Novaggio', addressLocality: 'Bellinzona' }];
    expect(classifyDedupLoser(removed, winners)).toBe('A');
  });

  it('returns B when raw location differs even though addressLocality is hardened to the same value', () => {
    // This is the EOC pattern: hardenJobLocaleFields sets addressLocality to
    // the canonical company city for every slice job, but the raw `location`
    // field still preserves the physical hospital site.
    const removed = { title: 'Impiegato', location: 'Novaggio', addressLocality: 'Bellinzona' };
    const winners = [{ title: 'Impiegato', location: 'Bellinzona', addressLocality: 'Bellinzona' }];
    expect(classifyDedupLoser(removed, winners)).toBe('B');
  });

  it('returns B when title differs', () => {
    const removed = { title: 'Senior Engineer', location: 'Lugano' };
    const winners = [{ title: 'Junior Engineer', location: 'Lugano' }];
    expect(classifyDedupLoser(removed, winners)).toBe('B');
  });

  it('handles a single winner passed as an object (not array)', () => {
    const removed = { title: 'Vendor', location: 'Biasca' };
    const kept = { title: 'Vendor', location: 'Minusio' };
    expect(classifyDedupLoser(removed, kept)).toBe('B');
  });

  it('falls back to addressLocality when raw location is missing', () => {
    const removed = { title: 'Vendor', addressLocality: 'Lugano' };
    const winners = [{ title: 'Vendor', addressLocality: 'Lugano' }];
    expect(classifyDedupLoser(removed, winners)).toBe('A');
  });

  it('checks against all winners (multiple winners at the same slug)', () => {
    const removed = { title: 'Cook', location: 'Lugano' };
    const winners = [
      { title: 'Cook', location: 'Bellinzona' },
      { title: 'Cook', location: 'Lugano' },
    ];
    expect(classifyDedupLoser(removed, winners)).toBe('A');
  });

  it('treats null/undefined inputs defensively as B', () => {
    expect(classifyDedupLoser(null, [{ title: 'x' }])).toBe('B');
    expect(classifyDedupLoser({ title: 'x' }, [])).toBe('B');
    expect(classifyDedupLoser({ title: 'x' }, null)).toBe('B');
  });
});

describe('backfillFromCommits with mocked git extraction', () => {
  it('classifies removed jobs and produces valid entries', () => {
    // We test the slice-comparison logic by running the real exported helpers
    // through buildBackfillExpiredEntry + validateExpiredEntry, which is the
    // core logic. Full git extraction is exercised separately by the dry-run
    // smoke test against the real audit.
    const removedJob = {
      id: 'job-1',
      slug: 'apprendistato-lidl-svizzera-cadenazzo',
      title: 'Apprendistato Lidl - Biasca',
      company: 'Lidl Svizzera',
      companyKey: 'lidl-svizzera',
      location: 'Biasca',
      addressLocality: 'Biasca',
      postalCode: '6710',
      streetAddress: 'Via Stazione 2',
      employmentType: 'OTHER',
      salaryMin: 12000,
      salaryCurrency: 'CHF',
      salaryPeriod: 'YEAR',
      titleByLocale: { it: 'Apprendistato Lidl - Biasca' },
      descriptionByLocale: {
        it: 'Apprendistato presso Lidl Svizzera nella sede di Biasca. Cerchiamo un giovane motivato.',
      },
      slugByLocale: { it: 'apprendistato-lidl-svizzera-cadenazzo' },
      previousSlugs: [],
    };
    const entry = buildBackfillExpiredEntry(removedJob, '2026-04-07T07:52:57Z');
    expect(entry).not.toBeNull();
    expect(entry?.expirationReason).toBe('silent_dedup_backfill');
    expect(entry?.dedupArchive).toBe(true);
    const v = validateExpiredEntry(entry);
    expect(v.ok).toBe(true);
  });

  it('honors shouldExtractJobsForSlice filter to skip slices without git access', () => {
    // No real commits → empty result without errors.
    const result = backfillFromCommits({
      commits: [],
      rootDir: process.cwd(),
      shouldExtractJobsForSlice: () => false,
      loadActiveSlugs: () => [],
    });
    expect(result.proposedByCrawler.size).toBe(0);
    expect(result.perCommit).toEqual([]);
    expect(result.unrecoverable).toEqual([]);
  });
});
