import { describe, expect, it } from 'vitest';
import { resolveFuelStation } from '../scripts/lib/fuel-station-aliases.mjs';

describe('Italian fuel-station aliases', () => {
  it.each([
    [
      '/prezzi-benzina/italia/mandello-del-lario/stazioni/agip-eni-strada-statale-91/',
      '/prezzi-benzina/italia/mandello-del-lario/oggi/',
      'it',
    ],
    [
      '/en/diesel-price-switzerland/italy/mandello-del-lario/stations/itala-petroli-provinciale-72/',
      '/en/diesel-price-switzerland/italy/mandello-del-lario/today/',
      'en',
    ],
    [
      '/de/benzinpreis-schweiz/italien/mandello-del-lario/tankstellen/agip-eni-strada-statale-91/',
      '/de/benzinpreis-schweiz/italien/mandello-del-lario/heute/',
      'de',
    ],
    [
      '/fr/prix-essence-suisse/italie/mandello-del-lario/stations/agip-eni-strada-statale-91/',
      '/fr/prix-essence-suisse/italie/mandello-del-lario/aujourd-hui/',
      'fr',
    ],
  ])('maps %s to the city daily page', (orphanPath, canonicalPath, locale) => {
    expect(resolveFuelStation(orphanPath)).toEqual({
      kind: 'matched',
      locale,
      canonicalPath,
    });
  });

  it('does not reinterpret a non-localized Italy or station segment', () => {
    expect(resolveFuelStation('/en/diesel-price-switzerland/italia/como/stations/old/')).toBeNull();
    expect(resolveFuelStation('/de/benzinpreis-schweiz/italien/como/stations/old/')).toBeNull();
    expect(resolveFuelStation('/prezzi-benzina/italia/como/stations/old/')).toBeNull();
  });
});
