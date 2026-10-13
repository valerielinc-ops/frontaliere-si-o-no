import { describe, expect, it } from 'vitest';
import {
  buildObservedHttpsApplyUrlHousekeepingProof,
  isHttpsUrl,
  partitionByHttpsApplyUrl,
} from '../scripts/lib/https-url.mjs';

describe('HTTPS apply handoff contract', () => {
  it('requires an absolute HTTPS URL with a host', () => {
    expect(isHttpsUrl('https://jobs.example.ch/apply/123')).toBe(true);
    expect(isHttpsUrl('http://jobs.example.ch/apply/123')).toBe(false);
    expect(isHttpsUrl('mailto:recruiting@example.ch')).toBe(false);
    expect(isHttpsUrl('/apply/123')).toBe(false);
  });

  it('partitions unpublished mailto or missing handoffs from verified HTTPS rows', () => {
    const jobs = [
      { slug: 'bellinzona', applyUrl: null },
      { slug: 'la-fonte', applyUrl: 'mailto:recruiting@lafonte.ch' },
      { slug: 'oscam', applyUrl: 'mailto:info@oscam.ch' },
      { slug: 'verified', applyUrl: 'https://jobs.example.ch/apply/123' },
    ];

    expect(partitionByHttpsApplyUrl(jobs)).toEqual({
      publishable: [jobs[3]],
      quarantined: jobs.slice(0, 3),
    });
  });

  it('proves quarantine only for previously published rows re-observed without HTTPS', () => {
    const priorJobs = [
      { slug: 'observed', url: 'https://source.example.ch/job/1', applyUrl: 'mailto:apply@example.ch' },
      { slug: 'stale', url: 'https://source.example.ch/job/2', applyUrl: 'mailto:apply@example.ch' },
      { slug: 'still-valid', url: 'https://source.example.ch/job/3', applyUrl: 'https://apply.example.ch/3' },
    ];
    const proof = buildObservedHttpsApplyUrlHousekeepingProof({
      priorJobs,
      observedJobs: [
        { slug: 'observed', applyUrl: 'mailto:apply@example.ch' },
        { slug: 'still-valid', applyUrl: 'https://apply.example.ch/3' },
      ],
      keyFor: (job) => job.slug,
    });

    expect(proof).toEqual([{
      job: priorJobs[0],
      reason: 'official source has no verified HTTPS application destination',
      definitive: true,
    }]);
  });
});
