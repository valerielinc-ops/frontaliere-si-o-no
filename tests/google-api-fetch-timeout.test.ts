import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  it('bounds every direct Google request in the audited tools', () => {
    const helper = readFileSync(resolve(ROOT, 'scripts/lib/google-api-fetch.mjs'), 'utf8');
    expect(helper).toContain('AbortSignal.timeout(GOOGLE_API_FETCH_TIMEOUT_MS)');

    for (const relativePath of SCRIPT_PATHS) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).toContain('fetchGoogleApi(');
      expect(source.match(/await fetch\(/g) || [], relativePath).toHaveLength(0);
    }
  });
});
