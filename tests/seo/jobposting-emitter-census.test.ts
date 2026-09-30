import { describe, expect, it } from 'vitest';
import {
  checkJobPostingEmitterCensus,
  JOBPOSTING_EMITTER_MANIFEST,
  JOBPOSTING_EMITTER_MANIFEST_VERSION,
  JOBPOSTING_PUBLIC_VARIANTS,
} from '../../scripts/ci/jobposting-emitter-census.mjs';

describe('public JobPosting emitter census', () => {
  it('keeps every public path registered and builder-backed', () => {
    const result = checkJobPostingEmitterCensus();
    expect(result.failures, result.failures.join('\n')).toEqual([]);
  });

  it('is versioned and covers every locale prefix and public variant', () => {
    expect(JOBPOSTING_EMITTER_MANIFEST.version).toBe(JOBPOSTING_EMITTER_MANIFEST_VERSION);
    expect(Object.keys(JOBPOSTING_EMITTER_MANIFEST.localePrefixes).sort()).toEqual(['de', 'en', 'fr', 'it']);
    expect(JOBPOSTING_EMITTER_MANIFEST.variants).toEqual(JOBPOSTING_PUBLIC_VARIANTS);
    expect(new Set(JOBPOSTING_EMITTER_MANIFEST.emitters.map((entry) => entry.sourceFile)).size)
      .toBe(JOBPOSTING_EMITTER_MANIFEST.emitters.length);
  });
});
