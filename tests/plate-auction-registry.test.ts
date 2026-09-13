import { describe, expect, it } from 'vitest';

import registry from '../data/plate-auction-sources-registry.json';
import {
  validatePlateAuctionSourcesRegistry,
  validatePlateAuctionSourceEntry,
} from '../services/plateAuctions/types';

/**
 * Schema guard for `data/plate-auction-sources-registry.json` (#6355, prereq
 * for the #4854 plate-auction connectors). The registry is complete for all
 * 26 cantons: discovery status is explicit, and only sources with a verified
 * public catalogue are activated.
 */
describe('plate-auction sources registry schema', () => {
  it('passes full-registry validation with zero errors', () => {
    const errors = validatePlateAuctionSourcesRegistry(registry);
    expect(errors).toEqual([]);
  });

  it('covers all 26 Swiss cantons while keeping source status explicit', () => {
    const cantons = Object.values(registry.sources).map((s) => s.canton).sort();
    expect(cantons).toEqual([
      'Appenzello Esterno',
      'Appenzello Interno',
      'Argovia',
      'Basilea Campagna',
      'Basilea Città',
      'Berna',
      'Friburgo',
      'Ginevra',
      'Giura',
      'Glarona',
      'Grigioni',
      'Lucerna',
      'Neuchâtel',
      'Nidvaldo',
      'Obvaldo',
      'San Gallo',
      'Sciaffusa',
      'Soletta',
      'Svitto',
      'Ticino',
      'Turgovia',
      'Uri',
      'Vallese',
      'Vaud',
      'Zugo',
      'Zurigo',
    ]);
  });

  it('every entry has a valid explicit discovery status', () => {
    const validStatuses = ['unverified', 'active', 'blocked', 'degraded', 'not-discovered', 'no-public-auction'];
    for (const [key, entry] of Object.entries(registry.sources)) {
      expect(validStatuses, `${key} status "${entry.status}" should be a known value`).toContain(entry.status);
    }
  });

  it('verified public catalogues are active and TI remains explicitly blocked', () => {
    expect(registry.sources.vs.status).toBe('active');
    expect(registry.sources.vs.accessMethod).toBe('html-scrape');
    expect(registry.sources.gr.status).toBe('active');
    expect(registry.sources.zh.status).toBe('active');
    expect(registry.sources.ti.status).toBe('blocked');
  });

  it('rejects an entry missing a required field', () => {
    const incomplete = { ...registry.sources.ti, owner: '' };
    const errors = validatePlateAuctionSourceEntry('ticino', incomplete);
    expect(errors.some((e) => e.includes('owner'))).toBe(true);
  });

  it('rejects an entry with an invalid status', () => {
    const invalid = { ...registry.sources.ti, status: 'bogus' };
    const errors = validatePlateAuctionSourceEntry('ticino', invalid);
    expect(errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('rejects a registry with no sources', () => {
    const errors = validatePlateAuctionSourcesRegistry({ generatedAt: '2026-08-27T00:00:00.000Z', sources: {} });
    expect(errors.some((e) => e.includes('no entries'))).toBe(true);
  });
});
