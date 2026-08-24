import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildTitleWithBrand,
  clampMetaDescription,
  TITLE_MAX_CHARS,
  META_DESCRIPTION_MAX_CHARS,
} from '../../build-plugins/shared/titleSuffix';
import { buildProfessionLandingCopy } from '../../build-plugins/professionLandingsCopy';
import { PROFESSION_IDS, PROFESSION_LOCALES } from '../../build-plugins/professionLandingsData';
import { CAREER_LANDING_COPY } from '../../build-plugins/careerLandingsCopy';
import { CAREER_LANDING_IDS, CAREER_LOCALES } from '../../build-plugins/careerLandingsData';

/**
 * SERP snippet budgets for the hand-authored landing families.
 *
 * These pages are emitted by build plugins that pull `data/`, so they cannot be
 * rendered in a sparse worktree. The *copy* modules are pure, though, so the
 * strings that become `<title>` and `<meta name="description">` can be checked
 * directly — which is where the defects this file guards actually lived.
 *
 * The regression being pinned: a description longer than
 * `META_DESCRIPTION_MAX_CHARS` is not an error anywhere in the pipeline. It is
 * silently truncated by `clampMetaDescription` with a trailing ellipsis, so the
 * tail of the sentence never reaches a search result. Both `/lavoro-ticino-
 * autista/` (186 chars) and `/concorsi-pubblici-lugano/` (243 chars) shipped
 * that way, and in both cases the part that got cut was the freshness signal
 * the copy was written to carry. Nothing failed; the snippet was just worse.
 */

/** `clampMetaDescription` is lossless exactly when the input already fits. */
function isTruncated(description: string): boolean {
  return clampMetaDescription(description) !== description;
}

describe('SERP snippet budgets — profession landings', () => {
  // Zero exercises the countless branch; the others exercise the counted one
  // across 1-, 2- and 3-digit counts, which is where a title grows.
  const COUNTS = [0, 1, 19, 999];

  for (const locale of PROFESSION_LOCALES) {
    for (const id of PROFESSION_IDS) {
      for (const liveCount of COUNTS) {
        it(`${locale}/${id} @ ${liveCount} openings fits both budgets`, () => {
          const copy = buildProfessionLandingCopy(locale, id, {
            liveCount,
            fresh30Count: 0,
          });

          // `buildTitleWithBrand` drops the brand rather than truncating, so
          // the bare headline is what has to fit — otherwise the page becomes
          // an `audit:title-length` offender.
          expect(copy.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
          expect(buildTitleWithBrand(copy.title).length).toBeLessThanOrEqual(
            TITLE_MAX_CHARS,
          );

          expect(copy.description.length).toBeLessThanOrEqual(
            META_DESCRIPTION_MAX_CHARS,
          );
          expect(isTruncated(copy.description)).toBe(false);

          // A guide-shaped title and an h1 that are the same string trip
          // `audit:h1-title-duplicates` (baseline 0).
          expect(copy.title).not.toBe(copy.h1);
        });
      }
    }
  }

  it('never advertises a count when there are no live openings (#5365)', () => {
    for (const locale of PROFESSION_LOCALES) {
      const copy = buildProfessionLandingCopy(locale, 'autista', {
        liveCount: 0,
        fresh30Count: 0,
      });
      expect(copy.title).not.toMatch(/(^|\D)0(\D|$)/);
      expect(copy.description).not.toMatch(/(^|\D)0 /);
    }
  });
});

/**
 * Career-landing descriptions that are still over budget and therefore still
 * shipping a truncated SERP snippet. This PR rewrote `it/concorsi-pubblici-
 * lugano` only; the other fifteen are pre-existing and each needs its own
 * translated rewrite.
 *
 * This is a ratchet, asserted for equality rather than as a permissive
 * allowlist: adding a new over-budget description fails, and fixing one of
 * these fails too until it is removed from the list. That way the set can only
 * shrink.
 */
const KNOWN_TRUNCATED_CAREER_DESCRIPTIONS: ReadonlySet<string> = new Set([
  'it/agenzie-lavoro-lugano',
  'it/stage-lugano',
  'it/contratti-lavoro-frontalieri',
  'en/agenzie-lavoro-lugano',
  'en/concorsi-pubblici-lugano',
  'en/stage-lugano',
  'en/contratti-lavoro-frontalieri',
  'de/agenzie-lavoro-lugano',
  'de/concorsi-pubblici-lugano',
  'de/stage-lugano',
  'de/contratti-lavoro-frontalieri',
  'fr/agenzie-lavoro-lugano',
  'fr/concorsi-pubblici-lugano',
  'fr/stage-lugano',
  'fr/contratti-lavoro-frontalieri',
]);

describe('SERP snippet budgets — career landings', () => {
  for (const locale of CAREER_LOCALES) {
    for (const id of CAREER_LANDING_IDS) {
      it(`${locale}/${id} fits the title budget`, () => {
        const copy = CAREER_LANDING_COPY[locale][id];
        expect(copy.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
        expect(buildTitleWithBrand(copy.title).length).toBeLessThanOrEqual(
          TITLE_MAX_CHARS,
        );
        expect(copy.title).not.toBe(copy.h1);
      });
    }
  }

  it('the set of truncated descriptions only ever shrinks', () => {
    const offenders = new Set<string>();
    for (const locale of CAREER_LOCALES) {
      for (const id of CAREER_LANDING_IDS) {
        const copy = CAREER_LANDING_COPY[locale][id];
        if (isTruncated(copy.description)) offenders.add(`${locale}/${id}`);
      }
    }
    expect([...offenders].sort()).toEqual(
      [...KNOWN_TRUNCATED_CAREER_DESCRIPTIONS].sort(),
    );
  });

  it('the page this PR rewrote is not truncated', () => {
    const copy = CAREER_LANDING_COPY.it['concorsi-pubblici-lugano'];
    expect(copy.description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
    expect(isTruncated(copy.description)).toBe(false);
  });

  it('names Lugano on the Lugano-slugged landings', () => {
    // /concorsi-pubblici-lugano/ ranked at position 7,1 for "concorsi lugano"
    // with a title that said only "Ticino": the search term never appeared in
    // the result. Any landing whose slug is Lugano-specific must say so.
    for (const id of ['concorsi-pubblici-lugano', 'agenzie-lavoro-lugano', 'stage-lugano'] as const) {
      expect(CAREER_LANDING_COPY.it[id].title).toMatch(/Lugano/i);
    }
  });
});

describe('fuel daily pages — Italian copy regressions', () => {
  // The fuel plugin imports `data/`, so it cannot be imported in a sparse
  // worktree (it would be red locally and green in CI, which is worse than no
  // test). Scan the source instead — these are template literals, so the
  // defect is visible without evaluating them.
  const source = readFileSync(
    fileURLToPath(new URL('../../build-plugins/fuelDailyPagesPlugin.ts', import.meta.url)),
    'utf8',
  );

  it('feeds the intro a locative phrase, not a bare zone label', () => {
    // `regionalLabel` is "Tutto il Ticino", so an `a ${z}` template rendered
    // "a Tutto il Ticino" on every Italian regional page. All four intro
    // templates now take the complete locative from `fuelWhere()`.
    // (`zoneH1` legitimately keeps `a ${z}`: it only ever receives a city.)
    const introSignatures = source.match(/intro: \(f, where, priceFmt, date\) =>/g) ?? [];
    expect(introSignatures).toHaveLength(4);
    expect(source).toMatch(/function fuelWhere/);
    expect(source).not.toMatch(/oggi a \$\{zoneLabel\}/);
  });

  it('agrees the Italian article with the fuel noun everywhere', () => {
    // "benzina" is feminine, "diesel" masculine: the hard-coded
    // `del ${fuel}` produced "del benzina" on every Italian benzina page,
    // across the today, station and city families alike.
    expect(source).not.toMatch(/\bdel \$\{f\.toLowerCase\(\)\}/);
    expect(source).toMatch(/function itFuelGenitive/);
  });

  it('does not leave English "Swiss" in the Italian intro', () => {
    const itIntro = source.match(/intro: \(f, where, priceFmt, date\) =>\s*\n\s*`Prezzo medio[^`]*`/);
    expect(itIntro).not.toBeNull();
    expect(itIntro?.[0]).not.toMatch(/\bSwiss\b/);
  });

  it('keeps the ISO date stamp for schema.org and a display date for prose', () => {
    // `dateModified` must stay ISO; only human-facing copy gets dd.MM.yyyy.
    expect(source).toMatch(/dateModified: dateStamp/);
    expect(source).toMatch(/function formatFuelDateDisplay/);
  });
});
