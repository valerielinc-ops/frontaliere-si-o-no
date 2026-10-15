/**
 * Unit tests for `services/cantonList.ts` — the locale-aware canton label
 * helper consumed by `JobAlertForm` and (potentially) any other UI that
 * needs to expose a multi-select over the 26 Swiss cantons.
 *
 * The helper reads from the same `data/canton-url-slugs.json` source of
 * truth that the URL router uses, so the assertions are pinned to a few
 * representative entries that should not drift.
 */

import { describe, it, expect } from 'vitest';
import {
  CANTON_CODES,
  getCantonLabel,
  listCantonOptions,
} from '@/services/cantonList';

describe('CANTON_CODES', () => {
  it('exposes the 26 Swiss cantons', () => {
    expect(CANTON_CODES).toHaveLength(26);
  });

  it('is sorted alphabetically by ISO code', () => {
    const sorted = [...CANTON_CODES].sort();
    expect([...CANTON_CODES]).toEqual(sorted);
  });

  it('includes the legacy core cantons (TI/GR/VS)', () => {
    expect(CANTON_CODES).toContain('TI');
    expect(CANTON_CODES).toContain('GR');
    expect(CANTON_CODES).toContain('VS');
  });
});

describe('getCantonLabel', () => {
  it('returns the Italian label for IT locale', () => {
    expect(getCantonLabel('TI', 'it')).toBe('Ticino');
    expect(getCantonLabel('ZH', 'it')).toBe('Zurigo');
    expect(getCantonLabel('GE', 'it')).toBe('Ginevra');
  });

  it('returns the German label for DE locale', () => {
    expect(getCantonLabel('TI', 'de')).toBe('Tessin');
    expect(getCantonLabel('GE', 'de')).toBe('Genf');
  });

  it('returns the French label for FR locale', () => {
    expect(getCantonLabel('TI', 'fr')).toBe('Tessin');
    expect(getCantonLabel('VD', 'fr')).toBe('Vaud');
  });

  it('returns the English label for EN locale', () => {
    expect(getCantonLabel('TI', 'en')).toBe('Ticino');
    expect(getCantonLabel('ZH', 'en')).toBe('Zurich');
  });

  it('preserves multi-segment slugs by re-casing each segment', () => {
    // "appenzello-interno" → "Appenzello Interno"
    expect(getCantonLabel('AI', 'it')).toBe('Appenzello Interno');
    // "basilea-campagna" → "Basilea Campagna"
    expect(getCantonLabel('BL', 'it')).toBe('Basilea Campagna');
  });

  it('falls back to the code when the canton is unknown', () => {
    expect(getCantonLabel('XX', 'it')).toBe('XX');
  });
});

describe('listCantonOptions', () => {
  it('returns all 26 cantons as {code, label} options', () => {
    const opts = listCantonOptions('it');
    expect(opts).toHaveLength(26);
    expect(opts[0]).toHaveProperty('code');
    expect(opts[0]).toHaveProperty('label');
  });

  it('sorts by the localised label (IT)', () => {
    const opts = listCantonOptions('it');
    const labels = opts.map((o) => o.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, 'it'));
    expect(labels).toEqual(sorted);
  });

  it('reorders entries when the locale changes the label spelling', () => {
    const it = listCantonOptions('it').map((o) => o.code);
    const fr = listCantonOptions('fr').map((o) => o.code);
    // The ordered sequences differ because labels translate (e.g. Ginevra vs
    // Genève) — sanity check that we're really locale-aware, not constant.
    expect(it).not.toEqual(fr);
  });
});
