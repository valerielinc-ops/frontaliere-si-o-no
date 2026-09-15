// @vitest-environment node
import { describe, expect, it } from 'vitest';
import dutiesJson from '../data/pharmacy-duties-italy.json';
import sourcesJson from '../data/pharmacy-duties-italy-sources.json';
import statusJson from '../data/pharmacy-duties-italy-status.json';
import sourcesJson from '../data/pharmacy-duties-italy-sources.json';
import {
  buildAtomicItalyDutySnapshots,
  ITALY_DUTY_RELEASE_MAX_AGE_MS,
  evaluateItalyDutyRelease,
  isItalyDutyReleasePublishable,
} from '../services/pharmacies/italyRelease';
import {
  buildItalyDutyWeekModel,
  formatItalyDutyDateTime,
} from '../services/pharmacies/italyDuty';
import type { ItalyDutySnapshot } from '../services/pharmacies/italyRelease';
import type { ItalyDutySourceRegistry } from '../services/pharmacies/italyDuty';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const WEEK = '2026-09-14';
const FETCHED_AT = '2026-09-15T11:30:00.000Z';

const PROVINCES = [
  { code: 'CO', pharmacyId: 'it-msal-2166', sourceKey: 'como-ats-2026-2027', coverageName: 'Como', sourceUrl: 'https://www.comune.merone.co.it/novita/comunicati_stampa/novita_138.html', hour: '08:00' },
  { code: 'VA', pharmacyId: 'it-msal-3930', sourceKey: 'varese-ats-2026-2027', coverageName: 'Varese', sourceUrl: 'https://comune.marchirolo.varese.it/Dettaglionews?IDNews=400586', hour: '09:00' },
  { code: 'VB', pharmacyId: 'it-msal-17425', sourceKey: 'vco-asl-2026', coverageName: 'Verbano-Cusio-Ossola', sourceUrl: 'https://www.aslvco.it/wp-content/uploads/2025/12/2968938.pdf?x88295=', hour: '10:00' },
] as const;

function freshSnapshots(fetchedAt = FETCHED_AT): { duties: ItalyDutySnapshot; status: ItalyDutySnapshot } {
  const rows = PROVINCES.map(({ code, pharmacyId, coverageName, sourceUrl, hour }) => ({
    id: `italy-test-${code.toLowerCase()}`,
    pharmacyId,
    province: code,
    coverageType: 'province',
    coverageName,
    startsAt: `2026-09-14T${hour}:00+02:00`,
    endsAt: `2026-09-14T${hour === '08:00' ? '16:00' : hour === '09:00' ? '17:00' : '18:00'}:00+02:00`,
    dutyType: 'day',
    status: 'verified',
    sourceUrl,
    sourceType: 'official',
    fetchedAt,
    verifiedAt: fetchedAt,
  }));
  const provinces = Object.fromEntries(PROVINCES.map(({ code, sourceKey, sourceUrl }) => [code, {
    province: code,
    sourceKey,
    sourceUrl,
    fetchedAt,
    dutyCount: 1,
    observedDutyCount: 1,
    freshness: 'fresh',
    coverage: 'covered',
    state: 'fresh',
    errors: [],
    warnings: [],
  }]));
  const duties: ItalyDutySnapshot = {
    ...dutiesJson,
    _fetchedAt: fetchedAt,
    _errors: [],
    _warnings: [],
    duties: rows,
  };
  const status: ItalyDutySnapshot = {
    ...statusJson,
    _fetchedAt: fetchedAt,
    _attemptedAt: fetchedAt,
    _lastSuccessfulFetchAt: fetchedAt,
    _allSourcesFailed: false,
    _errors: [],
    _provinces: provinces,
  };
  const atomic = buildAtomicItalyDutySnapshots({ duties, status, evaluatedAt: fetchedAt });
  return { duties: atomic.duties, status: atomic.status };
}

describe('Italian duty week read model', () => {
  it('keeps the checked-in not_published release source-only without operational rows or timestamps', () => {
    const model = buildItalyDutyWeekModel({ now: NOW, weekStart: WEEK });

    expect(model.state).toBe('not_published');
    expect(model.publishable).toBe(false);
    expect(model.indexable).toBe(false);
    expect(model.provinces).toHaveLength(3);
    expect(model.provinces.every((province) => province.duties.length === 0)).toBe(true);
    expect(model.provinces.map((province) => province.sourceUrl)).toEqual(PROVINCES.map((province) => province.sourceUrl));
    expect(model.sourceOnly.map((province) => province.sourceUrl)).toEqual(PROVINCES.map((province) => province.sourceUrl));
    expect(model.sourceOnly.every((province) => !('dutyCount' in province))).toBe(true);
  });

  it('publishes only a fresh complete release with one verified province row per province', () => {
    const snapshots = freshSnapshots();
    const model = buildItalyDutyWeekModel({
      now: NOW,
      weekStart: WEEK,
      duties: snapshots.duties,
      status: snapshots.status,
      sources: sourcesJson as unknown as ItalyDutySourceRegistry,
    });

    expect(model.state).toBe('fresh');
    expect(model.publishable).toBe(true);
    expect(model.indexable).toBe(true);
    expect(model.provinces.map((province) => province.code)).toEqual(['CO', 'VA', 'VB']);
    expect(model.provinces.filter((province) => province.duties.length > 0)).toHaveLength(3);
    expect(model.provinces.flatMap((province) => province.duties)).toHaveLength(3);
    expect(model.provinces.every((province) => province.sourceUrl?.startsWith('https://'))).toBe(true);
    expect(formatItalyDutyDateTime(model.provinces[0].duties[0].startsAt)).toBe('14.09.2026 08:00');
  });

  it('fails closed when a duty row crosses a catalogue province or official source boundary', () => {
    const snapshots = freshSnapshots();
    const rows = snapshots.duties.duties as Array<Record<string, unknown>>;
    const identityTampered = buildAtomicItalyDutySnapshots({
      duties: { ...snapshots.duties, duties: [{ ...rows[0], pharmacyId: 'it-msal-3930' }, ...rows.slice(1)] },
      status: snapshots.status,
      evaluatedAt: FETCHED_AT,
    });
    const identityEvaluation = evaluateItalyDutyRelease({
      duties: identityTampered.duties,
      status: identityTampered.status,
      now: NOW,
    });
    expect(identityEvaluation.publishable).toBe(false);
    expect(identityEvaluation.reasons).toContain('Italy duties snapshot contains invalid entries');
    expect(isItalyDutyReleasePublishable(identityTampered)).toBe(false);

    const sourceTamperingCases = [
      { coverageName: 'Varese' },
      { sourceUrl: PROVINCES[1].sourceUrl },
      { sourceType: 'association' },
    ];
    for (const changes of sourceTamperingCases) {
      const sourceTampered = buildAtomicItalyDutySnapshots({
        duties: { ...snapshots.duties, duties: [{ ...rows[0], ...changes }, ...rows.slice(1)] },
        status: snapshots.status,
        evaluatedAt: FETCHED_AT,
      });
      const sourceEvaluation = evaluateItalyDutyRelease({
        duties: sourceTampered.duties,
        status: sourceTampered.status,
        now: NOW,
      });
      expect(sourceEvaluation.publishable).toBe(false);
      expect(sourceEvaluation.reasons).toContain('Italy duties snapshot contains invalid entries');
    }

    const invalidProvince = buildAtomicItalyDutySnapshots({
      duties: { ...snapshots.duties, duties: [{ ...rows[0], province: 42 }, ...rows.slice(1)] },
      status: snapshots.status,
      evaluatedAt: FETCHED_AT,
    });
    expect(() => evaluateItalyDutyRelease({
      duties: invalidProvince.duties,
      status: invalidProvince.status,
      now: NOW,
    })).not.toThrow();
    expect(evaluateItalyDutyRelease({ duties: invalidProvince.duties, status: invalidProvince.status, now: NOW }).publishable).toBe(false);
  });

  it('fails closed when a province status carries source errors or malformed diagnostics', () => {
    const snapshots = freshSnapshots();
    const provinces = snapshots.status._provinces as Record<string, Record<string, unknown>>;
    const withProvinceError = buildAtomicItalyDutySnapshots({
      duties: snapshots.duties,
      status: {
        ...snapshots.status,
        _provinces: { ...provinces, CO: { ...provinces.CO, errors: ['calendar parse failed'] } },
      },
      evaluatedAt: FETCHED_AT,
    });
    const errorEvaluation = evaluateItalyDutyRelease({
      duties: withProvinceError.duties,
      status: withProvinceError.status,
      now: NOW,
    });
    expect(errorEvaluation.publishable).toBe(false);
    expect(errorEvaluation.reasons).toContain('Italy status snapshot contains invalid province entries');

    const malformed = buildAtomicItalyDutySnapshots({
      duties: snapshots.duties,
      status: {
        ...snapshots.status,
        _provinces: { ...provinces, VA: { ...provinces.VA, errors: 'not-an-array' } },
      },
      evaluatedAt: FETCHED_AT,
    });
    const malformedEvaluation = evaluateItalyDutyRelease({
      duties: malformed.duties,
      status: malformed.status,
      now: NOW,
    });
    expect(malformedEvaluation.publishable).toBe(false);
    expect(malformedEvaluation.reasons).toContain('Italy status snapshot contains invalid province entries');

    const sourceIdentityTampered = buildAtomicItalyDutySnapshots({
      duties: snapshots.duties,
      status: {
        ...snapshots.status,
        _provinces: { ...provinces, CO: { ...provinces.CO, sourceKey: PROVINCES[1].sourceKey } },
      },
      evaluatedAt: FETCHED_AT,
    });
    const sourceIdentityEvaluation = evaluateItalyDutyRelease({
      duties: sourceIdentityTampered.duties,
      status: sourceIdentityTampered.status,
      now: NOW,
    });
    expect(sourceIdentityEvaluation.publishable).toBe(false);
    expect(sourceIdentityEvaluation.reasons).toContain('Italy status snapshot contains invalid province entries');

    const malformedWarnings = buildAtomicItalyDutySnapshots({
      duties: snapshots.duties,
      status: {
        ...snapshots.status,
        _provinces: { ...provinces, VB: { ...provinces.VB, warnings: [42] } },
      },
      evaluatedAt: FETCHED_AT,
    });
    const warningsEvaluation = evaluateItalyDutyRelease({
      duties: malformedWarnings.duties,
      status: malformedWarnings.status,
      now: NOW,
    });
    expect(warningsEvaluation.publishable).toBe(false);
    expect(warningsEvaluation.reasons).toContain('Italy status snapshot contains invalid province entries');
  });

  it('fails closed when the Italy source registry envelope is malformed', () => {
    const snapshots = freshSnapshots();
    const malformedRegistries = [
      { ...sourcesJson, version: 2 },
      { ...sourcesJson, timezone: 'Europe/Zurich' },
      { ...sourcesJson, scope: { ...sourcesJson.scope, country: 'CH' } },
      { ...sourcesJson, sources: sourcesJson.sources.slice(1) },
    ];
    for (const sources of malformedRegistries) {
      const evaluation = evaluateItalyDutyRelease({
        duties: snapshots.duties,
        status: snapshots.status,
        now: NOW,
        sources,
      });
      expect(evaluation.publishable).toBe(false);
      expect(evaluation.reasons).toContain('Italy duty source registry is invalid');
    }
  });

  it('fails closed when global diagnostics or the all-sources flag are malformed', () => {
    const snapshots = freshSnapshots();
    const malformedErrors = buildAtomicItalyDutySnapshots({
      duties: { ...snapshots.duties, _errors: 'not-an-array' },
      status: snapshots.status,
      evaluatedAt: FETCHED_AT,
    });
    const errorEvaluation = evaluateItalyDutyRelease({
      duties: malformedErrors.duties,
      status: malformedErrors.status,
      now: NOW,
    });
    expect(errorEvaluation.publishable).toBe(false);
    expect(errorEvaluation.reasons).toContain('Italy snapshot diagnostics are malformed');

    const malformedFlag = buildAtomicItalyDutySnapshots({
      duties: snapshots.duties,
      status: { ...snapshots.status, _allSourcesFailed: 'false' },
      evaluatedAt: FETCHED_AT,
    });
    const flagEvaluation = evaluateItalyDutyRelease({
      duties: malformedFlag.duties,
      status: malformedFlag.status,
      now: NOW,
    });
    expect(flagEvaluation.publishable).toBe(false);
    expect(flagEvaluation.reasons).toContain('Italy snapshot diagnostics are malformed');
  });

  it('expires the Italy release after the 72-hour Europe/Rome freshness window', () => {
    const staleAt = new Date(NOW.getTime() - ITALY_DUTY_RELEASE_MAX_AGE_MS - 1_000).toISOString();
    const snapshots = freshSnapshots(staleAt);
    const model = buildItalyDutyWeekModel({ now: NOW, weekStart: WEEK, duties: snapshots.duties, status: snapshots.status });

    expect(model.state).toBe('stale');
    expect(model.publishable).toBe(false);
    expect(model.indexable).toBe(false);
    expect(model.provinces.every((province) => province.duties.length === 0)).toBe(true);
  });

  it('uses registry sources for source-only links and never trusts a tampered status URL', () => {
    const currentProvinces = statusJson._provinces as Record<string, Record<string, unknown>>;
    const tamperedStatus = {
      ...statusJson,
      _provinces: {
        ...currentProvinces,
        CO: { ...currentProvinces.CO, sourceUrl: 'https://attacker.example/duty.pdf' },
      },
    } as unknown as ItalyDutySnapshot;
    const model = buildItalyDutyWeekModel({ now: NOW, weekStart: WEEK, status: tamperedStatus });

    expect(model.publishable).toBe(false);
    expect(model.provinces.find((province) => province.code === 'CO')?.sourceUrl)
      .toBe(PROVINCES[0].sourceUrl);
    expect(model.sourceOnly.find((province) => province.code === 'CO')?.sourceUrl)
      .toBe(PROVINCES[0].sourceUrl);
    expect(model.reason).toContain('integrity verification failed');
  });

  it('removes an ambiguous province from source-only link-out', () => {
    const sources = sourcesJson as unknown as ItalyDutySourceRegistry;
    const duplicateSources = {
      ...sources,
      sources: [...(sources.sources as unknown[]), (sources.sources as unknown[])[0]],
    };
    const model = buildItalyDutyWeekModel({ now: NOW, weekStart: WEEK, sources: duplicateSources });

    expect(model.publishable).toBe(false);
    expect(model.sourceOnly.find((province) => province.code === 'CO')).toMatchObject({
      sourceKey: null,
      sourceUrl: null,
    });
    expect(model.sourceOnly.find((province) => province.code === 'VA')?.sourceUrl)
      .toBe(PROVINCES[1].sourceUrl);
    expect(model.reason).toContain('CO: Italy source registry province is ambiguous');
  });
});
