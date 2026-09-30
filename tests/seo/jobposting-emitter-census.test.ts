import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkJobPostingEmitterCensus,
  JOBPOSTING_EMITTER_MANIFEST,
  JOBPOSTING_EMITTER_MANIFEST_VERSION,
  JOBPOSTING_PUBLIC_VARIANTS,
} from '../../scripts/ci/jobposting-emitter-census.mjs';
import { buildJobPostingSchema } from '../../build-plugins/shared/jobPostingSchema';
import { resolveJobPostingPostalCode } from '../../services/jobLocationSnapshot';

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
    const jobBoardSource = readFileSync('components/community/JobBoard.tsx', 'utf8');
    expect(jobBoardSource).toMatch(/const \{ postalCode, sourcePostalCoherent \} = resolveJobPostingPostalCode\(/);
    expect(jobBoardSource).toContain("streetAddress: sourcePostalCoherent && isValidAddr(rawStreet) ? rawStreet : ''");

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
    };
    const opts = {
      locale: 'it',
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/chur/',
    };
    const resolved = resolveJobPostingPostalCode(
      { location: job.location, addressLocality: job.addressLocality, postalCode: job.postalCode },
      job.addressLocality,
      job.canton,
    );
    const hydrated = buildJobPostingSchema({
      ...job,
      postalCode: resolved.postalCode,
      streetAddress: resolved.sourcePostalCoherent ? job.streetAddress : '',
    }, opts).jobLocation.address;
    const staticAddress = buildJobPostingSchema(job, opts).jobLocation.address;

    expect(resolved).toEqual({ postalCode: '7000', sourcePostalCoherent: false });
    expect(hydrated).toEqual(staticAddress);
    expect(hydrated).toMatchObject({ addressLocality: 'Chur', addressRegion: 'GR', postalCode: '7000' });
    expect(hydrated.streetAddress).not.toBe(job.streetAddress);
  });
});
