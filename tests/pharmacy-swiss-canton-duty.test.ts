import { describe, expect, it } from 'vitest';

import liveRegistry from '../data/pharmacy-sources-registry.json';
import liveSnapshot from '../data/pharmacy-duties-swiss-cantons.json';
import {
  buildSwissCantonDutyCoverage,
  type SwissCantonDutySnapshot,
} from '../services/pharmacies/swissCantonDuty';
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
      weekStart: WEEK_START,
      registry: liveRegistry as unknown as PharmacySourcesRegistry,
      snapshots: liveSnapshot.snapshots,
      includeGeneva: false,
    });

    expect(result.operationalCantons.map((canton) => canton.code)).toEqual(['BS', 'JU', 'ZH']);
    expect(result.operationalCantons.every((canton) => canton.duties.length > 0)).toBe(true);
  });
});
