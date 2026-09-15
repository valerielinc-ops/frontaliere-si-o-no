import { describe, expect, it } from 'vitest';

import registry from '../data/pharmacy-sources-registry.json';
import {
  validatePharmacySourcesRegistry,
  validatePharmacySourceEntry,
} from '../services/pharmacies/types';
import { SWISS_CANTONS } from '../services/pharmacies/swissCantons';

const ASSOCIATION_CANTON_KEYS = new Set([
  'aargau',
  'bern',
  'fribourg',
  'geneva',
  'graubunden',
  'jura',
  'lucerne',
  'neuchatel',
  'solothurn',
  'thurgau',
  'vaud',
  'valais',
  'zurich',
]);

/**
 * Schema guard for `data/pharmacy-sources-registry.json` (#6397, prereq for
 * the #6173 pharmacy/pharmacy-duty MVP). The registry maps the complete
 * `SWISS_CANTONS` geography to source configuration; every entry must carry
 * the full source-config shape so a future connector has a common contract
 * to read. Ticino is the only active source after the #6398 network
 * verification of `ofct.ch` (see `docs/data-sources/farmacie-turno-ticino.md`).
 */
describe('pharmacy sources registry schema', () => {
  it('passes full-registry validation with zero errors', () => {
    const errors = validatePharmacySourcesRegistry(registry);
    expect(errors).toEqual([]);
  });

  it('covers exactly all 26 canton keys and codes from SWISS_CANTONS', () => {
    const registryKeys = Object.keys(registry.sources).sort();
    const cantonKeys = SWISS_CANTONS.map((canton) => canton.key).sort();

    expect(SWISS_CANTONS).toHaveLength(26);
    expect(new Set(SWISS_CANTONS.map((canton) => canton.code)).size).toBe(26);
    expect(registryKeys).toEqual(cantonKeys);

    for (const canton of SWISS_CANTONS) {
      const source = registry.sources[canton.key];
      expect(source.canton).toBe(canton.names.it);
      expect(source.officialSourceUrl).toMatch(/^https:\/\//);
      expect(source.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    }
  });

  it('ticino is "active" with html-scrape access, verified against ofct.ch (#6398)', () => {
    expect(registry.sources.ticino.status).toBe('active');
    expect(registry.sources.ticino.accessMethod).toBe('html-scrape');
  });

  it('keeps non-Ticino sources unverified until a connector or dataset exists', () => {
    for (const canton of SWISS_CANTONS.filter((candidate) => candidate.code !== 'TI')) {
      const source = registry.sources[canton.key];
      expect(source.status).not.toBe('active');
      expect(source.sourceFetchedAt).toBeUndefined();
    }
  });

  it('marks associative and institutional discovery sources explicitly', () => {
    for (const canton of SWISS_CANTONS.filter((candidate) => candidate.code !== 'TI')) {
      const source = registry.sources[canton.key];
      expect(source.status).toBe('unverified');
      expect(source.sourceType).toBe(ASSOCIATION_CANTON_KEYS.has(canton.key) ? 'association' : 'official');
    }
  });

  it('rejects an entry missing a required field', () => {
    const incomplete = { ...registry.sources.ticino, owner: '' };
    const errors = validatePharmacySourceEntry('ticino', incomplete);
    expect(errors.some((e) => e.includes('owner'))).toBe(true);
  });

  it('rejects an entry with an invalid status', () => {
    const invalid = { ...registry.sources.ticino, status: 'bogus' };
    const errors = validatePharmacySourceEntry('ticino', invalid);
    expect(errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('rejects an entry with an invalid sourceType', () => {
    const invalid = { ...registry.sources.ticino, sourceType: 'bogus' };
    const errors = validatePharmacySourceEntry('ticino', invalid);
    expect(errors.some((e) => e.includes('sourceType'))).toBe(true);
  });

  it('rejects a registry with no sources', () => {
    const errors = validatePharmacySourcesRegistry({ generatedAt: '2026-08-31T00:00:00.000Z', sources: {} });
    expect(errors.some((e) => e.includes('no entries'))).toBe(true);
  });
});
