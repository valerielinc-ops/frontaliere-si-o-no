import { describe, expect, it } from 'vitest';

import registry from '../data/pharmacy-sources-registry.json';
import {
  validatePharmacySourcesRegistry,
  validatePharmacySourceEntry,
} from '../services/pharmacies/types';

/**
 * Schema guard for `data/pharmacy-sources-registry.json` (#6397, prereq for
 * the #6173 pharmacy/pharmacy-duty MVP). Fase 1 populates Ticino as
 * source config; every entry must carry the full source-config shape so a
 * future connector has a common contract to read. Ticino moved from
 * `unverified` to `active` after the #6398 network verification of
 * `ofct.ch` (see `docs/data-sources/farmacie-turno-ticino.md`).
 */
describe('pharmacy sources registry schema', () => {
  it('passes full-registry validation with zero errors', () => {
    const errors = validatePharmacySourcesRegistry(registry);
    expect(errors).toEqual([]);
  });

  it('covers exactly the Fase 1 canton: Ticino', () => {
    const cantons = Object.values(registry.sources).map((s) => s.canton).sort();
    expect(cantons).toEqual(['Ticino']);
  });

  it('ticino is "active" with html-scrape access, verified against ofct.ch (#6398)', () => {
    expect(registry.sources.ticino.status).toBe('active');
    expect(registry.sources.ticino.accessMethod).toBe('html-scrape');
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
