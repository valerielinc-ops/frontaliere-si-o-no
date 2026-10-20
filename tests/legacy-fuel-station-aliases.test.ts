import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveFuelStation } from '../scripts/lib/fuel-station-aliases.mjs';

type Alias = {
  orphanPath: string;
  locale: string;
  kind: string;
  canonicalPath: string;
  cohort: string;
};

const snapshot = JSON.parse(readFileSync(new URL('../data/legacy-aliases.json', import.meta.url), 'utf8')) as {
  counts: Record<string, number>;
  aliases: Alias[];
};

describe('legacy fuel-station aliases', () => {
  it('keeps every stored station alias aligned with the deterministic resolver', () => {
    const aliases = snapshot.aliases.filter((alias) => alias.cohort === 'fuelStation');
    expect(snapshot.counts.fuelStation).toBe(aliases.length);

    for (const alias of aliases) {
      expect(resolveFuelStation(alias.orphanPath)).toEqual({
        kind: 'matched',
        locale: alias.locale,
        canonicalPath: alias.canonicalPath,
      });
    }
  });

  // The archived SOCAR was at Via San Gottardo 17; the currently listed
  // Piccadilly is at number 104. Preserve both old URLs without conflating them.
  const historicalRoutes: Array<{ orphanPath: string; canonicalPath: string; locale: 'it' | 'fr' }> = [
    {
      orphanPath: '/prezzi-benzina/bellinzona/stazioni/socar-via-san-gottardo/',
      canonicalPath: '/prezzi-benzina/bellinzona/oggi/',
      locale: 'it',
    },
    {
      orphanPath: '/fr/prix-essence-suisse/bellinzona/stations/socar-via-san-gottardo/',
      canonicalPath: '/fr/prix-essence-suisse/bellinzona/aujourd-hui/',
      locale: 'fr',
    },
  ];

  for (const { orphanPath, canonicalPath, locale } of historicalRoutes) {
    it(`keeps ${locale} ${orphanPath} distinct from a similarly named active station`, () => {
      expect(resolveFuelStation(orphanPath)).toEqual({ kind: 'matched', locale, canonicalPath });
      expect(snapshot.aliases).toContainEqual({
        orphanPath,
        locale,
        kind: 'matched',
        canonicalPath,
        cohort: 'fuelStation',
      });
    });
  }
  it('uses the current localized daily page for newly seen station orphans', () => {
    expect(resolveFuelStation('/prezzi-benzina/locarno/stazioni/unlisted-old-station/')).toEqual({
      kind: 'matched',
      locale: 'it',
      canonicalPath: '/prezzi-benzina/locarno/oggi/',
    });
  });

  const localizedRouteCases: Array<{ orphanPath: string; locale: string; canonicalPath: string }> = [
    {
      orphanPath: '/en/diesel-price-switzerland/bellinzona/stations/old/',
      locale: 'en',
      canonicalPath: '/en/diesel-price-switzerland/bellinzona/today/',
    },
    {
      orphanPath: '/de/dieselpreis-schweiz/bellinzona/tankstellen/old/',
      locale: 'de',
      canonicalPath: '/de/dieselpreis-schweiz/bellinzona/heute/',
    },
    {
      orphanPath: '/fr/prix-gasoil-suisse/bellinzona/stations/old/',
      locale: 'fr',
      canonicalPath: '/fr/prix-gasoil-suisse/bellinzona/aujourd-hui/',
    },
    {
      orphanPath: '/fr/prix-diesel-suisse/bellinzona/stations/old/',
      locale: 'fr',
      canonicalPath: '/fr/prix-gasoil-suisse/bellinzona/aujourd-hui/',
    },
    {
      orphanPath: '/fuel-prices-switzerland/bellinzona/stations/old/',
      locale: 'en',
      canonicalPath: '/en/gasoline-price-switzerland/bellinzona/today/',
    },
    {
      orphanPath: '/prezzi-benzina-svizzera/bellinzona/stazioni/old/',
      locale: 'it',
      canonicalPath: '/prezzi-benzina/bellinzona/oggi/',
    },
    {
      orphanPath: '/prezzi-carburante-svizzera/bellinzona/stazioni/old/',
      locale: 'it',
      canonicalPath: '/prezzi-benzina/bellinzona/oggi/',
    },
    {
      orphanPath: '/de/benzinpreise-schweiz/bellinzona/tankstellen/old/',
      locale: 'de',
      canonicalPath: '/de/benzinpreis-schweiz/bellinzona/heute/',
    },
  ];

  for (const { orphanPath, canonicalPath, locale } of localizedRouteCases) {
    it(`uses the live ${locale} daily page for ${orphanPath}`, () => {
      expect(resolveFuelStation(orphanPath)).toEqual({ kind: 'matched', locale, canonicalPath });
    });
  }

  it('does not claim non-station paths', () => {
    expect(resolveFuelStation('/prezzi-benzina/bellinzona/')).toBeNull();
  });
});
