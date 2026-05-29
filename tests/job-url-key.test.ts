/**
 * Behavior-preserving consolidation guard for the three job URL-key variants.
 *
 * extractStableJobId (merge), assemblerIdentity's URL branch (assemble), and
 * normalizeIdentityUrl (identity) were three separate URL normalizations that
 * diverged in subtle ways. They were consolidated into scripts/lib/job-url-key.mjs
 * (mergeUrlKey / assembleUrlKey / identityUrlKey). These are PERSISTED dedup/merge
 * keys — this test pins each variant's output byte-for-byte so the consolidation
 * (and any future change) cannot silently re-key existing jobs.
 */
import { describe, it, expect } from 'vitest';
import { mergeUrlKey, assembleUrlKey, identityUrlKey, lowerStripTrailingSlash } from '../scripts/lib/job-url-key.mjs';
import { extractStableJobId } from '../scripts/lib/job-match-key.mjs';
import { buildStableJobIdentity } from '../scripts/lib/job-identity.mjs';

const GALENICA = 'https://www.galenica.com/it/jobs/#job.id=12345';

describe('mergeUrlKey (crawl-time merge key — was extractStableJobId)', () => {
  it('extracts a UUID across vendor slug renames', () => {
    const a = 'https://jobs.pwc.ch/job-vacancies/old-title/0441e237-ebd9-4263-9fe5-e21facbd03ba';
    const b = 'https://jobs.pwc.ch/job-vacancies/renamed/0441e237-ebd9-4263-9fe5-e21facbd03ba';
    expect(mergeUrlKey(a)).toBe('uuid:0441e237-ebd9-4263-9fe5-e21facbd03ba');
    expect(mergeUrlKey(a)).toBe(mergeUrlKey(b));
  });
  it('falls back to long numeric id', () => {
    expect(mergeUrlKey('https://example.com/jobs/123456/old')).toBe('num:123456');
  });
  it('falls back to long hex token', () => {
    expect(mergeUrlKey('https://example.com/jobs/abcdef0123/old')).toBe('hex:abcdef0123');
  });
  it('falls back to normalized full URL', () => {
    expect(mergeUrlKey('https://example.com/jobs/only-a-slug')).toBe('url:https://example.com/jobs/only-a-slug');
  });
  it('decodes &amp; before keying', () => {
    expect(mergeUrlKey('https://example.com/jobs/only-a-slug?a=1&amp;b=2')).toBe('url:https://example.com/jobs/only-a-slug?a=1&b=2');
  });
  it('normalizes trailing slash + case', () => {
    expect(mergeUrlKey('https://Example.com/Path/')).toBe(mergeUrlKey('https://example.com/path'));
  });
  it('returns empty string for empty input', () => {
    expect(mergeUrlKey('')).toBe('');
    expect(mergeUrlKey(undefined as unknown as string)).toBe('');
  });
});

describe('extractStableJobId delegates to mergeUrlKey unchanged', () => {
  const corpus = [
    'https://jobs.pwc.ch/job-vacancies/x/0441e237-ebd9-4263-9fe5-e21facbd03ba',
    'https://example.com/jobs/123456/old',
    'https://example.com/jobs/abcdef0123/old',
    'https://example.com/jobs/only-a-slug',
    'https://Example.com/Path/',
    'https://example.com/jobs/only-a-slug?a=1&amp;b=2',
    GALENICA,
    '',
  ];
  for (const url of corpus) {
    it(`matches mergeUrlKey for: ${url || '(empty)'}`, () => {
      expect(extractStableJobId(url)).toBe(mergeUrlKey(url));
    });
  }
});

describe('assembleUrlKey (assemble-time dedup key)', () => {
  it('lowercases + strips trailing slash, no url: prefix', () => {
    expect(assembleUrlKey('https://Example.com/Path/')).toBe('https://example.com/path');
  });
  it('PRESERVES hash fragments (Galenica positions)', () => {
    expect(assembleUrlKey(GALENICA)).toBe('https://www.galenica.com/it/jobs/#job.id=12345');
  });
  it('returns empty string for empty input', () => {
    expect(assembleUrlKey('')).toBe('');
  });
  it('equals lowerStripTrailingSlash', () => {
    expect(assembleUrlKey(GALENICA)).toBe(lowerStripTrailingSlash(GALENICA));
  });
});

describe('identityUrlKey (stats/diff/firstSeenAt identity)', () => {
  it('STRIPS hash fragments (and the trailing-slash pathname)', () => {
    expect(identityUrlKey(GALENICA)).toBe('https://www.galenica.com/it/jobs');
  });
  it('strips default ports', () => {
    expect(identityUrlKey('https://example.com:443/jobs/x')).toBe('https://example.com/jobs/x');
  });
  it('normalizes trailing slash + case', () => {
    expect(identityUrlKey('https://Example.com/Path/')).toBe('https://example.com/path');
  });
  it('falls back gracefully for unparseable input', () => {
    expect(identityUrlKey('not a url/')).toBe('not a url');
  });
  it('returns empty string for empty input', () => {
    expect(identityUrlKey('')).toBe('');
  });
});

describe('intentional divergence: hash handling', () => {
  it('assemble preserves but identity strips the Galenica fragment', () => {
    expect(assembleUrlKey(GALENICA)).not.toBe(identityUrlKey(GALENICA));
    expect(assembleUrlKey(GALENICA)).toContain('#job.id=12345');
    expect(identityUrlKey(GALENICA)).not.toContain('#');
  });
  it('buildStableJobIdentity uses the hash-stripped identity variant', () => {
    expect(buildStableJobIdentity({ url: GALENICA })).toBe(`url:${identityUrlKey(GALENICA)}`);
  });
});
