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
import { extractStableJobId } from '../scripts/lib/job-match-key.mjs';

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
