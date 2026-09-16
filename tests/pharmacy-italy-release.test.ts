import { describe, expect, it } from 'vitest';
import duties from '../data/pharmacy-duties-italy.json';
import status from '../data/pharmacy-duties-italy-status.json';
import sources from '../data/pharmacy-duties-italy-sources.json';
import catalogue from '../data/pharmacies-italy-border.json';
import { checkItalyDutyData } from '../scripts/check-pharmacy-duties-italy.mjs';
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
    expect(duties._release.state).toBe('not_published');
    expect(isItalyDutyReleasePublishable({ duties, status })).toBe(false);
    expect(status._provinces.CO).toMatchObject({ dutyCount: 0, observedDutyCount: 4, coverage: 'partial', state: 'partial' });
  });

  it('derives a deterministic releaseId from both payloads', () => {
    const first = buildItalyDutyRelease({ duties, status, evaluatedAt: duties._fetchedAt });
    const second = buildItalyDutyRelease({
      duties: { ...duties, _warnings: ['payload changed'] },
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

    const tamperedStatusRelease = {
      ...status,
      _release: {
        ...status._release,
        snapshots: {
          ...status._release.snapshots,
          status: { ...status._release.snapshots.status, sha256: '0'.repeat(64) },
        },
      },
    };
    expect(verifyItalyDutyRelease({ duties, status: tamperedStatusRelease })).toEqual(expect.arrayContaining([
      'status payload hash mismatch',
      'status release metadata does not match the payload contract',
    ]));

    const tamperedStatusState = {
      ...status,
      _release: { ...status._release, state: 'fresh' },
    };
    expect(verifyItalyDutyRelease({ duties, status: tamperedStatusState })).toContain('status release metadata does not match the payload contract');

    const completeStatus = {
      ...status,
      _allSourcesFailed: false,
      _errors: [],
      _provinces: Object.fromEntries(Object.entries(status._provinces).map(([province, entry]) => [
        province,
        { ...entry, state: 'fresh', freshness: 'fresh', coverage: 'covered' },
      ])),
    };
    const staleStatus = {
      ...completeStatus,
      _provinces: {
        ...completeStatus._provinces,
        VB: { ...completeStatus._provinces.VB, freshness: 'stale', state: 'stale' },
      },
    };
    const stale = buildAtomicItalyDutySnapshots({ duties: { ...duties, _errors: [] }, status: staleStatus, evaluatedAt: NOW });
    expect(stale.release.state).toBe('stale');
    expect(isItalyDutyReleasePublishable(stale)).toBe(false);

    const missingProvince = {
      ...status,
      _provinces: { CO: status._provinces.CO, VA: status._provinces.VA },
    };
    expect(buildItalyDutyRelease({ duties, status: missingProvince, evaluatedAt: NOW }).state).toBe('not_published');
  });

  it('checks official source identity, catalogue provenance, and release integrity together', () => {
    expect(checkItalyDutyData({ duties, status, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') })).toEqual(expect.arrayContaining([
      expect.stringContaining('source is not fresh and covered'),
      expect.stringContaining('release: state is not_published'),
    ]));

    const tampered = {
      ...duties,
      duties: [{ ...duties.duties[0], pharmacyId: 'it-msal-not-in-catalogue' }, ...duties.duties.slice(1)],
    };
    expect(checkItalyDutyData({ duties: tampered, status, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') })).toEqual(expect.arrayContaining([
      expect.stringContaining('pharmacyId is missing or ambiguous'),
      expect.stringContaining('payload hash mismatch'),
    ]));

    const statusStateTampered = {
      ...status,
      _release: { ...status._release, state: 'fresh' },
    };
    expect(checkItalyDutyData({ duties, status: statusStateTampered, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') }))
      .toContain('release metadata differs between duties and status');

    const aliasMismatchSources = {
      ...sources,
      sources: sources.sources.map((source: { province: string; identityAliases: Array<Record<string, string>> }) => source.province === 'CO'
        ? {
          ...source,
          identityAliases: [
            { ...source.identityAliases[0], pharmacyId: 'it-msal-3924' },
            ...source.identityAliases.slice(1),
          ],
        }
        : source),
    };
    expect(checkItalyDutyData({ duties, status, sources: aliasMismatchSources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') }))
      .toContain('source como-ats-2026-2027: alias it-msal-3924 province does not match CO');

    const httpRawSources = {
      ...sources,
      sources: sources.sources.map((source: { province: string }) => source.province === 'CO'
        ? { ...source, rawUrl: 'http://www.comune.merone.co.it/EG0/EGDOCVISJS.HBL' }
        : source),
    };
    expect(checkItalyDutyData({ duties, status, sources: httpRawSources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') }))
      .toContain('source como-ats-2026-2027: rawUrl must be official HTTPS');
    const statusCountMismatch = {
      ...status,
      _provinces: {
        ...status._provinces,
        CO: { ...status._provinces.CO, dutyCount: 1 },
      },
    };
    expect(checkItalyDutyData({ duties, status: statusCountMismatch, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') }))
      .toContain('status.CO: dutyCount 1 does not match duties rows 0');
  });

  it('pins VCO to the official ASL calendar and its declared 2026 validity window', () => {
    const vco = sources.sources.find((source: { province: string }) => source.province === 'VB');
    expect(vco).toMatchObject({
      officialSourceUrl: 'https://www.aslvco.it/wp-content/uploads/2025/12/2968938.pdf?x88295=',
      rawUrl: 'https://www.aslvco.it/wp-content/uploads/2025/12/2968938.pdf?x88295=',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      minimumCalendarDays: 300,
    });
    const errors = checkItalyDutyData({ duties, status, sources, catalogue, now: new Date('2026-09-15T12:00:00.000Z') });
    expect(errors.filter((error) => /^(source|thirdPartyLinkOut)/.test(error))).toEqual([]);
  });
});
