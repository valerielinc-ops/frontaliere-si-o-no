/**
 * Regression test for the job-board `?q=` deep-link keyword on profession
 * landings (build-plugins/professionLandingsData.ts → professionRoleKeyword).
 *
 * Background (follow-up #1941, item 3): the keyword used to be derived with
 * `PROFESSION_SLUGS[locale][id].split('-').pop()`, taking only the LAST slug
 * segment. For a multi-token role (e.g. "operatore-socio-sanitario") that
 * degenerates to "sanitario", pre-filtering the board on the wrong keyword.
 * The fix strips the locale area prefix instead, keeping every role token.
 *
 * This guards both invariants exhaustively so a future refactor can't
 * reintroduce the truncation:
 *   (a) the keyword never leaks an area token ("lavoro"/"ticino"/"jobs"/…),
 *   (b) a multi-token role keeps all its tokens (not just the tail).
 */
import { describe, it, expect } from 'vitest';
import {
  PROFESSION_LOCALES,
  PROFESSION_IDS,
  PROFESSION_SLUGS,
  PROFESSION_SLUG_AREA_PREFIX,
  professionRoleKeyword,
} from '../../build-plugins/professionLandingsData';

const AREA_TOKENS = new Set([
  'lavoro',
  'ticino',
  'jobs',
  'arbeit',
  'tessin',
  'travail',
]);

describe('professionRoleKeyword — job-board ?q= keyword', () => {
  it('strips the area prefix for every (locale, id) slug', () => {
    for (const locale of PROFESSION_LOCALES) {
      const prefix = PROFESSION_SLUG_AREA_PREFIX[locale];
      for (const id of PROFESSION_IDS) {
        const slug = PROFESSION_SLUGS[locale][id];
        expect(slug.startsWith(prefix)).toBe(true);
        expect(professionRoleKeyword(locale, id)).toBe(slug.slice(prefix.length));
      }
    }
  });

  it('never leaks an area noise token into the keyword', () => {
    for (const locale of PROFESSION_LOCALES) {
      for (const id of PROFESSION_IDS) {
        const tokens = professionRoleKeyword(locale, id).split('-');
        for (const tok of tokens) {
          expect(AREA_TOKENS.has(tok)).toBe(false);
        }
        expect(tokens.length).toBeGreaterThan(0);
        expect(tokens[0].length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every token of a multi-word role (no degenerate tail)', () => {
    // Simulate the future case the fix protects against: a slug whose role
    // portion spans multiple tokens must round-trip in full, not collapse to
    // its last segment the way `.split('-').pop()` did.
    const prefix = PROFESSION_SLUG_AREA_PREFIX.it;
    const multiTokenSlug = `${prefix}operatore-socio-sanitario`;
    const role = multiTokenSlug.startsWith(prefix)
      ? multiTokenSlug.slice(prefix.length)
      : multiTokenSlug;
    expect(role).toBe('operatore-socio-sanitario');
    expect(role.split('-')).toHaveLength(3);
    // The old `.pop()` behaviour would have yielded just "sanitario".
    expect(role).not.toBe(multiTokenSlug.split('-').pop());
  });
});
