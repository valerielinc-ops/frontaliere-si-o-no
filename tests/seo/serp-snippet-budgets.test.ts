import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildTitleWithBrand,
  clampMetaDescription,
  TITLE_MAX_CHARS,
  META_DESCRIPTION_MAX_CHARS,
} from '../../build-plugins/shared/titleSuffix';
import { clampSiteSuffix } from '../../build-plugins/shared/seoContentTokens';
import { buildProfessionLandingCopy } from '../../build-plugins/professionLandingsCopy';
import { PROFESSION_IDS, PROFESSION_LOCALES } from '../../build-plugins/professionLandingsData';
import { CAREER_LANDING_COPY } from '../../build-plugins/careerLandingsCopy';
import { CAREER_LANDING_IDS, CAREER_LOCALES } from '../../build-plugins/careerLandingsData';
import {
  introProse,
  LOCALES as EMPLOYER_LOCALES,
  type EmployerProfile,
  type CorpusJob,
} from '../../build-plugins/employerProfilePagesPlugin';

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

/**
 * True only when `clampMetaDescription` actually *drops* text.
 *
 * It does two things: collapse `\s+` to a single space, then word-aware
 * truncate. Comparing its output against the RAW input conflates the two — and
 * JS `\s` matches U+00A0 and U+202F, so any non-breaking space in the copy
 * reads as "truncated" even in a 94-char string with no ellipsis in sight.
 *
 * That is not hypothetical: `median.toLocaleString('fr-CH')` emits the group
 * separator chosen by the host ICU. macOS Node gives `62'000` (apostrophe),
 * the CI image gives `62 000` with U+202F — so the whole FR locale, every
 * profession, every opening count, failed in CI while passing locally. Only
 * `fr-CH` diverges; `it-CH`/`de-CH`/`en-CH` all use the apostrophe, which is
 * exactly why no other locale failed.
 *
 * Comparing against the normalized form isolates real truncation from
 * harmless whitespace normalization. The 160-char budget itself is unchanged
 * and still asserted separately.
 */
function isTruncated(description: string): boolean {
  const normalized = String(description).replace(/\s+/g, ' ').trim();
  return clampMetaDescription(description) !== normalized;
}

describe('isTruncated — host-ICU independence', () => {
  // Guards the confound that made this very file red in CI and green on
  // macOS: a non-breaking space must never be mistaken for a dropped tail.
  it.each([
    ['U+202F narrow no-break space (fr-CH group separator on some ICU)', ' '],
    ['U+00A0 no-break space', ' '],
  ])('does not report truncation for %s', (_label, space) => {
    const short = `Salaire moyen CHF 62${space}000 brut/an, CCT applicable.`;
    expect(short.length).toBeLessThan(META_DESCRIPTION_MAX_CHARS);
    expect(clampMetaDescription(short)).not.toContain('…');
    expect(isTruncated(short)).toBe(false);
  });

  it('still reports truncation when text is genuinely dropped', () => {
    const tooLong = `${'mot '.repeat(60)}fin.`;
    expect(tooLong.length).toBeGreaterThan(META_DESCRIPTION_MAX_CHARS);
    expect(isTruncated(tooLong)).toBe(true);
  });

  it('the FR median really is locale-formatted (the input to the confound)', () => {
    // Documents the moving part: whatever separator the host ICU picks, the
    // rendered description must still be within budget and untruncated.
    const rendered = buildProfessionLandingCopy('fr', 'autista', {
      liveCount: 19,
      fresh30Count: 0,
    }).description;
    expect(rendered).toMatch(/62.000/); // separator is host-dependent
    expect(isTruncated(rendered)).toBe(false);
  });
});

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

describe('SERP snippet budgets — career landings', () => {
  for (const locale of CAREER_LOCALES) {
    for (const id of CAREER_LANDING_IDS) {
      it(`${locale}/${id} fits both budgets`, () => {
        const copy = CAREER_LANDING_COPY[locale][id];

        expect(copy.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
        expect(buildTitleWithBrand(copy.title).length).toBeLessThanOrEqual(
          TITLE_MAX_CHARS,
        );

        // 15 of these 16 descriptions were over budget before this PR, so the
        // whole family was shipping truncated snippets.
        expect(copy.description.length).toBeLessThanOrEqual(
          META_DESCRIPTION_MAX_CHARS,
        );
        expect(isTruncated(copy.description)).toBe(false);

        expect(copy.title).not.toBe(copy.h1);
      });
    }
  }

  it('names Lugano on the Lugano-slugged landings', () => {
    // /concorsi-pubblici-lugano/ ranked at position 7,1 for "concorsi lugano"
    // with a title that said only "Ticino": the search term never appeared in
    // the result. Any landing whose slug is Lugano-specific must say so.
    for (const id of ['concorsi-pubblici-lugano', 'agenzie-lavoro-lugano', 'stage-lugano'] as const) {
      expect(CAREER_LANDING_COPY.it[id].title).toMatch(/Lugano/i);
    }
  });
});

describe('SERP snippet budgets — employer profile intro prose (#6417)', () => {
  // Adversarial follow-up to #6346's pre-cut removal: `introProse()` feeds
  // `clampMetaDescription` directly (employerProfilePagesPlugin.ts), but no
  // test ever sampled its ACTUAL output — only the mechanism (word-aware
  // clamp) was verified, never the content the ~1860 real company profiles
  // produce. This exercises the sentence assembly across the shapes that
  // stretch the description longest: max canton/city breakdown (the source
  // caps both arrays at 6 — see cantonsProse/citiesProse), salary + trend +
  // contract-mix + salary-range all present, worst case for hitting the
  // 160-char budget.
  const CANTONS = ['Ticino', 'Zurigo', 'Berna', 'Vaud', 'Ginevra', 'Basilea']
    .map((name, i) => ({ name, count: 12 - i }));
  const CITIES = ['Lugano', 'Bellinzona', 'Chiasso', 'Locarno', 'Mendrisio', 'Massagno']
    .map((name, i) => ({ name, count: 8 - i }));

  function jobsFixture(): CorpusJob[] {
    return [
      { contract: 'full-time', salaryMin: 52000, salaryMax: 68000 },
      { contract: 'full-time', salaryMin: 55000, salaryMax: 71000 },
      { contract: 'part-time', salaryMin: 30000, salaryMax: 42000 },
    ];
  }

  const PROFILES: Record<string, Omit<EmployerProfile, 'slug'>> = {
    minimal: {
      name: 'Piccola SA',
      activeJobs: 1,
      cantons: [{ name: 'Ticino', count: 1 }],
      cities: [{ name: 'Lugano', count: 1 }],
    },
    maximal: {
      // A real, longer legal name — the shape most likely to push the
      // assembled sentence past the budget once every optional clause fires.
      name: 'Ente Ospedaliero Cantonale — Amministrazione e Servizi Centrali',
      activeJobs: 47,
      cantons: CANTONS,
      cities: CITIES,
      salaryMedianChf: 64000,
      salarySamples: 40,
      trend: { added: 9, removed: 3, net: 6, windowDays: 30 },
    },
  };

  for (const locale of EMPLOYER_LOCALES) {
    for (const [shape, profile] of Object.entries(PROFILES)) {
      it(`${locale}/${shape} profile clamps to a natural word boundary`, () => {
        const jobs = shape === 'maximal' ? jobsFixture() : [];
        const description = introProse({ slug: 'test', ...profile }, jobs, locale);
        expect(description.length).toBeGreaterThan(0);

        const clamped = clampMetaDescription(description);
        expect(clamped.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);

        if (isTruncated(description)) {
          // Cut for real: must end on the ellipsis, never mid-word — the
          // exact boundary the reviewer flagged as unverified.
          expect(clamped.endsWith('…')).toBe(true);
          expect(clamped).not.toMatch(/\s…$/); // no dangling space before the ellipsis
        } else {
          expect(clamped).toBe(description.replace(/\s+/g, ' ').trim());
        }

        // A clamp that survives should still carry substance, not just the
        // opening clause + ellipsis — degenerate but budget-legal.
        expect(clamped.replace(/…$/, '').trim().length).toBeGreaterThan(40);
      });
    }
  }
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

    // Every prose consumer is fed the locative. The only templates still
    // gluing their own preposition onto `${z}` are the four `zoneH1`, which
    // by construction only ever receive a city name ("oggi a Chiasso").
    const todayCopy = source.slice(
      source.indexOf('const COPY: Record<FuelDailyLocale, FuelCopy>'),
      source.indexOf('function renderPage'),
    );
    // `\b` would not fire before "à" (not a word char), so anchor on space.
    const glued = todayCopy.match(/\s(?:a|in|à) \$\{z\}/g) ?? [];
    expect(glued).toHaveLength(4);
    expect((todayCopy.match(/zoneH1: \(f, z\) =>/g) ?? []).length).toBe(4);
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

  it('the price-bearing title can never overflow the budget', () => {
    // Adversarial check from review: is the fallback in `renderPage` sound at
    // the boundary, once `clampSiteSuffix` has had its turn? The guard picks
    // the price form only at <= TITLE_MAX_CHARS, and clampSiteSuffix appends
    // the brand only if the total still fits — so the final string is never
    // longer than the dated form it would otherwise have produced.
    expect(source).toMatch(
      /const titleBase = titleWithPrice\.length <= 66 \? titleWithPrice : titleWithDate;/,
    );

    const brand = 'Frontaliere Ticino';
    const exactly66 = 'x'.repeat(TITLE_MAX_CHARS);
    expect(clampSiteSuffix(exactly66, brand)).toBe(exactly66); // brand dropped
    expect(clampSiteSuffix(exactly66, brand).length).toBe(TITLE_MAX_CHARS);

    // Longest base that still keeps the brand: 66 - " | Frontaliere Ticino".
    const fits = 'y'.repeat(TITLE_MAX_CHARS - ` | ${brand}`.length);
    expect(clampSiteSuffix(fits, brand)).toBe(`${fits} | ${brand}`);
    expect(clampSiteSuffix(fits, brand).length).toBe(TITLE_MAX_CHARS);

    // One char more and the brand must go rather than overflow.
    const oneOver = `${fits}z`;
    expect(clampSiteSuffix(oneOver, brand)).toBe(oneOver);
    expect(clampSiteSuffix(oneOver, brand).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('keeps the ISO date stamp for schema.org and a display date for prose', () => {
    // `dateModified` must stay ISO; only human-facing copy gets dd.MM.yyyy.
    expect(source).toMatch(/dateModified: dateStamp/);
    expect(source).toMatch(/function formatFuelDateDisplay/);
  });
});
