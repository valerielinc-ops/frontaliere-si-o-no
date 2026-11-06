import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeGoogleApiFetchTimeout } from '../scripts/lib/google-api-fetch.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATHS = [
  'scripts/analytics-report.mjs',
  'scripts/canary-user-value.mjs',
  'scripts/check-gsc-frontaliere-baseline.mjs',
  'scripts/find-orphan-indexed-jobs.mjs',
  'scripts/refresh-indexed-cluster-urls.mjs',
  'scripts/refresh-noslash-keep.mjs',
  'scripts/revenue-monitor.mjs',
  'scripts/setup-google-oauth.mjs',
  'scripts/user-value-report.mjs',
];

describe('Google API helper adoption', () => {
  it('normalizes invalid and fractional configured deadlines safely', () => {
    expect(normalizeGoogleApiFetchTimeout('-1')).toBe(30_000);
    expect(normalizeGoogleApiFetchTimeout('0.5')).toBe(30_000);
    expect(normalizeGoogleApiFetchTimeout('Infinity')).toBe(30_000);
    expect(normalizeGoogleApiFetchTimeout('300000')).toBe(120_000);
    expect(normalizeGoogleApiFetchTimeout('45000')).toBe(45_000);
  });

  it('bounds every direct Google request in the audited tools', () => {
    const helper = readFileSync(resolve(ROOT, 'scripts/lib/google-api-fetch.mjs'), 'utf8');
    expect(helper).toContain('AbortSignal.timeout(GOOGLE_API_FETCH_TIMEOUT_MS)');

    for (const relativePath of SCRIPT_PATHS) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).toContain('fetchGoogleApi(');
      expect(source.match(/await fetch\(/g) || [], relativePath).toHaveLength(0);
    }
  });

  it('bounds the pinned corpus manifest read as well', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/pull-articles-corpus.mjs'), 'utf8');
    expect(source).toContain("import { fetchWithRefTimeout } from './lib/fetch-with-ref-timeout.mjs';");
    expect(source).toContain("fetchWithRefTimeout(url, { redirect: 'follow' })");
    expect(source.match(/await fetch\(/g) || []).toHaveLength(0);
  });
});
