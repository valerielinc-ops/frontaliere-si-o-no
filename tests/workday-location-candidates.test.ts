import { describe, expect, it } from 'vitest';
import { getWorkdayLocationCandidates } from '../scripts/lib/ats-clients/workday-client.mjs';

describe('getWorkdayLocationCandidates', () => {
  it('enumerates detail, additional, requisition, and listing sources in order', () => {
    expect(getWorkdayLocationCandidates({
      location: { descriptor: 'Zürich', country: { alpha2Code: 'CH', code: 'CH-ZH' } },
      additionalLocations: [{ descriptor: 'Remote, Switzerland' }],
      jobRequisitionLocation: { city: 'Winterthur', country: { name: 'Switzerland' } },
    }, '2 Locations')).toEqual([
      'Zürich, CH, CH-ZH',
      'Remote, Switzerland',
      'Winterthur, Switzerland',
      '2 Locations',
    ]);
  });

  it('keeps country.alpha2Code and country.code in the flattened candidate text', () => {
    const [candidate] = getWorkdayLocationCandidates({
      location: { descriptor: 'Zurich', country: { alpha2Code: 'CH', code: 'CH-ZH' } },
    });

    expect(candidate).toContain('CH');
    expect(candidate).toContain('CH-ZH');
  });
});
