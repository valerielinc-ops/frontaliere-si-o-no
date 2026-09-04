import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANAGRAFICA_MAX_AGE_HOURS,
  buildReport,
  countSwissCantons,
  detectAnagraficaConflicts,
  detectDutyConflicts,
  evaluateCoverage,
  evaluateFreshness,
  normalizeIdentityField,
  formatReport,
  parseIsoDurationMs,
} from '../scripts/check-pharmacy-data-health.mjs';

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
});

describe('report payload consumed by the workflow', () => {
  it('carries the rendered dashboard so the workflow reads it with jq, not a regex on U+2500 separators', () => {
    const report = buildReport({ registry, datasets: { ticino: anagrafica() }, knownCantonCount: 26, nowMs: NOW });
    expect(Array.isArray(report.dashboard)).toBe(true);
    expect(report.dashboard.join('\n')).toContain('Copertura: 1/26');
  });

  it('names the scheduler (#6752) as the way out when the anagrafica goes stale', () => {
    const report = buildReport({
      registry,
      datasets: { ticino: anagrafica({ _fetchedAt: iso(40) }) },
      knownCantonCount: 26,
      nowMs: NOW,
    });
    expect(report.problems.join('\n')).toContain('#6752');
  });
});
