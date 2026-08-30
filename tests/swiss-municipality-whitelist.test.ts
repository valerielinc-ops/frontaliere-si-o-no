import { describe, it, expect } from 'vitest';
import {
  isKnownSwissCity,
  isCantonOnlyLabel,
  findSwissCityInText,
  isKnownSwissMunicipality,
  normalizeSwissTargetLocationText,
} from '../scripts/lib/target-swiss-locations.mjs';
import MUNICIPALITY_DATA from '../data/canton-municipalities.json' with { type: 'json' };

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

    it('does NOT match a real city even when it also appears in a canton\'s alias list (#4570)', () => {
      // SWISS_CANTONS[BL].names includes "allschwil"/"muttenz" as keyword
      // aliases (to strengthen fuzzy canton-name detection in free text),
      // but a real, precise municipality match must never be downgraded to
      // a canton-only label — that would make a genuine city signal look
      // as weak as a bare canton name and break any caller that trusts
      // isCantonOnlyLabel to gate "needs more evidence" logic.
      expect(isCantonOnlyLabel('Allschwil')).toBe(false);
      expect(isCantonOnlyLabel('Muttenz')).toBe(false);
      expect(isCantonOnlyLabel('Herisau')).toBe(false);
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

    it('does NOT match common job-prose words that collide with tiny communes', () => {
      // "Sales" (Sâles, FR), "concise" (Concise, VD) and "court" (Court, BE) are
      // real but tiny communes whose accent-stripped names are common words in
      // ordinary job prose. They are excluded from the city-token sets
      // (AMBIGUOUS_LOCATION_WORD_TOKENS) so a retail listing no longer reads as
      // Swiss — the Swatch Group US-jobs leak (2026-06-17).
      expect(findSwissCityInText('Sales Assistant role')).toBe('');
      expect(findSwissCityInText('a concise summary of duties')).toBe('');
      expect(findSwissCityInText('basketball court maintenance')).toBe('');
    });
  });

  describe('getCantonScopedBareTokens intra-canton collision (#6621)', () => {
    it('has zero BFS municipalities sharing a disambiguated bare name within the same canton', () => {
      // `getCantonScopedBareTokens` (target-swiss-locations.mjs) keys a Set by
      // the bare (parenthetical-stripped) form of every "<City> (XX)" BFS
      // entry, scoped per canton. If two DIFFERENT municipalities in the SAME
      // canton ever shared a bare name, the Set could not tell them apart and
      // the ambiguous token is excluded rather than silently resolved to
      // either one (see the guard in getCantonScopedBareTokens). This test
      // pins the current BFS snapshot as collision-free across all cantons —
      // a future data refresh that introduces a collision fails here instead
      // of silently degrading structured-data locality resolution.
      const collisions: string[] = [];

      for (const [code, entry] of Object.entries(
        MUNICIPALITY_DATA.cantons as Record<string, { municipalities?: string[]; aliases?: string[] }>,
      )) {
        const all = [...new Set([...(entry.municipalities || []), ...(entry.aliases || [])])];
        const sourcesByToken = new Map<string, Set<string>>();
        for (const city of all) {
          const disambiguated = city.match(/^(.+?)\s*\([a-z]{2}\)$/i);
          if (!disambiguated) continue;
          const bareToken = normalizeSwissTargetLocationText(disambiguated[1]);
          if (!bareToken) continue;
          if (!sourcesByToken.has(bareToken)) sourcesByToken.set(bareToken, new Set());
          sourcesByToken.get(bareToken)!.add(city);
        }
        for (const [token, sources] of sourcesByToken) {
          if (sources.size > 1) collisions.push(`${code}:${token} -> ${[...sources].join(', ')}`);
        }
      }

      expect(collisions).toEqual([]);
    });
  });
});
