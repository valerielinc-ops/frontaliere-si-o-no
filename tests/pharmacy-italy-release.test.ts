import { describe, expect, it } from 'vitest';
import duties from '../data/pharmacy-duties-italy.json';
import status from '../data/pharmacy-duties-italy-status.json';
import {
  buildAtomicItalyDutySnapshots,
  buildItalyDutyRelease,
  isItalyDutyReleasePublishable,
  validateItalyDutyRelease,
  verifyItalyDutyRelease,
} from '../services/pharmacies/italyRelease';

const NOW = '2026-09-15T12:00:00.000Z';

describe('Italian duty release contract', () => {
  it('keeps one releaseId and Europe/Rome across the checked-in snapshots', () => {
    expect(duties._release.releaseId).toBe(status._release.releaseId);
    expect(duties._release.timezone).toBe('Europe/Rome');
    expect(duties._release.scope).toEqual({ country: 'IT', provinces: ['CO', 'VA', 'VB'] });
    expect(validateItalyDutyRelease(duties._release)).toEqual([]);
    expect(validateItalyDutyRelease(status._release)).toEqual([]);
    expect(verifyItalyDutyRelease({ duties, status })).toEqual([]);
    expect(isItalyDutyReleasePublishable({ duties, status })).toBe(true);
  });

  it('derives a deterministic releaseId from both payloads', () => {
    const first = buildItalyDutyRelease({ duties, status, evaluatedAt: duties._fetchedAt });
    const second = buildItalyDutyRelease({
      duties: { ...duties, duties: [...duties.duties].reverse() },
      status,
      evaluatedAt: duties._fetchedAt,
    });
    expect(first.releaseId).toBe(duties._release.releaseId);
    expect(second.releaseId).not.toBe(first.releaseId);
  });

  it('blocks tampering, stale sources, and incomplete province coverage', () => {
    const tampered = { ...duties, duties: [{ ...duties.duties[0], province: undefined }] };
    expect(verifyItalyDutyRelease({ duties: tampered, status })).toEqual(expect.arrayContaining([
      'duties payload hash mismatch',
      'releaseId does not match the release contract',
    ]));

    const staleStatus = {
      ...status,
      _provinces: {
        ...status._provinces,
        VB: { ...status._provinces.VB, freshness: 'stale', state: 'stale' },
      },
    };
    const stale = buildAtomicItalyDutySnapshots({ duties, status: staleStatus, evaluatedAt: NOW });
    expect(stale.release.state).toBe('stale');
    expect(isItalyDutyReleasePublishable(stale)).toBe(false);

    const missingProvince = {
      ...status,
      _provinces: { CO: status._provinces.CO, VA: status._provinces.VA },
    };
    expect(buildItalyDutyRelease({ duties, status: missingProvince, evaluatedAt: NOW }).state).toBe('not_published');
  });
});
