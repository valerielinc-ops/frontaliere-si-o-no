import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BORDER_SLA_TOLERANCE,
  DEFAULT_ANAGRAFICA_MAX_AGE_HOURS,
  buildReport,
  countSwissCantons,
  detectAnagraficaConflicts,
  detectBorderIdentityCollisions,
  detectMissingSecondaryProvenance,
  detectDutyConflicts,
  evaluateCoverage,
  evaluateBorderHealth,
  evaluateFreshness,
  findBorderOutOfScopeRecords,
  findBorderSourceMismatches,
  normalizeIdentityField,
  formatReport,
  parseIsoDurationMs,
} from '../scripts/check-pharmacy-data-health.mjs';
import ticino from '../data/pharmacies-ticino-complete.json';
import italy from '../data/pharmacies-italy-border.json';
import borderSources from '../data/pharmacy-border-sources.json';
import borderDuties from '../data/pharmacy-duties-ticino.json';
import { SKIP_LIVE_DATA } from './helpers/live-data';

const PHARMACY_WORKFLOW = join(__dirname, '..', '.github', 'workflows', 'pharmacy-data-health-monitor.yml');
const BORDER_SYNC_WORKFLOW = join(__dirname, '..', '.github', 'workflows', 'sync-pharmacies-border.yml');

/**
 * Osservatore della dashboard dati farmacie (#6753). Il punto misurato: le
 * quattro dimensioni che `docs/pharmacy-data-policy.md` dichiara (copertura,
 * freschezza, errori di fetch, conflitti) devono produrre un verdetto, e
 * l'assenza della pipeline turni (#6750) NON deve contare come guasto —
 * altrimenti il monitor nasce rosso e viene ignorato.
 */

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86400e3).toISOString();

const registry = {
  sources: {
    ticino: { canton: 'Ticino', status: 'active', sourceType: 'official', fetchFrequency: 'P1D' },
  },
};

const anagrafica = (overrides: Record<string, unknown> = {}) => ({
  _fetchedAt: iso(4),
  _sourceRegions: ['a', 'b', 'c', 'd'],
  _errors: [],
  pharmacies: [
    { id: 'ti-a', slug: 'a', name: 'Alfa', address: 'Via 1', postalCode: '6900', city: 'Lugano', sourceUrl: 'r1' },
    { id: 'ti-b', slug: 'b', name: 'Beta', address: 'Via 2', postalCode: '6850', city: 'Mendrisio', sourceUrl: 'r2' },
  ],
  ...overrides,
});

describe('parseIsoDurationMs', () => {
  it('parses the fetchFrequency forms the registry uses', () => {
    expect(parseIsoDurationMs('P1D')).toBe(86400e3);
    expect(parseIsoDurationMs('P7D')).toBe(7 * 86400e3);
    expect(parseIsoDurationMs('PT6H')).toBe(6 * 3600e3);
  });

  it('returns null on garbage or zero-length durations', () => {
    expect(parseIsoDurationMs('daily')).toBeNull();
    expect(parseIsoDurationMs('P0D')).toBeNull();
    expect(parseIsoDurationMs(undefined)).toBeNull();
  });
});

describe('countSwissCantons', () => {
  it('re-expands the half-canton groups the URL slug file collapses', () => {
    expect(
      countSwissCantons({
        cantons: { TICINO: {}, APPENZELLO: {}, BASILEA: {} },
        cantonGroups: { APPENZELLO: { members: ['AI', 'AR'] }, BASILEA: { members: ['BL', 'BS'] } },
      }),
    ).toBe(5);
  });
});

describe('evaluateCoverage', () => {
  it('counts pharmacies, cities and regions per registered canton', () => {
    const cov = evaluateCoverage(registry, { ticino: anagrafica() }, {}, 26);
    expect(cov.cantonsInRegistry).toBe(1);
    expect(cov.cantonsWithAnagrafica).toBe(1);
    expect(cov.cantonsWithDuties).toBe(0);
    expect(cov.byStatus).toEqual({ active: 1 });
    expect(cov.entries[0]).toMatchObject({ key: 'ticino', pharmacyCount: 2, cityCount: 2, regionsConfigured: 4 });
  });
});

describe('evaluateFreshness', () => {
  it('holds the anagrafica to the monthly SLA, not to the daily duty cadence', () => {
    const fresh = evaluateFreshness(registry, { ticino: anagrafica() }, {}, NOW);
    expect(fresh.entries[0]).toMatchObject({ kind: 'anagrafica', stale: false });
    const stale = evaluateFreshness(registry, { ticino: anagrafica({ _fetchedAt: iso(40) }) }, {}, NOW);
    expect(stale.entries[0].stale).toBe(true);
    expect(stale.entries[0].maxAgeHours).toBe(DEFAULT_ANAGRAFICA_MAX_AGE_HOURS);
  });

  it('holds duties to fetchFrequency × tolerance', () => {
    const ok = evaluateFreshness(registry, {}, { ticino: { _fetchedAt: iso(1), duties: [] } }, NOW);
    expect(ok.entries[0]).toMatchObject({ kind: 'turni', stale: false });
    const late = evaluateFreshness(registry, {}, { ticino: { _fetchedAt: iso(3), duties: [] } }, NOW);
    expect(late.entries[0].stale).toBe(true);
  });

  it('flags a missing or unparsable _fetchedAt as stale', () => {
    const res = evaluateFreshness(registry, { ticino: anagrafica({ _fetchedAt: undefined }) }, {}, NOW);
    expect(res.entries[0]).toMatchObject({ stale: true, ageHours: null });
  });
});

describe('evaluateBorderHealth', () => {
  // conta i record reali di data/pharmacies-*.json, risincronizzati ogni notte: rosso possibile senza cambi di codice
  it.skipIf(SKIP_LIVE_DATA)('reports all four policy jurisdictions and their real record counts', () => {
    const health = evaluateBorderHealth({
      sources: borderSources,
      ticino,
      italy,
      duties: borderDuties,
      nowMs: Date.parse(ticino._fetchedAt) + 3600e3,
    });
    expect(health.jurisdictions).toMatchObject([
      { key: 'CH-TI', sourceStatus: 'active', recordCount: 207 },
      { key: 'IT-CO', sourceStatus: 'active', recordCount: 193 },
      { key: 'IT-VA', sourceStatus: 'active', recordCount: 266 },
      { key: 'IT-VB', sourceStatus: 'active', recordCount: 83 },
    ]);
    expect(health.totalRecords).toBe(749);
    expect(health.fetchErrors).toEqual([]);
    expect(health.outOfScopeRecords).toEqual([]);
    expect(health.sourceMismatches).toEqual([]);
    expect(health.identityCollisions).toEqual([]);
    expect(health.missingSecondaryProvenance).toEqual([]);
    expect(health.validationErrors).toEqual([]);
    expect(health.jurisdictions[1].maxAgeHours).toBe(24 * BORDER_SLA_TOLERANCE);
  });

  it('fails closed on stale snapshots, out-of-scope records and secondary values without provenance', () => {
    const stale = {
      _fetchedAt: iso(3),
      _errors: ['timeout'],
      pharmacies: [
        { id: 'it-a', slug: 'a', name: 'Alfa', address: 'Via 1', postalCode: '1', city: 'Como', country: 'IT', province: 'CO', sourceType: 'official', sourceUrl: 'https://source.test' },
        { id: 'it-b', slug: 'b', name: 'Beta', address: 'Via 2', postalCode: '2', city: 'Novara', country: 'IT', province: 'NO', sourceType: 'official', sourceUrl: 'https://source.test' },
        { id: 'it-c', slug: 'c', name: 'Gamma', address: 'Via 3', postalCode: '3', city: 'Como', country: 'IT', province: 'CO', phone: '+39 1', sourceType: 'directory', sourceUrl: 'https://source.test' },
      ],
    };
    const health = evaluateBorderHealth({
      sources: { sources: {
        'ticino-complete': { status: 'active', fetchFrequency: 'P30D', officialSourceUrl: 'https://source.test' },
        'italy-border': { status: 'active', fetchFrequency: 'P1D', officialSourceUrl: 'https://source.test' },
        'osm-enrichment': { status: 'active', fetchFrequency: 'P30D', officialSourceUrl: 'https://source.test', license: 'ODbL 1.0' },
      } },
      ticino: { _fetchedAt: iso(1), pharmacies: [] },
      italy: stale,
      duties: { duties: [] },
      nowMs: NOW,
    });
    expect(health.jurisdictions.find((entry) => entry.key === 'IT-CO')).toMatchObject({ stale: true, fetchErrorCount: 1 });
    expect(health.outOfScopeRecords).toHaveLength(1);
    expect(health.missingSecondaryProvenance).toEqual([{ jurisdiction: 'IT', pharmacyId: 'it-c', field: 'phone' }]);
    expect(health.fetchErrors).toMatchObject([{ key: 'italy-border', count: 1 }]);
  });

  it('rejects a snapshot timestamp in the future', () => {
    const health = evaluateBorderHealth({
      sources: borderSources,
      ticino: { ...ticino, _fetchedAt: new Date(NOW + 3600e3).toISOString() },
      italy: { ...italy, _fetchedAt: iso(1) },
      duties: borderDuties,
      nowMs: NOW,
    });
    expect(health.jurisdictions.find((entry) => entry.key === 'CH-TI')).toMatchObject({
      stale: true,
      reason: expect.stringContaining('futuro'),
    });
  });
});

describe('border sync cadence', () => {
  it('keeps the daily Italian source aligned with a daily catalogue workflow', () => {
    const workflow = readFileSync(BORDER_SYNC_WORKFLOW, 'utf8');
    expect(borderSources.sources['italy-border'].fetchFrequency).toBe('P1D');
    expect(workflow).toContain("cron: '23 4 * * *'");
    expect(readFileSync(PHARMACY_WORKFLOW, 'utf8')).toContain("cron: '10 6 * * *'");
  });
});

describe('border identity and provenance helpers', () => {
  it('detects cross-jurisdiction collisions without flagging distinct records', () => {
    const records = [
      { jurisdiction: 'CH-TI', pharmacy: { id: 'same', slug: 'same', name: 'Alfa', postalCode: '6900', address: 'Via 1', country: 'CH', canton: 'Ticino' } },
      { jurisdiction: 'IT-CO', pharmacy: { id: 'same', slug: 'other', name: 'Alfa', postalCode: '6900', address: 'Via 1', country: 'IT', province: 'CO' } },
      { jurisdiction: 'IT-VA', pharmacy: { id: 'different', slug: 'different', name: 'Beta', postalCode: '1', address: 'Via 2', country: 'IT', province: 'VA' } },
    ];
    expect(detectBorderIdentityCollisions(records).map((collision) => collision.field)).toEqual(['id', 'identity']);
    expect(findBorderOutOfScopeRecords(records)).toEqual([]);
    expect(findBorderSourceMismatches([
      { jurisdiction: 'CH-TI', sourceKey: 'ticino-complete', pharmacy: { id: 'it-in-ch', name: 'Italia in Ticino', country: 'IT', province: 'CO' } },
      { jurisdiction: 'IT', sourceKey: 'italy-border', pharmacy: { id: 'ch-in-it', name: 'Svizzera in Italia', country: 'CH', canton: 'Ticino' } },
    ])).toHaveLength(2);
  });

  it('only permits explicitly whitelisted official record fields without fieldSources', () => {
    expect(detectMissingSecondaryProvenance([{
      jurisdiction: 'CH-TI',
      sourceKey: 'ticino-complete',
      pharmacy: {
        id: 'official-phone',
        phone: '+41 91 000 00 00',
        sourceType: 'official',
        sourceUrl: 'https://www.ofct.ch/luganese/',
        dataAvailability: { phone: 'verified' },
      },
    }])).toEqual([]);
    expect(detectMissingSecondaryProvenance([{
      jurisdiction: 'IT',
      sourceKey: 'italy-border',
      pharmacy: {
        id: 'unlisted-phone',
        phone: '+39 000 000 000',
        sourceType: 'official',
        sourceUrl: 'https://www.dati.salute.gov.it/it/dataset/farmacie/',
        dataAvailability: { phone: 'verified' },
      },
    }])).toEqual([{ jurisdiction: 'IT', pharmacyId: 'unlisted-phone', field: 'phone' }]);
  });
});

describe('conflict detection', () => {
  it('catches duplicate ids, slugs and the same pharmacy emitted by two regions', () => {
    const doc = anagrafica({
      pharmacies: [
        { id: 'ti-a', slug: 'a', name: 'Alfa', address: 'Via 1', postalCode: '6900', sourceUrl: 'r1' },
        { id: 'ti-a', slug: 'a', name: 'Alfa', address: 'Via 1', postalCode: '6900', sourceUrl: 'r2' },
      ],
    });
    const types = detectAnagraficaConflicts('ticino', doc).map((c) => c.type);
    expect(types).toContain('duplicate-id');
    expect(types).toContain('duplicate-slug');
    expect(types).toContain('duplicate-identity');
  });

  it('flags a duty still "verified" past its endsAt — the state the policy forbids publishing', () => {
    const conflicts = detectDutyConflicts(
      'ticino',
      { duties: [{ id: 'd1', status: 'verified', endsAt: iso(1), coverageName: 'Lugano' }] },
      NOW,
    );
    expect(conflicts.map((c) => c.type)).toEqual(['duty-expired-but-verified']);
  });

  it('flags conflicting duties', () => {
    const conflicts = detectDutyConflicts('ticino', { duties: [{ id: 'd2', status: 'conflicting' }] }, NOW);
    expect(conflicts.map((c) => c.type)).toEqual(['duty-conflicting']);
  });
});

describe('buildReport', () => {
  it('is healthy on the current shape of the data — a missing duty pipeline is expected, not a fault', () => {
    const report = buildReport({ registry, datasets: { ticino: anagrafica() }, knownCantonCount: 26, nowMs: NOW });
    expect(report.problems).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(report.dutiesPipeline.available).toBe(false);
  });

  it('reports an "active" source that publishes no dataset at all', () => {
    const report = buildReport({ registry, datasets: {}, duties: {}, knownCantonCount: 26, nowMs: NOW });
    expect(report.healthy).toBe(false);
    expect(report.problems.join('\n')).toContain('è "active" ma non esiste alcun dataset');
  });

  it('surfaces blocked sources, fetch errors and staleness together', () => {
    const report = buildReport({
      registry: { sources: { ...registry.sources, vaud: { canton: 'Vaud', status: 'blocked' } } },
      datasets: { ticino: anagrafica({ _fetchedAt: iso(40), _errors: ['timeout su /luganese/'] }) },
      knownCantonCount: 26,
      nowMs: NOW,
    });
    const joined = report.problems.join('\n');
    expect(joined).toContain('vaud');
    expect(joined).toContain('stale');
    expect(joined).toContain('errore/i di fetch');
    expect(report.fetchErrors[0]).toMatchObject({ key: 'ticino', count: 1 });
  });

  it('formats a dashboard that names every dimension', () => {
    const lines = formatReport(
      buildReport({ registry, datasets: { ticino: anagrafica() }, knownCantonCount: 26, nowMs: NOW }),
    ).join('\n');
    expect(lines).toContain('Copertura: 1/26');
    expect(lines).toContain('Freschezza anagrafica/ticino');
    expect(lines).toContain('Errori di fetch: 0');
    expect(lines).toContain('Conflitti: 0');
  });
});

describe('normalizeIdentityField', () => {
  it('collapses whitespace and strips diacritics so the same pharmacy from two regions still collides', () => {
    expect(normalizeIdentityField('Via  Nassa  5')).toBe(normalizeIdentityField('Via Nassa 5'));
    expect(normalizeIdentityField('Lugàno ')).toBe('lugano');
    expect(normalizeIdentityField(undefined)).toBe('');
  });

  it('catches a cross-region duplicate whose address only differs by spacing', () => {
    const doc = {
      pharmacies: [
        { id: 'ti-a', slug: 'a', name: 'Alfa', address: 'Via Nassa 5', postalCode: '6900', sourceUrl: 'r1' },
        { id: 'ti-b', slug: 'b', name: 'Alfa', address: 'Via  Nassa  5', postalCode: '6900', sourceUrl: 'r2' },
      ],
    };
    expect(detectAnagraficaConflicts('ticino', doc).map((c) => c.type)).toEqual(['duplicate-identity']);
  });

  it('does not collapse two distinct pharmacies onto a degenerate key when a field normalizes to empty', () => {
    const doc = {
      pharmacies: [
        { id: 'ti-a', slug: 'a', name: 'Alfa', address: '   ', postalCode: '6900', sourceUrl: 'r1' },
        { id: 'ti-b', slug: 'b', name: 'Alfa', address: '\u00a0', postalCode: '6900', sourceUrl: 'r2' },
      ],
    };
    expect(detectAnagraficaConflicts('ticino', doc)).toEqual([]);
  });
});

describe('the identity check against the real dataset', () => {
  // giudica la snapshot reale data/pharmacies-ticino-complete.json: rosso possibile senza cambi di codice
  it.skipIf(SKIP_LIVE_DATA)('reports zero conflicts on the complete Ticino snapshot, so the monitor is born green', () => {
    expect(ticino.pharmacies.length).toBeGreaterThan(100);
    expect(detectAnagraficaConflicts('ticino', ticino)).toEqual([]);
  });
});

describe('report payload consumed by the workflow', () => {
  it('carries the rendered dashboard so the workflow reads it with jq, not a regex on U+2500 separators', () => {
    const report = buildReport({ registry, datasets: { ticino: anagrafica() }, knownCantonCount: 26, nowMs: NOW });
    expect(Array.isArray(report.dashboard)).toBe(true);
    expect(report.dashboard.join('\n')).toContain('Copertura: 1/26');
  });

  it('names the catalogue workflow as the way out when the anagrafica goes stale', () => {
    const report = buildReport({
      registry,
      datasets: { ticino: anagrafica({ _fetchedAt: iso(40) }) },
      knownCantonCount: 26,
      nowMs: NOW,
    });
    expect(report.problems.join('\n')).toContain('sync-pharmacies-border');
  });

  // asserisce i conteggi reali (749 record, 193 IT-CO) delle snapshot farmacie: rosso possibile senza cambi di codice
  it.skipIf(SKIP_LIVE_DATA)('includes the border health panel in the machine-readable report and dashboard', () => {
    const report = buildReport({
      registry,
      datasets: { ticino: anagrafica() },
      duties: { ticino: { _fetchedAt: iso(1), duties: [] } },
      knownCantonCount: 26,
      nowMs: NOW,
      border: {
        sources: borderSources,
        ticino: { ...ticino, _fetchedAt: iso(1) },
        italy: { ...italy, _fetchedAt: iso(1) },
        duties: borderDuties,
      },
    });
    expect(report.healthy).toBe(true);
    expect(report.border).toMatchObject({ totalRecords: 749, outOfScopeRecords: [], identityCollisions: [], missingSecondaryProvenance: [] });
    expect(report.dashboard.join('\n')).toContain('Perimetro operativo: 4 giurisdizioni · 749 record');
    expect(report.dashboard.join('\n')).toContain('IT-CO [active] — 193 record');
    expect(report.dashboard.join('\n')).toContain('Errori fetch perimetro: 0');
    expect(report.dashboard.join('\n')).toContain('Record nella snapshot della fonte errata: 0');
  });

  it('turns a border health failure into an unhealthy build report', () => {
    const report = buildReport({
      registry,
      datasets: { ticino: anagrafica() },
      duties: { ticino: { _fetchedAt: iso(1), duties: [] } },
      knownCantonCount: 26,
      nowMs: NOW,
      border: {
        sources: borderSources,
        ticino: { ...ticino, _fetchedAt: iso(70) },
        italy: { ...italy, _fetchedAt: iso(1) },
        duties: borderDuties,
      },
    });
    expect(report.healthy).toBe(false);
    expect(report.problems.join('\n')).toContain('dataset perimetro CH-TI stale');
  });
});

describe('recovery issue lifecycle', () => {
  it('the clean path resolves both the degraded-data and workflow-failure titles', () => {
    const workflow = readFileSync(PHARMACY_WORKFLOW, 'utf8');
    const cleanStep = workflow.slice(workflow.indexOf('Resolve issue on clean dashboard'));
    expect(cleanStep).toContain('--title "[pharmacy-data-health] dato farmacie degradato');
    expect(cleanStep).toContain('--title "Workflow Failure: ${{ github.workflow }}"');
  });
});
