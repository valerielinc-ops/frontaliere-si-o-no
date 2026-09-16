import { describe, expect, it } from 'vitest';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import registryJson from '../data/pharmacy-sources-registry.json';
import catalogueJson from '../data/pharmacies-ticino-complete.json';
import {
  buildDutyCoverageMatrix,
  formatDutyCoverageDate,
} from '../services/pharmacies/dutyCoverageMatrix';
import type {
  PharmacyCatalogueDataset,
  PharmacyDutiesDataset,
  PharmacySourcesRegistry,
} from '../services/pharmacies/types';

const duties = dutiesJson as unknown as PharmacyDutiesDataset;
const catalogue = catalogueJson as unknown as PharmacyCatalogueDataset;
const registry = registryJson as unknown as PharmacySourcesRegistry;
const now = new Date('2026-09-15T12:00:00.000Z');

describe('duty coverage matrix', () => {
  it('keeps the five Ticino duty regions separate from 25 source-only cantons', () => {
    const matrix = buildDutyCoverageMatrix({ duties, catalogue, registry, now, weekStart: '2026-09-14' });

    expect(matrix.releaseReady).toBe(true);
    expect(matrix.status).toBe('ready');
    expect(matrix.regions).toHaveLength(5);
    expect(matrix.regions.map((region) => region.name)).toEqual([
      'Mendrisiotto',
      'Luganese',
      'Bellinzonese',
      'Biasca e Valli',
      'Locarnese',
    ]);
    expect(matrix.regions.every((region) => region.duties.length > 0)).toBe(true);
    expect(matrix.regions.find((region) => region.key === 'locarnese')?.sourceUrl).toBe('https://www.farmacielocarnese.ch/');

    expect(matrix.sourceOnlyCantons).toHaveLength(25);
    for (const canton of matrix.sourceOnlyCantons) {
      expect(Object.keys(canton).sort()).toEqual([
        'code',
        'key',
        'name',
        'officialSourceUrl',
        'lastVerifiedAt',
        'sourceType',
        'status',
      ].sort());
      expect(canton.code).not.toBe('TI');
      expect(canton.officialSourceUrl).toMatch(/^https:\/\//);
      expect(canton.lastVerifiedAt).toMatch(/^2026-09-15T/);
      expect(canton.status).toBeTruthy();
      expect(canton.sourceType).toBeTruthy();
      expect(canton).not.toHaveProperty('pharmacy');
      expect(canton).not.toHaveProperty('duties');
      expect(canton).not.toHaveProperty('startsAt');
      expect(canton).not.toHaveProperty('endsAt');
    }

    expect(matrix.italy.provinces.map((province) => province.code)).toEqual(['CO', 'VA', 'VB']);
    expect(matrix.italy.publishable).toBe(false);
    expect(matrix.italy.indexable).toBe(false);
    expect(matrix.italy.provinces.every((province) => province.duties.length === 0)).toBe(true);
    expect(matrix.italy.provinces.map((province) => province.sourceUrl)).toEqual([
      'https://www.comune.merone.co.it/novita/comunicati_stampa/novita_138.html',
      'https://comune.marchirolo.varese.it/Dettaglionews?IDNews=400586',
      'https://www.aslvco.it/wp-content/uploads/2025/12/2968938.pdf?x88295=',
    ]);
    expect(matrix.italy.sourceOnly.every((province) => !('dutyCount' in province))).toBe(true);

    const english = buildDutyCoverageMatrix({ duties, catalogue, registry, locale: 'en', now, weekStart: '2026-09-14' });
    expect(english.sourceOnlyCantons.find((canton) => canton.code === 'AG')?.name).toBe('Aargau');
  });

  it('suppresses all Ticino duties when the release is not ready', () => {
    const tampered = {
      ...duties,
      _release: { ...duties._release, state: 'partial' },
    } as unknown as PharmacyDutiesDataset;
    const matrix = buildDutyCoverageMatrix({ duties: tampered, catalogue, registry, now, weekStart: '2026-09-14' });

    expect(matrix.releaseReady).toBe(false);
    expect(matrix.regions).toHaveLength(5);
    expect(matrix.regions.every((region) => region.duties.length === 0)).toBe(true);
    expect(matrix.regions.every((region) => region.sourceUrl === null)).toBe(true);
    expect(matrix.sourceOnlyCantons).toHaveLength(25);
    expect(matrix.italy.provinces.every((province) => province.duties.length === 0)).toBe(true);
  });

  it('rejects non-HTTPS official source URLs at the read-model boundary', () => {
    const unsafeRegistry = {
      ...registry,
      sources: {
        ...registry.sources,
        aargau: { ...registry.sources.aargau, officialSourceUrl: 'http://example.invalid/source' },
      },
    } as PharmacySourcesRegistry;
    const matrix = buildDutyCoverageMatrix({ duties, catalogue, registry: unsafeRegistry, now, weekStart: '2026-09-14' });

    expect(matrix.sourceOnlyCantons.find((canton) => canton.code === 'AG')?.officialSourceUrl).toBeNull();
    expect(matrix.sourceOnlyCantons.find((canton) => canton.code === 'AG')?.lastVerifiedAt).toBe('2026-09-15T00:00:00.000Z');
  });

  it('formats source verification dates in the Zurich timezone', () => {
    expect(formatDutyCoverageDate('2026-09-15T00:00:00.000Z', 'it')).toBe('15 set 2026');
  });
});
