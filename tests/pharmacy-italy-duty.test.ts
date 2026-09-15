// @vitest-environment node
import { describe, expect, it } from 'vitest';
import dutiesJson from '../data/pharmacy-duties-italy.json';
import statusJson from '../data/pharmacy-duties-italy-status.json';
import {
  buildAtomicItalyDutySnapshots,
  ITALY_DUTY_RELEASE_MAX_AGE_MS,
} from '../services/pharmacies/italyRelease';
import {
  buildItalyDutyWeekModel,
  formatItalyDutyDateTime,
} from '../services/pharmacies/italyDuty';
import type { ItalyDutySnapshot } from '../services/pharmacies/italyRelease';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const WEEK = '2026-09-14';
const FETCHED_AT = '2026-09-15T11:30:00.000Z';

const PROVINCES = [
  { code: 'CO', pharmacyId: 'it-msal-2166', sourceUrl: 'https://www.comune.merone.co.it/novita/comunicati_stampa/novita_138.html', hour: '08:00' },
  { code: 'VA', pharmacyId: 'it-msal-3930', sourceUrl: 'https://comune.marchirolo.varese.it/Dettaglionews?IDNews=400586', hour: '09:00' },
  { code: 'VB', pharmacyId: 'it-msal-17425', sourceUrl: 'https://www.aslvco.it/wp-content/uploads/2025/12/2968938.pdf?x88295=', hour: '10:00' },
] as const;

function freshSnapshots(fetchedAt = FETCHED_AT): { duties: ItalyDutySnapshot; status: ItalyDutySnapshot } {
  const rows = PROVINCES.map(({ code, pharmacyId, sourceUrl, hour }) => ({
    id: `italy-test-${code.toLowerCase()}`,
    pharmacyId,
    province: code,
    coverageType: 'province',
    coverageName: `${code} provincial duty calendar`,
    startsAt: `2026-09-14T${hour}:00+02:00`,
    endsAt: `2026-09-14T${hour === '08:00' ? '16:00' : hour === '09:00' ? '17:00' : '18:00'}:00+02:00`,
    dutyType: 'day',
    status: 'verified',
    sourceUrl,
    sourceType: 'official',
    fetchedAt,
    verifiedAt: fetchedAt,
  }));
  const provinces = Object.fromEntries(PROVINCES.map(({ code, sourceUrl }) => [code, {
    province: code,
    sourceKey: `test-${code.toLowerCase()}`,
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
  it('fails closed for the checked-in not_published release without duties, sources or operational timestamps', () => {
    const model = buildItalyDutyWeekModel({ now: NOW, weekStart: WEEK });

    expect(model.state).toBe('not_published');
    expect(model.publishable).toBe(false);
    expect(model.indexable).toBe(false);
    expect(model.provinces).toHaveLength(3);
    expect(model.provinces.every((province) => province.duties.length === 0)).toBe(true);
    expect(model.provinces.every((province) => province.sourceUrl === null)).toBe(true);
  });

  it('publishes only a fresh complete release with one verified province row per province', () => {
    const snapshots = freshSnapshots();
    const model = buildItalyDutyWeekModel({
      now: NOW,
      weekStart: WEEK,
      duties: snapshots.duties,
      status: snapshots.status,
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

  it('expires the Italy release after the 72-hour Europe/Rome freshness window', () => {
    const staleAt = new Date(NOW.getTime() - ITALY_DUTY_RELEASE_MAX_AGE_MS - 1_000).toISOString();
    const snapshots = freshSnapshots(staleAt);
    const model = buildItalyDutyWeekModel({ now: NOW, weekStart: WEEK, duties: snapshots.duties, status: snapshots.status });

    expect(model.state).toBe('stale');
    expect(model.publishable).toBe(false);
    expect(model.indexable).toBe(false);
    expect(model.provinces.every((province) => province.duties.length === 0)).toBe(true);
  });
});
