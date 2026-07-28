/**
 * Regression coverage for issue #4890: two border crossings —
 * 'Widnau-Lustenau (Wiesenrain)' and 'Widnau-Lustenau (Schmitterbrücke)' —
 * both collapsed to the same slug ("widnau-lustenau") because the general
 * slugify rule in services/borderCrossingSlug.ts strips parenthetical
 * content. Every slug-keyed structure (data/border-wait-current.json,
 * data/border-wait-averages.json, data/border-wait-history/*.json, runtime
 * maps) silently let one crossing's data overwrite the other's.
 *
 * The fix is an explicit per-name override in slugifyCrossingName(), not a
 * change to the general rule — 5 crossings (incl. the primary Chiasso Centro
 * one) have live, indexed /traffico-dogane/{slug}/oggi/ pages whose URL
 * depends on parens being stripped by the general rule.
 *
 * This test:
 *  1. Re-derives the expected slug for every crossing in the dataset from an
 *     independent copy of the *general* rule (not by importing/calling
 *     slugifyCrossingName for the "expected" side), so a future accidental
 *     change to the general regex is caught here too, not only by the
 *     function testing itself. The one known override is applied on top.
 *  2. Explicitly pins the 5 public, indexed slugs so they can never move.
 *  3. Asserts the full dataset produces zero duplicate slugs.
 *  4. Proves the duplicate-detection mechanism itself actually catches a
 *     collision, using a synthetic crossing name engineered to collide the
 *     same way the original bug happened — this is what stops the defect
 *     class from recurring when new crossings are added.
 */

import { describe, expect, it } from 'vitest';
import { borderCrossings } from '../data/borderCrossings';
import { slugifyCrossingName } from '../services/borderCrossingSlug';

// Independent re-implementation of the *general* slugify rule only (no
// override lookup) — deliberately not imported from services/borderCrossingSlug.ts,
// so this test doesn't just check the production function against itself.
function generalSlugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// The one known, intentional exception: production overrides this exact name
// so it no longer collides with 'Widnau-Lustenau (Wiesenrain)', which keeps
// the slug the general rule would produce unchanged.
const KNOWN_OVERRIDES: Readonly<Record<string, string>> = {
  'Widnau-Lustenau (Schmitterbrücke)': 'widnau-lustenau-schmitterbrucke',
};

// The 5 crossings with a live, indexed /traffico-dogane/{slug}/oggi/ page
// (see build-plugins/borderWaitData.ts#BORDER_WAIT_CROSSINGS) — their slug
// must never move, or the already-indexed URL breaks.
const PUBLIC_SLUGS: Readonly<Record<string, string>> = {
  'Chiasso Centro (Ponte Chiasso)': 'chiasso-centro',
  'Gaggiolo (Cantello-Stabio)': 'gaggiolo',
  'San Pietro (Clivio-Stabio)': 'san-pietro',
  'Piaggio Valmara (Cannobio-Brissago)': 'piaggio-valmara',
  'Camedo (Re-Centovalli)': 'camedo',
};

/** Returns every slug that appears more than once in `names`. */
function findDuplicateSlugs(names: readonly string[]): string[] {
  const slugs = names.map(slugifyCrossingName);
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const s of slugs) {
    if (seen.has(s)) dupes.push(s);
    seen.add(s);
  }
  return dupes;
}

describe('slugifyCrossingName — issue #4890 collision fix', () => {
  it('produces the expected slug for every crossing in the dataset', () => {
    expect(borderCrossings.length).toBeGreaterThan(0);
    for (const c of borderCrossings) {
      const expected = KNOWN_OVERRIDES[c.name] ?? generalSlugify(c.name);
      expect(slugifyCrossingName(c.name), `slug for "${c.name}"`).toBe(expected);
    }
  });

  it('keeps the 5 public /traffico-dogane/{slug}/oggi/ URLs unchanged', () => {
    for (const [name, expectedSlug] of Object.entries(PUBLIC_SLUGS)) {
      // Sanity: these names must still exist verbatim in the dataset, else
      // the assertion below would silently test a name nobody ships.
      expect(
        borderCrossings.some(c => c.name === name),
        `"${name}" is expected to exist in data/borderCrossings.ts`
      ).toBe(true);
      expect(slugifyCrossingName(name), `public slug for "${name}"`).toBe(expectedSlug);
    }
  });

  it('has no duplicate slugs across the full dataset', () => {
    const dupes = findDuplicateSlugs(borderCrossings.map(c => c.name));
    expect(dupes, `duplicate slug(s): ${dupes.join(', ')}`).toEqual([]);
  });

  it('the Widnau-Lustenau pair no longer collides', () => {
    const wiesenrain = slugifyCrossingName('Widnau-Lustenau (Wiesenrain)');
    const schmitterbruecke = slugifyCrossingName('Widnau-Lustenau (Schmitterbrücke)');
    expect(wiesenrain).toBe('widnau-lustenau');
    expect(schmitterbruecke).toBe('widnau-lustenau-schmitterbrucke');
    expect(wiesenrain).not.toBe(schmitterbruecke);
  });

  it('detects a collision if a fictitious crossing is introduced (defect-class regression guard)', () => {
    // Engineered the same way the original bug happened: a parenthetical
    // suffix that the general rule strips, landing on an already-used slug.
    const fictitiousCollidingName = 'Chiasso Centro (Nuovo Ingresso Fittizio)';
    expect(slugifyCrossingName(fictitiousCollidingName)).toBe('chiasso-centro');

    const namesWithIntruder = [...borderCrossings.map(c => c.name), fictitiousCollidingName];
    const dupes = findDuplicateSlugs(namesWithIntruder);
    expect(dupes).toContain('chiasso-centro');

    // Control: without the intruder, the same detector reports zero dupes —
    // proves the failure above comes from the intruder, not a broken detector.
    expect(findDuplicateSlugs(borderCrossings.map(c => c.name))).toEqual([]);
  });
});

/**
 * The override table exists in two places: services/borderCrossingSlug.ts (app
 * layer) and functions/src/borderCrossingsData.js (Firebase Functions, which
 * writes the Firestore/snapshot keys). They cannot share a module — the
 * Functions bundle lives outside the Vite tree — so they are kept identical by
 * hand, exactly the fragility that produced #4890 in the first place.
 *
 * PR #4898's reviewer flagged this: an override added to only one side would
 * silently reproduce the collision for that crossing's Firestore-side data,
 * with no failing test. These cases close that gap by comparing the two
 * implementations' OUTPUT over the whole dataset, so any divergence — a missing
 * override, a reworded general rule, a stray character — fails here.
 */
describe('slug parity across the Functions bundler boundary (#4898 review)', () => {
  it('both implementations agree on every crossing in the dataset', async () => {
    const { slugifyCrossingName: functionsSlugify } = await import(
      '../functions/src/borderCrossingsData.js'
    );

    const divergences = borderCrossings
      .map((crossing) => ({
        name: crossing.name,
        app: slugifyCrossingName(crossing.name),
        functions: functionsSlugify(crossing.name),
      }))
      .filter((row) => row.app !== row.functions);

    expect(
      divergences,
      divergences.map((d) => `${d.name}: app="${d.app}" functions="${d.functions}"`).join('; '),
    ).toEqual([]);
  });

  it('both implementations carry the same override for the disambiguated crossing', async () => {
    const { slugifyCrossingName: functionsSlugify } = await import(
      '../functions/src/borderCrossingsData.js'
    );

    // If either side loses the override, this drops back to the colliding slug.
    expect(functionsSlugify('Widnau-Lustenau (Schmitterbrücke)')).toBe(
      'widnau-lustenau-schmitterbrucke',
    );
    expect(functionsSlugify('Widnau-Lustenau (Schmitterbrücke)')).toBe(
      slugifyCrossingName('Widnau-Lustenau (Schmitterbrücke)'),
    );
  });

  it('agrees on names outside the dataset too, including override-free parentheticals', async () => {
    const { slugifyCrossingName: functionsSlugify } = await import(
      '../functions/src/borderCrossingsData.js'
    );

    // Covers the general rule itself, not just the override branch: accents,
    // parentheses, punctuation runs and leading/trailing separators.
    for (const probe of [
      'Chiasso Centro (Ponte Chiasso)',
      'Sankt Margrethen — Höchst (Alte Rheinbrücke)',
      '  Zürich/Rafz -- Lottstetten  ',
      'Col-des-Roches (Col France)',
    ]) {
      expect(functionsSlugify(probe), `probe: ${probe}`).toBe(slugifyCrossingName(probe));
    }
  });
});
