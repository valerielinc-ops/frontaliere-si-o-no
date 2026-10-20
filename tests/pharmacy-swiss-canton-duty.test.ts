import { describe, expect, it } from 'vitest';

import liveRegistry from '../data/pharmacy-sources-registry.json';
import liveSnapshot from '../data/pharmacy-duties-swiss-cantons.json';
import {
  buildSwissCantonDutyCoverage,
  type SwissCantonDutySnapshot,
} from '../services/pharmacies/swissCantonDuty';
import { currentDutyWeekStart } from '../services/pharmacies/dutyWeek';
import type { PharmacySourcesRegistry } from '../services/pharmacies/types';

const NOW = new Date('2026-09-29T08:00:00.000Z');
const WEEK_START = '2026-09-28';
const SOURCE_URL = 'https://example.test/jura-duty.pdf';

function registry(status: 'active' | 'unverified' = 'active'): PharmacySourcesRegistry {
  return {
    generatedAt: '2026-09-29T00:00:00.000Z',
    sources: {
      jura: {
        canton: 'Giura',
        officialSourceUrl: SOURCE_URL,
        accessMethod: 'pdf',
        fetchFrequency: 'P1D',
        timezone: 'Europe/Zurich',
        sourceType: 'official',
        owner: 'test',
        status,
      },
    },
  } as PharmacySourcesRegistry;
}

function snapshot(overrides: Partial<SwissCantonDutySnapshot> = {}): SwissCantonDutySnapshot {
  const fetchedAt = '2026-09-29T07:00:00.000Z';
  const scope = { country: 'CH' as const, canton: 'JU', coverageType: 'canton' as const };
  const coverage = {
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    observedCalendarDays: 365,
    uncoveredCalendarDays: 0,
    coverage: 'covered' as const,
  };
  const duties = [{
    id: 'ju-test-current',
    pharmacyId: 'ju-test-pharmacy',
    pharmacyName: 'Farmacia test',
    coverageType: 'canton' as const,
    coverageName: 'Giura',
    startsAt: '2026-09-26T06:00:00.000Z',
    endsAt: '2026-10-03T06:00:00.000Z',
    dutyType: 'weekend' as const,
    status: 'verified' as const,
    sourceUrl: SOURCE_URL,
    sourceType: 'official' as const,
    fetchedAt,
    verifiedAt: fetchedAt,
  }];
  return {
    _schemaVersion: 1,
    _source: SOURCE_URL,
    _sourceKey: 'jura',
    _fetchedAt: fetchedAt,
    _attemptedAt: fetchedAt,
    _timezone: 'Europe/Zurich',
    _scope: scope,
    _coverage: coverage,
    _releaseReady: true,
    _state: 'fresh',
    _release: {
      version: 1,
      releaseId: 'test-release',
      evaluatedAt: fetchedAt,
      state: 'fresh',
      source: { key: 'jura', url: SOURCE_URL },
      scope,
      coverage,
    },
    _errors: [],
    _warnings: [],
    _unresolvedIdentities: [],
    coverageName: 'Giura',
    pharmacies: [{
      id: 'ju-test-pharmacy',
      name: 'Farmacia test',
      city: 'Delémont',
      cantonCode: 'JU',
      country: 'CH',
      sourceUrl: SOURCE_URL,
      sourceType: 'official',
      lastVerifiedAt: fetchedAt,
    }],
    duties,
    ...overrides,
  };
}

describe('Swiss canton duty coverage', () => {
  it('keeps an expired source interval non-operational even in a fresh complete release', () => {
    const weekStart = currentDutyWeekStart(new Date());
    const now = new Date(Date.parse(`${weekStart}T12:00:00.000Z`) + 3 * 86400000);
    const relative = (hours: number) => new Date(now.getTime() + hours * 3600000).toISOString();
    const base = snapshot();
    const fetchedAt = relative(-0.5);
    const coverage = { ...base._coverage, validFrom: weekStart, validTo: relative(72).slice(0, 10), observedCalendarDays: 7 };
    const makeSnapshot = (status: 'verified' | 'expired'): SwissCantonDutySnapshot => ({
      ...base, _fetchedAt: fetchedAt, _attemptedAt: fetchedAt, _coverage: coverage,
      _release: { ...base._release, evaluatedAt: fetchedAt, coverage },
      duties: base.duties.map(duty => ({ ...duty, startsAt: relative(-3), endsAt: relative(status === 'verified' ? 1 : -1), fetchedAt, verifiedAt: fetchedAt, status })),
    });
    for (const status of ['verified', 'expired'] as const) {
      const result = buildSwissCantonDutyCoverage({ now, weekStart, registry: registry(), includeGeneva: false, snapshots: { JU: makeSnapshot(status) } });
      expect(result.diagnostics).toEqual(status === 'expired' ? ['JU: no verified duty intersects the selected week'] : []);
      expect(result.operationalCantons.map(canton => canton.code)).toEqual(status === 'verified' ? ['JU'] : []);
    }
  });

  it('publishes a complete fresh canton snapshot for the selected week', () => {
    const result = buildSwissCantonDutyCoverage({
      now: NOW,
      weekStart: WEEK_START,
      registry: registry(),
      snapshots: { JU: snapshot() },
      includeGeneva: false,
    });

    expect(result.operationalCantons).toHaveLength(1);
    expect(result.operationalCantons[0]).toMatchObject({
      code: 'JU',
      coverageType: 'canton',
      coverageName: 'Giura',
      duties: [{ pharmacyName: 'Farmacia test' }],
    });
  });

  it('keeps a canton source-only when the registry or snapshot is not publishable', () => {
    const result = buildSwissCantonDutyCoverage({
      now: NOW,
      weekStart: WEEK_START,
      registry: registry('unverified'),
      snapshots: { JU: snapshot() },
      includeGeneva: false,
    });

    expect(result.operationalCantons).toHaveLength(0);
    expect(result.diagnostics).toContain('JU: registry source is not active');
  });

  it('does not publish a stale snapshot even if its rows still cover the week', () => {
    const stale = snapshot({ _fetchedAt: '2026-09-26T07:00:00.000Z' });
    const result = buildSwissCantonDutyCoverage({
      now: NOW,
      weekStart: WEEK_START,
      registry: registry(),
      snapshots: { JU: stale },
      includeGeneva: false,
    });

    expect(result.operationalCantons).toHaveLength(0);
    expect(result.diagnostics[0]).toContain('JU: snapshot freshness is stale');
  });

  it('accepts the checked-in Jura release at its own fetch timestamp', () => {
    const fetchedAt = liveSnapshot.generatedAt;
    const result = buildSwissCantonDutyCoverage({
      now: new Date(fetchedAt),
      weekStart: currentDutyWeekStart(new Date(fetchedAt)),
      registry: liveRegistry as unknown as PharmacySourcesRegistry,
      snapshots: liveSnapshot.snapshots,
      includeGeneva: false,
    });

    // The checked-in release can move a canton into the following calendar
    // window between refreshes; keep this assertion focused on the Jura
    // release covered by the test instead of pinning another canton's dates.
    expect(result.operationalCantons.map((canton) => canton.code)).toContain('JU');
    expect(result.operationalCantons.every((canton) => canton.duties.length > 0)).toBe(true);
  });
});
