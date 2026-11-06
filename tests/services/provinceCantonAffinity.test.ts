/**
 * Unit tests for `services/provinceCantonAffinity.ts`.
 *
 * Locks in the explicit province→canton affinity table: mapped border
 * provinces resolve to their commuting canton(s), inland provinces with no
 * reliable single-canton pattern (BG, BS, MB, TN) intentionally resolve to
 * an empty array rather than a guessed affinity.
 */

import { describe, it, expect } from 'vitest';
import { provinceToCantons, municipalityToCantons } from '@/services/provinceCantonAffinity';

describe('provinceToCantons', () => {
  it.each([
    ['CO', ['TI']],
    ['VA', ['TI']],
    ['VB', ['TI', 'VS']],
    ['SO', ['GR']],
    ['BZ', ['GR']],
    ['AO', ['VS']],
    ['VC', ['VS']],
  ])('maps province %s to %j', (province, expected) => {
    expect(provinceToCantons(province)).toEqual(expected);
  });

  it.each(['BG', 'BS', 'MB', 'TN'])('returns empty array for inland province %s (no fabricated affinity)', (province) => {
    expect(provinceToCantons(province)).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(provinceToCantons('co')).toEqual(['TI']);
  });

  it('returns empty array for unknown province code', () => {
    expect(provinceToCantons('XX')).toEqual([]);
  });

  it.each([null, undefined, ''])('returns empty array for %p input', (input) => {
    expect(provinceToCantons(input)).toEqual([]);
  });

  it('returns a fresh array each call (no shared mutable reference)', () => {
    const a = provinceToCantons('CO');
    const b = provinceToCantons('CO');
    expect(a).not.toBe(b);
    a.push('ZZ');
    expect(provinceToCantons('CO')).toEqual(['TI']);
  });
});

describe('municipalityToCantons', () => {
  it('resolves a known municipality (plain name) to its province affinity', () => {
    expect(municipalityToCantons('Como')).toEqual(['TI']);
  });

  it('resolves a known municipality with "(PROVINCE)" suffix', () => {
    expect(municipalityToCantons('Como (CO)')).toEqual(['TI']);
  });

  it('returns empty array for an unknown municipality name', () => {
    expect(municipalityToCantons('Non Esiste Città Inventata')).toEqual([]);
  });

  it.each([null, undefined, ''])('returns empty array for %p input', (input) => {
    expect(municipalityToCantons(input)).toEqual([]);
  });
});
