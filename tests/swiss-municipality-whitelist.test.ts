import { describe, it, expect } from 'vitest';
import {
  isKnownSwissCity,
  isCantonOnlyLabel,
  findSwissCityInText,
  isKnownSwissMunicipality,
} from '../scripts/lib/target-swiss-locations.mjs';

describe('Swiss municipality whitelist (BFS)', () => {
  describe('isKnownSwissCity', () => {
    it('accepts real Swiss municipalities', () => {
      expect(isKnownSwissCity('Mendrisio')).toBe(true);
      expect(isKnownSwissCity('Lugano')).toBe(true);
      expect(isKnownSwissCity('Bellinzona')).toBe(true);
      expect(isKnownSwissCity('Zürich')).toBe(true);
      expect(isKnownSwissCity('Genève')).toBe(true);
      expect(isKnownSwissCity('La Chaux-de-Fonds')).toBe(true);
    });

    it('rejects canton names (canton-only labels)', () => {
      // Strict variant must NOT accept canton labels — that is the whole
      // point: "Ticino" alone is a misclassification signal.
      expect(isKnownSwissCity('Ticino')).toBe(false);
      expect(isKnownSwissCity('Tessin')).toBe(false);
      expect(isKnownSwissCity('Graubünden')).toBe(false);
      expect(isKnownSwissCity('TI')).toBe(false);
    });

    it('rejects foreign cities', () => {
      expect(isKnownSwissCity('Forte dei Marmi')).toBe(false);
      expect(isKnownSwissCity('Milano')).toBe(false);
      expect(isKnownSwissCity('Modena')).toBe(false);
      expect(isKnownSwissCity('Paris')).toBe(false);
    });

    it('handles empty / null input', () => {
      expect(isKnownSwissCity('')).toBe(false);
      expect(isKnownSwissCity(null as unknown as string)).toBe(false);
      expect(isKnownSwissCity(undefined as unknown as string)).toBe(false);
    });
  });

  describe('isKnownSwissMunicipality (loose — includes canton names)', () => {
    it('accepts both cities and canton names', () => {
      expect(isKnownSwissMunicipality('Lugano')).toBe(true);
      expect(isKnownSwissMunicipality('Ticino')).toBe(true);
      expect(isKnownSwissMunicipality('TI')).toBe(false); // 2-letter codes not in canton-name set
    });
  });

  describe('isCantonOnlyLabel', () => {
    it('detects canton names in 4 languages', () => {
      expect(isCantonOnlyLabel('Ticino')).toBe(true);
      expect(isCantonOnlyLabel('Tessin')).toBe(true);
      expect(isCantonOnlyLabel('Graubünden')).toBe(true);
      expect(isCantonOnlyLabel('Grigioni')).toBe(true);
      expect(isCantonOnlyLabel('Vaud')).toBe(true);
    });

    it('detects canton 2-letter codes', () => {
      expect(isCantonOnlyLabel('TI')).toBe(true);
      expect(isCantonOnlyLabel('GR')).toBe(true);
      expect(isCantonOnlyLabel('ZH')).toBe(true);
    });

    it('does NOT match cities', () => {
      expect(isCantonOnlyLabel('Mendrisio')).toBe(false);
      expect(isCantonOnlyLabel('Lengnau')).toBe(false);
      expect(isCantonOnlyLabel('Bellinzona')).toBe(false);
    });
  });

  describe('findSwissCityInText', () => {
    it('finds explicit Swiss cities in description text', () => {
      expect(findSwissCityInText('We are based in Mendrisio, Ticino.')).toBe('mendrisio');
      expect(findSwissCityInText('Multi-site role: Bern and Zürich.')).toBeTruthy();
    });

    it('does NOT match if no Swiss city present', () => {
      expect(findSwissCityInText('We sell watches in Forte dei Marmi, Tuscany, Italy.')).toBe('');
    });

    it('returns false-positive for short common words (caller must guard)', () => {
      // "Sales" is a real FR canton commune. Caller should require length >= 4
      // to reject; this assertion documents the known limitation.
      expect(findSwissCityInText('Sales Assistant role')).toBe('sales');
    });
  });
});
