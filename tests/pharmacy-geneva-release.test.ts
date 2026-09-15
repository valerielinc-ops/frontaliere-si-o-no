// @vitest-environment node
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import dutiesSnapshot from '../data/pharmacy-duties-geneva.json';
import sourceConfig from '../data/pharmacy-duties-geneva-sources.json';
import statusSnapshot from '../data/pharmacy-duties-geneva-status.json';
import {
  buildAtomicGenevaDutySnapshots,
  evaluateGenevaDutyRelease,
  validateGenevaDutyRelease,
  validateGenevaDutySourceRegistry,
  verifyGenevaDutyRelease,
} from '../services/pharmacies/genevaRelease';
import type { GenevaDutySnapshot } from '../services/pharmacies/genevaRelease';
import { importGenevaPharmacyDuties } from '../scripts/import-pharmacy-duties-geneva.mjs';

const FETCHED_AT = '2026-09-15T12:00:00.000Z';
const NOW = new Date(FETCHED_AT);
const SOURCES = sourceConfig as unknown as Record<string, unknown>;
const CATALOGUE = [
  { id: 'ge-pharmacie-du-museum', country: 'CH', canton: 'Geneva' },
  { id: 'ge-pharmacie-plaza', country: 'CH', canton: 'Geneva' },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function completeSnapshots() {
  const activeSources = clone(sourceConfig) as typeof sourceConfig;
  activeSources.sources[0].status = 'active';
  const row = {
    id: 'ge-duty-test-2026',
    pharmacyId: 'ge-pharmacie-du-museum',
    coverageType: 'canton',
    coverageName: 'Genève',
    startsAt: '2026-01-01T07:00:00.000Z',
    endsAt: '2027-01-01T07:00:00.000Z',
    dutyType: 'day',
    status: 'verified',
    sourceUrl: 'https://pharmageneve.swiss/pharmacie-de-garde/',
    sourceType: 'association',
    fetchedAt: FETCHED_AT,
    verifiedAt: FETCHED_AT,
  };
  const common = {
    _source: 'https://pharmageneve.swiss/pharmacie-de-garde/',
    _sourceKey: 'pharmageneve-garde-2026',
    _fetchedAt: FETCHED_AT,
    _attemptedAt: FETCHED_AT,
    _timezone: 'Europe/Zurich',
    _scope: { country: 'CH', canton: 'GE' },
    _coverage: {
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      minimumCalendarDays: 365,
      observedCalendarDays: 365,
      uncoveredCalendarDays: 0,
      coverage: 'covered',
    },
    _observedEntryCount: 1,
    _resolvedDutyCount: 1,
    _unresolvedIdentities: [],
    _allSourcesFailed: false,
    _releaseReady: true,
    _state: 'fresh',
    _errors: [],
    _warnings: [],
  };
  const atomic = buildAtomicGenevaDutySnapshots({
    duties: { ...common, duties: [row] },
    status: common,
    sources: activeSources,
    evaluatedAt: FETCHED_AT,
  });
  return { ...atomic, row, activeSources };
}

describe('Geneva pharmacy duty release gate', () => {
  it('imports the fixture into an atomic not_published release without writing files', async () => {
    const imported = await importGenevaPharmacyDuties({
      fixtureDir: fileURLToPath(new URL('./fixtures/pharmacy-duties', import.meta.url)),
      attemptedAt: FETCHED_AT,
      write: false,
    });

    expect(imported.release.state).toBe('not_published');
    expect(imported.duties.duties).toEqual([]);
    expect(imported.status._coverage).toMatchObject({
      observedCalendarDays: 14,
      uncoveredCalendarDays: 351,
      coverage: 'partial',
    });
    expect(imported.duties._release.releaseId).toBe(imported.status._release.releaseId);
  });

  it('keeps the checked-in partial source as not_published and non-indexable', () => {
    expect(validateGenevaDutySourceRegistry(SOURCES)).toEqual([]);
    expect(validateGenevaDutyRelease((dutiesSnapshot as GenevaDutySnapshot)._release)).toEqual([]);
    expect(verifyGenevaDutyRelease({
      duties: dutiesSnapshot as GenevaDutySnapshot,
      status: statusSnapshot as GenevaDutySnapshot,
      sources: SOURCES,
    })).toEqual([]);

    const evaluation = evaluateGenevaDutyRelease({
      duties: dutiesSnapshot as GenevaDutySnapshot,
      status: statusSnapshot as GenevaDutySnapshot,
      sources: SOURCES,
      catalogue: CATALOGUE,
      now: NOW,
    });

    expect(evaluation.state).toBe('not_published');
    expect(evaluation.coverage).toBe('partial');
    expect(evaluation.freshness).toBe('fresh');
    expect(evaluation.publishable).toBe(false);
    expect(evaluation.indexable).toBe(false);
    expect(evaluation.reasons).toEqual(expect.arrayContaining([
      'Geneva calendar coverage is not a complete contiguous 2026 calendar',
      'Geneva source status is degraded',
      'Geneva release state is not_published',
    ]));
  });

  it('would publish only an intact complete release with an active source and resolved identity', () => {
    const complete = completeSnapshots();
    const evaluation = evaluateGenevaDutyRelease({
      duties: complete.duties,
      status: complete.status,
      sources: complete.activeSources as unknown as Record<string, unknown>,
      catalogue: CATALOGUE,
      now: NOW,
    });

    expect(evaluation.state).toBe('fresh');
    expect(evaluation.publishable).toBe(true);
    expect(evaluation.indexable).toBe(true);
  });

  it('requires both paired snapshots to declare release readiness', () => {
    const complete = completeSnapshots();
    const closed = buildAtomicGenevaDutySnapshots({
      duties: { ...complete.duties, _releaseReady: false, _state: 'not_published' },
      status: complete.status,
      sources: complete.activeSources,
      evaluatedAt: FETCHED_AT,
    });
    const evaluation = evaluateGenevaDutyRelease({
      duties: closed.duties,
      status: closed.status,
      sources: complete.activeSources as unknown as Record<string, unknown>,
      catalogue: CATALOGUE,
      now: NOW,
    });

    expect(closed.release.state).toBe('not_published');
    expect(evaluation.publishable).toBe(false);
    expect(evaluation.indexable).toBe(false);
  });

  it('fails closed on payload tampering and identity/source boundary violations', () => {
    const complete = completeSnapshots();
    const tamperedPayload = {
      ...complete.duties,
      duties: [{ ...complete.row, pharmacyId: 'ge-unknown-pharmacy' }],
    };
    const tamperedEvaluation = evaluateGenevaDutyRelease({
      duties: tamperedPayload,
      status: complete.status,
      sources: complete.activeSources as unknown as Record<string, unknown>,
      catalogue: CATALOGUE,
      now: NOW,
    });
    expect(tamperedEvaluation.publishable).toBe(false);
    expect(tamperedEvaluation.reasons).toContain('Geneva release integrity verification failed');
    expect(tamperedEvaluation.reasons).toContain('Geneva duties snapshot contains invalid entries');

    const sourceTampered = buildAtomicGenevaDutySnapshots({
      duties: { ...complete.duties, duties: [{ ...complete.row, sourceUrl: 'https://example.test/duty' }] },
      status: complete.status,
      sources: complete.activeSources,
      evaluatedAt: FETCHED_AT,
    });
    const sourceEvaluation = evaluateGenevaDutyRelease({
      duties: sourceTampered.duties,
      status: sourceTampered.status,
      sources: complete.activeSources as unknown as Record<string, unknown>,
      catalogue: CATALOGUE,
      now: NOW,
    });
    expect(sourceEvaluation.publishable).toBe(false);
    expect(sourceEvaluation.reasons).toContain('Geneva duties snapshot contains invalid entries');
  });
});
