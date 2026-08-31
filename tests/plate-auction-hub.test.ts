import { describe, it, expect } from 'vitest';
import { buildPlateAuctionHubPage } from '../build-plugins/plateAuctionHubPlugin';
import type { PlateAuctionSourcesRegistry } from '../services/plateAuctions/types';
import registry from '../data/plate-auction-sources-registry.json';

const UNVERIFIED_REGISTRY = registry as PlateAuctionSourcesRegistry;

describe('plateAuctionHubPlugin — /aste-targhe-svizzera/', () => {
  describe('current registry state (all cantons unverified)', () => {
    const { html, wordCount } = buildPlateAuctionHubPage(UNVERIFIED_REGISTRY);

    it('meets the thin-content floor', () => {
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('shows the "copertura in corso" section instead of fabricated auction data', () => {
      expect(html).toContain('Copertura in corso');
      expect(html).not.toContain('Più care attualmente');
      expect(html).not.toContain('Nuove aste');
    });

    it('lists every canton from the registry with its status and official link', () => {
      for (const entry of Object.values(UNVERIFIED_REGISTRY.sources)) {
        expect(html).toContain(entry.canton);
        expect(html).toContain(entry.officialUrl);
      }
    });

    it('emits BreadcrumbList JSON-LD (breadcrumb-coverage gate)', () => {
      expect(html).toContain('"@type":"BreadcrumbList"');
    });
  });

  it('hides "copertura in corso" and shows verification date once a canton goes active', () => {
    const active: PlateAuctionSourcesRegistry = {
      generatedAt: UNVERIFIED_REGISTRY.generatedAt,
      sources: {
        ...UNVERIFIED_REGISTRY.sources,
        ticino: {
          ...UNVERIFIED_REGISTRY.sources.ticino,
          status: 'active',
          lastVerifiedAt: '2026-08-30T00:00:00.000Z',
        } as PlateAuctionSourcesRegistry['sources'][string],
      },
    };
    const { html } = buildPlateAuctionHubPage(active);
    expect(html).not.toContain('Copertura in corso');
    expect(html).toContain('Ultima verifica');
  });
});
