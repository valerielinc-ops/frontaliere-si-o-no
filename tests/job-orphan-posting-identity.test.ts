import { describe, expect, it } from 'vitest';
import {
  hasSameJobSourcePosting,
  sourcePostingUrlHref,
  sourcePostingUrlHrefs,
} from '../scripts/lib/job-identity.mjs';
import { inferOrphanSlugAliases } from '../scripts/lib/orphan-slug-fuzzy-match.mjs';
import { backfillOrphanSlugAliases } from '../scripts/backfill-slug-aliases.mjs';
import { reconcileOrphanSlugs, reconcileExpiredSlugs } from '../scripts/reconcile-job-slugs.mjs';

describe('inferred orphan aliases require positive posting identity', () => {
  const url = 'https://jobs.example.invalid/vacancies/orthopedics/';
  const addPreviousSlugForLocale = (
    job: { previousSlugsByLocale?: Record<string, string[]> },
    locale: string,
    slug: string,
  ) => {
    if (!job.previousSlugsByLocale) job.previousSlugsByLocale = {};
    if (!Array.isArray(job.previousSlugsByLocale[locale])) job.previousSlugsByLocale[locale] = [];
    if (!job.previousSlugsByLocale[locale].includes(slug)) job.previousSlugsByLocale[locale].push(slug);
  };
  it.each([{}, { sourceUrl: '' }, { sourceUrl: '/vacancies/orthopedics/' },
    { sourceUrl: 'https://jobs.example.invalid/vacancies/oncology/' },
    { sourceUrl: 'mailto:jobs@example.invalid' }])('rejects unknown or different identity: %j', (record) => {
    expect(hasSameJobSourcePosting(record, { url })).toBe(false);
  });
  it('accepts the exact source posting, not just its company', () => {
    expect(hasSameJobSourcePosting({ sourceUrl: url }, { url })).toBe(true);
    expect(hasSameJobSourcePosting({ url }, { url })).toBe(true);
    expect(hasSameJobSourcePosting({ sourceUrl: url }, {})).toBe(false);
  });
  it('does not collapse distinct fragment-addressed postings', () => {
    expect(hasSameJobSourcePosting({ sourceUrl: `${url}#job.id=1` }, { url: `${url}#job.id=2` })).toBe(false);
    expect(hasSameJobSourcePosting({ sourceUrl: `${url}AbC/` }, { url: `${url}abc/` })).toBe(false);
  });
  it('recognizes explicit archive source identity and dedup history', () => {
    expect(hasSameJobSourcePosting({ sourceIdentity: `url:${url}` }, { url })).toBe(true);
    expect(hasSameJobSourcePosting({ sourceIdentityHistory: [{ sourceIdentity: `url:${url}` }] }, { url })).toBe(true);
  });
  it('normalizes only absolute HTTP(S) source URLs while preserving path case and fragments', () => {
    expect(sourcePostingUrlHref('https://jobs.example.invalid:443/vacancies/AbC/#job.id=1'))
      .toBe('https://jobs.example.invalid/vacancies/AbC/#job.id=1');
    expect(sourcePostingUrlHref('mailto:jobs@example.invalid')).toBeNull();
    expect(sourcePostingUrlHrefs({
      sourceUrl: url,
      sourceIdentity: `url:${url}#job.id=1`,
      sourceIdentityHistory: [{ sourceIdentity: `url:${url}#job.id=2` }],
    })).toEqual(new Set([url, `${url}#job.id=1`, `${url}#job.id=2`]));
  });
  it('treats an explicit null historical record as having no source URLs', () => {
    expect(sourcePostingUrlHrefs(null)).toEqual(new Set());
  });
  it('also leaves identity-less expired fuzzy matches archived', () => {
    const active = { url, slug: 'software-entwickler-backend-rotation', company: 'Acme', companyKey: 'acme' };
    const expired = { slug: 'software-entwickler-backend', company: 'Acme', companyKey: 'acme' };
    const result = reconcileExpiredSlugs([active], [expired]);
    expect(result.mergedCount).toBe(0);
    expect(result.updatedExpired).toEqual([expired]);
  });
  it.each([undefined, 'https://jobs.example.invalid/vacancies/another/'])('leaves a high-overlap but unproven orphan archived (%s)', (sourceUrl) => {
    const slug = 'software-entwickler-backend';
    const active = { url, slug: `${slug}-rotation`, slugByLocale: { de: `${slug}-rotation` }, company: 'Acme', companyKey: 'acme' };
    const result = reconcileOrphanSlugs([active], [slug], [{ slug, sourceUrl }]);
    expect(result.mergedCount).toBe(0);
    expect(result.remainingOrphans).toEqual([slug]);
    expect(active).not.toHaveProperty('previousSlugs');
  });
  it('keeps the verified same-posting rename', () => {
    const slug = 'software-entwickler-backend';
    const active = { url, slug: `${slug}-rotation`, slugByLocale: { de: `${slug}-rotation` }, company: 'Acme', companyKey: 'acme' };
    const result = reconcileOrphanSlugs([active], [slug], [{ slug, sourceUrl: url }]);
    expect(result.mergedCount).toBe(1);
  });
  it.each([undefined, 'https://jobs.example.invalid/vacancies/oncology/', url])('executes the SSG fuzzy matcher without guessing oncology ownership (%s)', (sourceUrl) => {
    const orphan = 'head-physician-oncology-60-100-spital-uster-uster';
    const job = { url, location: 'Uster', slug: 'assistant-physician-100-orthopedics-spital-uster-uster', slugByLocale: { en: 'assistant-physician-100-orthopedics-spital-uster-uster' } };
    const result = inferOrphanSlugAliases({
      validJobs: [job],
      tracking: { [orphan]: {} },
      orphanGscData: new Map([[orphan, { sourceUrl }]]),
      localeList: ['en'],
      hasSameJobSourcePosting,
      addPreviousSlugForLocale,
    });
    // Even the legacy >=60% overlap must not create an alias without source proof.
    if (sourceUrl === url) {
      expect(result.fuzzyMatched).toBe(1);
      expect(job).toHaveProperty('previousSlugsByLocale.en', [orphan]);
    } else {
      expect(result.fuzzyMatched).toBe(0);
      expect(job).not.toHaveProperty('previousSlugsByLocale');
    }
  });
  it.each([
    { sourceUrls: [] },
    { sourceUrls: ['https://jobs.example.invalid/vacancies/oncology/'] },
    { sourceUrls: [url] },
    { sourceUrls: [url, 'https://jobs.example.invalid/vacancies/oncology/'] },
  ])('also gates the one-shot backfill heuristic (%j)', ({ sourceUrls }) => {
    const orphan = 'head-physician-oncology-60-100-spital-uster-uster';
    const job = { url, company: 'Spital Uster', location: 'Uster', slug: 'assistant-physician-100-orthopedics-spital-uster-uster' };
    const result = backfillOrphanSlugAliases({
      orphanSlugs: [orphan],
      byCompany: new Map([['spital-uster', [job]]]),
      enrichedRecords: sourceUrls.map((sourceUrl) => ({ slug: orphan, sourceUrl })),
      hasSameJobSourcePosting,
    });
    if (sourceUrls.length === 1 && sourceUrls[0] === url) {
      expect(result.added).toBe(1);
      expect(job).toHaveProperty('previousSlugs', [orphan]);
    } else {
      expect(result.added).toBe(0);
      expect(job).not.toHaveProperty('previousSlugs');
    }
  });
});
