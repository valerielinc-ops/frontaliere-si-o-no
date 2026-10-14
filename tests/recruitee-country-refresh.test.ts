import { describe, expect, it } from 'vitest';
import { SNAPSHOT_VALIDATED_PARTIAL } from '../scripts/lib/crawler-template.mjs';
import {
  attachRecruiteeCountrySnapshot,
  createRecruiteeCountryRefreshHooks,
  hasOnlyExplicitlyForeignRecruiteeLocations,
} from '../scripts/lib/recruitee-country-guard.mjs';

function storedJob(companyKey: string, slug: string) {
  return {
    companyKey,
    url: 'https://careers.example.test/o/' + slug,
  };
}

describe('Recruitee Swiss country refresh', () => {
  it('recognizes explicit foreign countryCode values in provider locations', () => {
    expect(hasOnlyExplicitlyForeignRecruiteeLocations([
      { city: 'London', countryCode: 'GB' },
    ])).toBe(true);
  });

  it('removes exact foreign and ambiguous offer paths while preserving accepted and other-company rows', async () => {
    const sourceJobs = attachRecruiteeCountrySnapshot([
      { companyKey: 'tether', url: 'https://tether.recruitee.com/o/swiss' },
    ], {
      complete: true,
      offerCount: 3,
      acceptedOfferCount: 1,
      rejectedOfferCount: 1,
      unclassifiedOfferCount: 1,
      acceptedDetailUrls: ['https://tether.recruitee.com/o/swiss'],
      rejectedDetailUrls: ['https://tether.recruitee.com/o/foreign'],
      unclassifiedDetailUrls: ['https://tether.recruitee.com/o/unknown'],
    });
    const hooks = createRecruiteeCountryRefreshHooks(async () => sourceJobs, 'tether', SNAPSHOT_VALIDATED_PARTIAL);
    const fetched = await hooks.fetchJobs();
    const existing = [
      storedJob('tether', 'swiss'),
      storedJob('tether', 'foreign'),
      storedJob('tether', 'unknown'),
      storedJob('bitfinex', 'foreign'),
    ];

    expect(hooks.prepareExistingJobs(existing)).toEqual([
      storedJob('tether', 'swiss'),
      storedJob('bitfinex', 'foreign'),
    ]);
    expect(fetched).toBe(sourceJobs);
    expect(JSON.stringify(fetched)).not.toContain('recruiteeCountrySnapshot');
  });

  it('does not clear the stored Swiss slice after an incomplete or wholly ambiguous feed', async () => {
    const sourceJobs = attachRecruiteeCountrySnapshot([], {
      complete: true,
      offerCount: 1,
      acceptedOfferCount: 0,
      rejectedOfferCount: 0,
      unclassifiedOfferCount: 1,
      unclassifiedDetailUrls: ['https://tether.recruitee.com/o/unknown'],
    });
    const hooks = createRecruiteeCountryRefreshHooks(async () => sourceJobs, 'tether', SNAPSHOT_VALIDATED_PARTIAL);
    const fetched = await hooks.fetchJobs();
    const existing = [storedJob('tether', 'unknown'), storedJob('tether', 'swiss')];

    expect(hooks.prepareExistingJobs(existing)).toEqual(existing);
    expect(hooks.validateAuthoritativeSnapshot(fetched)).toBe(SNAPSHOT_VALIDATED_PARTIAL);
  });

  it('accepts an empty Swiss slice only when a successful source enumerated every offer as foreign', async () => {
    const sourceJobs = attachRecruiteeCountrySnapshot([], {
      complete: true,
      offerCount: 2,
      acceptedOfferCount: 0,
      rejectedOfferCount: 2,
      unclassifiedOfferCount: 0,
      rejectedDetailUrls: [
        'https://tether.recruitee.com/o/foreign-one',
        'https://tether.recruitee.com/o/foreign-two',
      ],
    });
    const hooks = createRecruiteeCountryRefreshHooks(async () => sourceJobs, 'tether', SNAPSHOT_VALIDATED_PARTIAL);
    const fetched = await hooks.fetchJobs();

    expect(hooks.validateAuthoritativeSnapshot(fetched)).toBe(true);
    expect(hooks.prepareExistingJobs([
      storedJob('tether', 'foreign-one'),
      storedJob('tether', 'foreign-two'),
    ])).toEqual([]);
  });

  it('preserves existing rows when the provider snapshot is incomplete', async () => {
    const sourceJobs = attachRecruiteeCountrySnapshot([], {
      complete: false,
      offerCount: 0,
    });
    const hooks = createRecruiteeCountryRefreshHooks(async () => sourceJobs, 'tether', SNAPSHOT_VALIDATED_PARTIAL);
    await hooks.fetchJobs();
    const existing = [storedJob('tether', 'foreign')];

    expect(hooks.prepareExistingJobs(existing)).toEqual(existing);
    expect(hooks.validateAuthoritativeSnapshot(sourceJobs)).toBe(SNAPSHOT_VALIDATED_PARTIAL);
  });

  it('does not reuse a previous complete feed snapshot after a later fetch throws', async () => {
    const sourceJobs = attachRecruiteeCountrySnapshot([], {
      complete: true,
      offerCount: 1,
      acceptedOfferCount: 0,
      rejectedOfferCount: 1,
      rejectedDetailUrls: ['https://tether.recruitee.com/o/foreign'],
    });
    let attempts = 0;
    const hooks = createRecruiteeCountryRefreshHooks(async () => {
      attempts += 1;
      if (attempts === 1) return sourceJobs;
      throw new Error('provider unavailable');
    }, 'tether', SNAPSHOT_VALIDATED_PARTIAL);
    const existing = [storedJob('tether', 'foreign')];

    await hooks.fetchJobs();
    await expect(hooks.fetchJobs()).rejects.toThrow('provider unavailable');

    expect(hooks.prepareExistingJobs(existing)).toEqual(existing);
  });
});
