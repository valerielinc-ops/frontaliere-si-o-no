// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import sourceConfig from '../data/pharmacy-duties-geneva-sources.json';
import {
  buildAtomicGenevaDutySnapshots,
  validateGenevaDutyRelease,
  verifyGenevaDutyRelease,
} from '../services/pharmacies/genevaReleaseContract.mjs';
import { evaluateGenevaDutyRelease } from '../services/pharmacies/genevaRelease';
import { buildGenevaDutyDatasets } from '../scripts/import-pharmacy-duties-geneva.mjs';
import {
  localDateTimeToGenevaIsoForTest,
  parseGenevaDutyCards,
  parseGenevaDutySource,
} from '../scripts/lib/pharmacy-geneva-duty-parser.mjs';

const FETCHED_AT = '2026-09-15T12:00:00.000Z';
const SOURCE_HTML = readFileSync(new URL('./fixtures/pharmacy-duties/geneva/source.html', import.meta.url), 'utf8');
const CATALOGUE = [
  { id: 'ge-pharmacie-du-museum', country: 'CH', canton: 'Geneva' },
  { id: 'ge-pharmacie-plaza', country: 'CH', canton: 'Geneva' },
];

const COMPLETE_DUTY = {
  id: 'ge-duty-pharmageneve-garde-2026-2026-01-01-ge-pharmacie-plaza',
  pharmacyId: 'ge-pharmacie-plaza',
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

function cloneSourceConfig() {
  return JSON.parse(JSON.stringify(sourceConfig));
}

describe('Geneva pharmacy duty source parser', () => {
  it('separates the permanent 24/7 card and refuses partial operational publication', () => {
    const cards = parseGenevaDutyCards(SOURCE_HTML).cards;
    expect(cards.map((card) => [card.sourceLabel, card.kind])).toEqual([
      ['pharma24', 'permanent'],
      ['Pharmacie du Museum', 'dated'],
      ['Pharmacie Plaza', 'dated'],
    ]);

    const parsed = parseGenevaDutySource(SOURCE_HTML, sourceConfig, {
      fetchedAt: FETCHED_AT,
      asOf: FETCHED_AT,
      catalogue: CATALOGUE,
    });

    expect(parsed.coverage).toBe('partial');
    expect(parsed.observedCalendarDays).toBe(14);
    expect(parsed.uncoveredCalendarDays).toBe(351);
    expect(parsed.observedDuties).toHaveLength(14);
    expect(parsed.duties).toEqual([]);
    expect(parsed.errors).toEqual(expect.arrayContaining([
      'official calendar coverage is incomplete: 14/365 distinct calendar days',
      'official calendar has uncovered days in the declared 2026 window',
    ]));
    expect(parsed.warnings).toContain('permanent 24/7 cards are retained as observations only; no dated duty interval is inferred');
    expect(parsed.observedDuties.map((duty) => [duty.pharmacyId, duty.startsAt, duty.endsAt])).toEqual([
      ['ge-pharmacie-du-museum', '2026-10-31T07:00:00.000Z', '2026-10-31T22:00:00.000Z'],
      ['ge-pharmacie-du-museum', '2026-11-01T07:00:00.000Z', '2026-11-01T22:00:00.000Z'],
      ['ge-pharmacie-du-museum', '2026-11-02T07:00:00.000Z', '2026-11-02T22:00:00.000Z'],
      ['ge-pharmacie-du-museum', '2026-11-03T07:00:00.000Z', '2026-11-03T22:00:00.000Z'],
      ['ge-pharmacie-du-museum', '2026-11-04T07:00:00.000Z', '2026-11-04T22:00:00.000Z'],
      ['ge-pharmacie-du-museum', '2026-11-05T07:00:00.000Z', '2026-11-05T22:00:00.000Z'],
      ['ge-pharmacie-du-museum', '2026-11-06T07:00:00.000Z', '2026-11-06T22:00:00.000Z'],
      ['ge-pharmacie-plaza', '2026-08-15T06:00:00.000Z', '2026-08-15T21:00:00.000Z'],
      ['ge-pharmacie-plaza', '2026-08-16T06:00:00.000Z', '2026-08-16T21:00:00.000Z'],
      ['ge-pharmacie-plaza', '2026-08-17T06:00:00.000Z', '2026-08-17T21:00:00.000Z'],
      ['ge-pharmacie-plaza', '2026-08-18T06:00:00.000Z', '2026-08-18T21:00:00.000Z'],
      ['ge-pharmacie-plaza', '2026-08-19T06:00:00.000Z', '2026-08-19T21:00:00.000Z'],
      ['ge-pharmacie-plaza', '2026-08-20T06:00:00.000Z', '2026-08-20T21:00:00.000Z'],
      ['ge-pharmacie-plaza', '2026-08-21T06:00:00.000Z', '2026-08-21T21:00:00.000Z'],
    ]);
  });

  it('expands multi-day windows into daily intervals and carries overnight closing into the next day', () => {
    const overnightHtml = `
      <div class="et_pb_module et_pb_text"><div class="et_pb_text_inner"><h4>Pharmacie du Museum</h4></div></div>
      <div class="et_pb_module et_pb_text"><div class="et_pb_text_inner"><p>lundi 30 novembre au mercredi 2 décembre 2026<br />22:00 − 02:00<br />Rte de Malagnou 29<br />1208 Genève</p></div></div>`;
    const parsed = parseGenevaDutySource(overnightHtml, sourceConfig, {
      fetchedAt: FETCHED_AT,
      asOf: FETCHED_AT,
      catalogue: CATALOGUE,
    });

    expect(parsed.observedDuties.map((duty) => [duty.id, duty.startsAt, duty.endsAt])).toEqual([
      ['ge-duty-pharmageneve-garde-2026-2026-11-30-ge-pharmacie-du-museum', '2026-11-30T21:00:00.000Z', '2026-12-01T01:00:00.000Z'],
      ['ge-duty-pharmageneve-garde-2026-2026-12-01-ge-pharmacie-du-museum', '2026-12-01T21:00:00.000Z', '2026-12-02T01:00:00.000Z'],
      ['ge-duty-pharmageneve-garde-2026-2026-12-02-ge-pharmacie-du-museum', '2026-12-02T21:00:00.000Z', '2026-12-03T01:00:00.000Z'],
    ]);
  });

  it('requires a catalogue identity before returning any operational rows', () => {
    const parsed = parseGenevaDutySource(SOURCE_HTML, sourceConfig, {
      fetchedAt: FETCHED_AT,
      asOf: FETCHED_AT,
    });

    expect(parsed.observedDuties).toEqual([]);
    expect(parsed.duties).toEqual([]);
    expect(parsed.unresolvedIdentities).toEqual([
      'ge-pharmacie-du-museum',
      'ge-pharmacie-plaza',
    ]);
    expect(parsed.errors).toContain('Geneva identity catalogue is missing; no operational duty rows can be published');
  });

  it('fails closed on source identity, freshness and malformed interval changes', () => {
    const identityTampered = cloneSourceConfig();
    identityTampered.sources[0].identityAliases[1].sourceLabel = 'Museum';
    const identityResult = parseGenevaDutySource(SOURCE_HTML, identityTampered, {
      fetchedAt: FETCHED_AT,
      asOf: FETCHED_AT,
      catalogue: CATALOGUE,
    });
    expect(identityResult.duties).toEqual([]);
    expect(identityResult.errors).toContain('source identity alias is missing for "Pharmacie du Museum"');

    const staleResult = parseGenevaDutySource(SOURCE_HTML, sourceConfig, {
      fetchedAt: FETCHED_AT,
      asOf: '2026-09-19T12:00:00.000Z',
      catalogue: CATALOGUE,
    });
    expect(staleResult.freshness).toBe('stale');
    expect(staleResult.duties).toEqual([]);
    expect(staleResult.errors).toContain('official source fetch is stale');

    const malformedResult = parseGenevaDutySource(
      SOURCE_HTML.replace('08:00 − 23:00', '08:00 − 25:00'),
      sourceConfig,
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue: CATALOGUE },
    );
    expect(malformedResult.duties).toEqual([]);
    expect(malformedResult.errors).toContain('source card 2 is missing an explicit date range, interval or Geneva locality');
  });

  it('converts Zurich local boundaries and rejects the repeated autumn hour', () => {
    expect(localDateTimeToGenevaIsoForTest('01.08.2026', '08:00')).toBe('2026-08-01T06:00:00.000Z');
    expect(localDateTimeToGenevaIsoForTest('31.10.2026', '08:00')).toBe('2026-10-31T07:00:00.000Z');
    expect(localDateTimeToGenevaIsoForTest('25.10.2026', '02:30')).toBeNull();
  });

  it('allows harmless observation warnings only after a complete active release', () => {
    const activeSources = cloneSourceConfig();
    activeSources.sources[0].status = 'active';
    const metadata = {
      _source: 'https://pharmageneve.swiss/pharmacie-de-garde/',
      _sourceKey: 'pharmageneve-garde-2026',
      _timezone: 'Europe/Zurich',
      _scope: { country: 'CH', canton: 'GE' },
      _fetchedAt: FETCHED_AT,
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
      _warnings: ['permanent 24/7 cards are retained as observations only'],
    };
    const atomic = buildAtomicGenevaDutySnapshots({
      duties: { ...metadata, duties: [COMPLETE_DUTY] },
      status: { ...metadata },
      sources: activeSources,
      evaluatedAt: FETCHED_AT,
    });

    expect(atomic.release.state).toBe('fresh');
    expect(validateGenevaDutyRelease(atomic.release)).toEqual([]);
    expect(verifyGenevaDutyRelease({
      duties: atomic.duties,
      status: atomic.status,
      sources: activeSources,
    })).toEqual([]);
    expect(evaluateGenevaDutyRelease({
      duties: atomic.duties,
      status: atomic.status,
      sources: activeSources,
      catalogue: CATALOGUE,
      now: new Date(FETCHED_AT),
    })).toMatchObject({
      state: 'fresh',
      publishable: true,
      indexable: true,
    });
  });

  it('keeps even a complete-looking release closed while the source is degraded', () => {
    const degradedSources = cloneSourceConfig();
    const metadata = {
      _source: 'https://pharmageneve.swiss/pharmacie-de-garde/',
      _sourceKey: 'pharmageneve-garde-2026',
      _timezone: 'Europe/Zurich',
      _scope: { country: 'CH', canton: 'GE' },
      _fetchedAt: FETCHED_AT,
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
      _releaseReady: false,
      _state: 'not_published',
      _errors: [],
      _warnings: [],
    };
    const atomic = buildAtomicGenevaDutySnapshots({
      duties: { ...metadata, duties: [COMPLETE_DUTY] },
      status: { ...metadata },
      sources: degradedSources,
      evaluatedAt: FETCHED_AT,
    });
    const evaluation = evaluateGenevaDutyRelease({
      duties: atomic.duties,
      status: atomic.status,
      sources: degradedSources,
      catalogue: CATALOGUE,
      now: new Date(FETCHED_AT),
    });

    expect(atomic.release.state).toBe('not_published');
    expect(evaluation).toMatchObject({
      state: 'not_published',
      publishable: false,
      indexable: false,
    });
    expect(evaluation.reasons).toContain('Geneva source status is degraded');
  });

  it('builds paired not_published snapshots with explicit release readiness', () => {
    const atomic = buildGenevaDutyDatasets({
      sourceData: sourceConfig,
      html: SOURCE_HTML,
      attemptedAt: FETCHED_AT,
      catalogue: CATALOGUE,
    });

    expect(atomic.release.state).toBe('not_published');
    expect(atomic.duties.duties).toEqual([]);
    expect(atomic.duties._releaseReady).toBe(false);
    expect(atomic.status._releaseReady).toBe(false);
    expect(atomic.status._state).toBe('not_published');
    expect(verifyGenevaDutyRelease({
      duties: atomic.duties,
      status: atomic.status,
      sources: sourceConfig,
    })).toEqual([]);
  });
});
