import { describe, expect, it } from 'vitest';

import registry from '../data/plate-auction-sources-registry.json';
import {
  validatePlateAuctionSourcesRegistry,
  validatePlateAuctionSourceEntry,
} from '../services/plateAuctions/types';

/**
 * Schema guard for `data/plate-auction-sources-registry.json` (#6355, prereq
 * for the #4854 plate-auction connectors). Fase 0 only populates TI/GR/VS as
 * `status: "unverified"` config — no auction data lives here — but every
 * entry must still carry the full source-config shape so a future connector
 * has a common contract to read.
 */
describe('plate-auction sources registry schema', () => {
  it('passes full-registry validation with zero errors', () => {
    const errors = validatePlateAuctionSourcesRegistry(registry);
    expect(errors).toEqual([]);
  });

  it('covers exactly the Fase 0/1 cantons: Ticino, Grigioni, Vallese', () => {
    const cantons = Object.values(registry.sources).map((s) => s.canton).sort();
    expect(cantons).toEqual(['Grigioni', 'Ticino', 'Vallese']);
  });

  it('every entry has a valid status (cantons move out of "unverified" as Fase 0 verifies each source)', () => {
    const validStatuses = ['unverified', 'active', 'blocked', 'degraded'];
    for (const [key, entry] of Object.entries(registry.sources)) {
      expect(validStatuses, `${key} status "${entry.status}" should be a known value`).toContain(entry.status);
    }
  });

  it('vallese is verified and active (#6358: eCari public "Enchères en cours" table, scrapable)', () => {
    expect(registry.sources.vallese.status).toBe('active');
    expect(registry.sources.vallese.accessMethod).toBe('html-scrape');
  });

  it('rejects an entry missing a required field', () => {
    const incomplete = { ...registry.sources.ticino, owner: '' };
    const errors = validatePlateAuctionSourceEntry('ticino', incomplete);
    expect(errors.some((e) => e.includes('owner'))).toBe(true);
  });

  it('rejects an entry with an invalid status', () => {
    const invalid = { ...registry.sources.ticino, status: 'bogus' };
    const errors = validatePlateAuctionSourceEntry('ticino', invalid);
    expect(errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('rejects a registry with no sources', () => {
    const errors = validatePlateAuctionSourcesRegistry({ generatedAt: '2026-08-27T00:00:00.000Z', sources: {} });
    expect(errors.some((e) => e.includes('no entries'))).toBe(true);
  });
});
