import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkJobPostingEmitterCensus,
  JOBPOSTING_EMITTER_MANIFEST,
  JOBPOSTING_EMITTER_MANIFEST_VERSION,
  JOBPOSTING_PUBLIC_VARIANTS,
} from '../../scripts/ci/jobposting-emitter-census.mjs';
import { buildReportedJobPostingFixture as buildJobPostingSchema } from '../helpers/reported-job-schema';

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

  it('keeps the hydrated JobBoard address tuple aligned with static output', () => {
    // Both paths hand the canonical builder the source street/CAP and internal
    // provenance; one shared resolver applies the same-city enrichment (#9108).
    const jobBoardSource = readFileSync('components/community/JobBoard.tsx', 'utf8');
    expect(jobBoardSource).toContain("const postalCode = String(job.postalCode || '').trim();");
    expect(jobBoardSource).toContain("streetAddress: isValidAddr(rawStreet) ? rawStreet : ''");
    expect(jobBoardSource).not.toMatch(/resolveJobPostingPostalCode\(/);

    const job = {
      id: 'jobposting-census-address',
      title: 'Infermiere',
      description: 'Ruolo infermieristico con responsabilità cliniche e collaborazione con il team multidisciplinare.',
      company: 'Test Arbeitgeber',
      location: 'Chur',
      addressLocality: 'Chur',
      canton: 'GR',
      postalCode: '8600',
      streetAddress: 'Hauptsitzstrasse 1',
      crawledAt: new Date(Date.now() - 86400000).toISOString(),
    };
    const opts = {
      locale: 'it',
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/chur/',
    };
    const hydrated = buildJobPostingSchema({ ...job }, opts).jobLocation.address;
    const staticAddress = buildJobPostingSchema(job, opts).jobLocation.address;

    expect(hydrated).toEqual(staticAddress);
    // 8600 is not Chur's CAP, so the place keeps Chur's CAP and the source
    // street stays present instead of being discarded with the bad CAP.
    expect(hydrated).toEqual({
      '@type': 'PostalAddress',
      streetAddress: 'Hauptsitzstrasse 1',
      addressLocality: 'Chur',
      addressRegion: 'GR',
      addressCountry: 'CH',
      postalCode: '7000',
    });
  });
});
