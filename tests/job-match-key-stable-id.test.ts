/**
 * Crawler merge matchKey must survive vendor URL renames.
 *
 * Regression test for the PwC case in commit fe6c222fb8: PwC's Prospective.ch
 * API rewrites the slug-portion of the URL when titles change, but the
 * underlying UUID (last path segment) is stable. Keying on the full URL
 * dropped 4 still-live PwC jobs from the per-crawler slice and surfaced
 * them as expired soft-landings at the old canton-aware URL. Keying on the
 * stable token preserves the merge.
 */
import { describe, it, expect } from 'vitest';
import {
  extractStableJobId,
  hasUsableJobId,
  mergeJobIdentity,
  resolveJobDiffKey,
} from '../scripts/lib/job-match-key.mjs';
import { fingerprintJob } from '../scripts/lib/dedicated-crawler-common.mjs';

describe('hasUsableJobId', () => {
  it('accepts numeric zero but rejects nullish and empty ids', () => {
    expect(hasUsableJobId({ id: 0 })).toBe(true);
    expect(hasUsableJobId({ id: '' })).toBe(false);
    expect(hasUsableJobId({ id: null })).toBe(false);
    expect(hasUsableJobId({})).toBe(false);
  });
});

describe('extractStableJobId', () => {
  it('extracts the UUID from PwC-style URLs', () => {
    const oldUrl = 'https://jobs.pwc.ch/job-vacancies/stage-de-3-mois-en-audit-financial-services-janvier-a-mars-2027/0441e237-ebd9-4263-9fe5-e21facbd03ba';
    const newUrl = 'https://jobs.pwc.ch/job-vacancies/fy27-asr-asr-fs-ge-geneve-intern-trainee-start-01-01-2027/0441e237-ebd9-4263-9fe5-e21facbd03ba';
    expect(extractStableJobId(oldUrl)).toBe(extractStableJobId(newUrl));
    expect(extractStableJobId(oldUrl)).toBe('uuid:0441e237-ebd9-4263-9fe5-e21facbd03ba');
  });

  it('matches the 4 dropped PwC jobs from commit fe6c222fb8 across renames', () => {
    // Each pair = (old URL with old slug-path, current URL with renamed slug-path)
    const pairs: Array<[string, string]> = [
      [
        'https://jobs.pwc.ch/job-vacancies/manager-en-regulatory-risk-compliance/d2de2681-2cab-4be6-81f7-42aa65af92af',
        'https://jobs.pwc.ch/job-vacancies/manager-in-regulatory-compliance/d2de2681-2cab-4be6-81f7-42aa65af92af',
      ],
      [
        'https://jobs.pwc.ch/job-vacancies/stage-de-3-mois-en-audit-financial-services-janvier-a-mars-2027/0441e237-ebd9-4263-9fe5-e21facbd03ba',
        'https://jobs.pwc.ch/job-vacancies/fy27-asr-asr-fs-ge-geneve-intern-trainee-start-01-01-2027/0441e237-ebd9-4263-9fe5-e21facbd03ba',
      ],
      [
        'https://jobs.pwc.ch/job-vacancies/career-start-in-audit-asset-management-herbst-2026/7934c456-7ad6-45f5-a1f2-f04cf7b44c61',
        'https://jobs.pwc.ch/job-vacancies/career-start-in-audit-asset-management-herbst-2026/7934c456-7ad6-45f5-a1f2-f04cf7b44c61',
      ],
      [
        'https://jobs.pwc.ch/job-vacancies/audit-career-start-im-bereich-financial-services-herbst-2026/2add8415-5909-4616-afd1-af269dd36672',
        'https://jobs.pwc.ch/job-vacancies/audit-career-start-im-bereich-financial-services-herbst-2026/2add8415-5909-4616-afd1-af269dd36672',
      ],
    ];
    for (const [oldUrl, newUrl] of pairs) {
      expect(extractStableJobId(oldUrl)).toBe(extractStableJobId(newUrl));
    }
  });

  it('falls back to long numeric ID when no UUID is present', () => {
    const a = 'https://example.com/jobs/123456/old-title';
    const b = 'https://example.com/jobs/123456/renamed-title';
    expect(extractStableJobId(a)).toBe(extractStableJobId(b));
    expect(extractStableJobId(a)).toBe('num:123456');
  });

  it('falls back to long hex token when no UUID/numeric ID present', () => {
    const a = 'https://example.com/jobs/abcdef0123/old';
    const b = 'https://example.com/jobs/abcdef0123/renamed';
    expect(extractStableJobId(a)).toBe(extractStableJobId(b));
  });

  it('falls back to normalized full URL when nothing stable is found', () => {
    const url = 'https://example.com/jobs/only-a-slug';
    expect(extractStableJobId(url)).toBe('url:https://example.com/jobs/only-a-slug');
  });

  it('returns empty string for empty input', () => {
    expect(extractStableJobId('')).toBe('');
    expect(extractStableJobId(undefined as unknown as string)).toBe('');
  });

  it('normalises trailing slashes and case', () => {
    expect(extractStableJobId('https://Example.com/Path/')).toBe(extractStableJobId('https://example.com/path'));
  });
});

// Regression coverage for #3411: scan-prev-slug-losses.mjs and
// backfill-prev-slugs-from-loss-events.mjs build Map<key, job> diff/lookup
// structures from raw per-crawler slice files, where several dedicated
// crawlers (ferrovia-retica, julius-baer, mikron, relewant,
// swiss-medical-network, casale) commit records with `.id` unset — it's
// only stamped at data/jobs.json assembly time. Keying those Maps on bare
// `job.id` collapsed every id-less job in a slice onto the shared
// `undefined` key, corrupting lookups instead of just missing them.
describe('resolveJobDiffKey', () => {
  it('prefers the real .id when present', () => {
    const job = { id: 'company-abc123', url: 'https://example.com/jobs/1' };
    expect(resolveJobDiffKey(job)).toBe('company-abc123');
    expect(resolveJobDiffKey({ id: 0, slug: 'fallback' })).toBe('0');
  });

  it('falls back to the stable URL-derived key when .id is absent', () => {
    const job = { url: 'https://www.rhb.ch/it/job/some-title_2026-2227/' };
    expect(resolveJobDiffKey(job)).toBe(extractStableJobId(job.url));
    expect(resolveJobDiffKey(job)).not.toContain('undefined');
  });

  it('produces distinct keys for distinct id-less jobs sharing no id (no collision)', () => {
    const jobA = { url: 'https://www.rhb.ch/it/job/job-a/' };
    const jobB = { url: 'https://www.rhb.ch/it/job/job-b/' };
    const keyA = resolveJobDiffKey(jobA);
    const keyB = resolveJobDiffKey(jobB);
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBeNull();
    expect(keyB).not.toBeNull();
  });

  it('falls back to slug when both .id and .url are absent', () => {
    const job = { slug: 'Some-Job-Slug' };
    expect(resolveJobDiffKey(job)).toBe('slug:some-job-slug');
  });

  it('returns null when a job has no id, url, or slug', () => {
    expect(resolveJobDiffKey({})).toBeNull();
    expect(resolveJobDiffKey(undefined as unknown as Record<string, unknown>)).toBeNull();
  });

  it('does not double-prefix the already-namespaced extractStableJobId output', () => {
    const job = { url: 'https://example.com/jobs/only-a-slug' };
    const key = resolveJobDiffKey(job);
    expect(key).toBe('url:https://example.com/jobs/only-a-slug');
    expect(key).not.toContain('url:url:');
  });
});

describe('mergeJobIdentity ETA recycled requisition (issue 8624)', () => {
  // Two records in eta-sa-swatch-group shared URL-key `req:eta.ch:3770` but
  // were distinct postings (polymechaniker vs quality-assurance). The
  // crawl-time merge (fingerprintJob → mergeAndDeduplicate) and the default
  // dedicated matchKey now go through mergeJobIdentity so those slugs mint
  // two keys, while an ancestor-path rename of the SAME slug still collapses.
  const url = 'https://www.eta.ch/en/jobs-careers/vacancies/detail/3770';
  const urlIndexPhp = 'https://www.eta.ch/index.php/en/jobs-careers/vacancies/detail/3770';
  const polySlug = 'polymechaniker-in-nel-settore-area-80-100-sul-sito-produzione-horlogere-suisse-eta-sa-eta-sa-swatch-group-2540-grenchen';
  const qaSlug = 'responsabile-qualitaetssicherung-vor-ort-manufacture-horlogere-suisse-eta-sa-swatch-group-2540-grenchen-phone-49gsdw';
  const poly = { url, slug: polySlug };
  const qa = { url, slug: qaSlug };

  it('gives two jobs sharing req:3770 and divergent slugs two identities, not one', () => {
    const keys = [mergeJobIdentity(poly), mergeJobIdentity(qa)];
    expect(keys[0]).not.toBe(keys[1]);
    expect(new Set(keys).size).toBe(2);
    expect(extractStableJobId(url)).toBe('req:eta.ch:3770');
    expect(keys.every((k) => k.startsWith('req:eta.ch:3770#'))).toBe(true);
  });

  it('still collapses an index.php ancestor rename of the same slug', () => {
    expect(mergeJobIdentity({ url, slug: polySlug }))
      .toBe(mergeJobIdentity({ url: urlIndexPhp, slug: polySlug }));
  });

  it('keeps the URL-only key when no slug/title is present (no silent re-key)', () => {
    expect(mergeJobIdentity({ url })).toBe(extractStableJobId(url));
    expect(mergeJobIdentity({ url })).toBe('req:eta.ch:3770');
  });

  it('does not alter non-ETA hosts', () => {
    const job = { url: 'https://example.com/careers/vacancies/detail/3770', slug: polySlug };
    expect(mergeJobIdentity(job)).toBe(extractStableJobId(job.url));
  });

  it('fingerprintJob (swatchgroup merge key) also yields two keys for those slugs', () => {
    const fps = [fingerprintJob(poly), fingerprintJob(qa)];
    expect(fps[0]).not.toBe(fps[1]);
    expect(new Set(fps).size).toBe(2);
    expect(fingerprintJob({ url })).toBe('id|eta.ch|3770');
  });
});
