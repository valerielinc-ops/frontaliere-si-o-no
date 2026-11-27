import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREV_SLUG_CAP,
  LOCALES,
  cleanPreviousSlugsPerLocale,
  getPreviousSlugsForLocale,
  stableSlugHash,
} from '../scripts/lib/dedicated-crawler-common.mjs';
import { decontaminateEntries, decontaminateJobs } from '../scripts/decontaminate-prev-slugs.mjs';
import { localeRouteKeys } from '../scripts/lib/expired-jobs-archive.mjs';

// A flat `previousSlugs` entry with no locale bucket is served under all four
// locales. Being the ACTIVE slug of one locale makes it a self-redirect there
// only: the other locales still serve it as an old route. The cleaner dropped
// the whole entry, which `recover-prev-slugs.yml` then persisted through
// `decontaminate-prev-slugs.mjs --apply`.
const ACTIVE = {
  it: 'magazziniere-turno-serale-acme-lugano',
  en: 'evening-shift-warehouse-clerk-acme-lugano',
  de: 'lagermitarbeiter-spaetschicht-acme-lugano',
  fr: 'magasinier-equipe-du-soir-acme-lugano',
};

const job = (extra: Record<string, unknown> = {}): any => ({
  id: 'acme-1',
  url: 'https://jobs.example.com/posting/acme-1',
  slug: ACTIVE.it,
  slugByLocale: { ...ACTIVE },
  ...extra,
});

const lost = (before: Set<string>, after: Set<string>): string[] =>
  [...before].filter((route) => !after.has(route));

describe('flat-only previous slug that is one locale active slug', () => {
  for (const locale of LOCALES as Array<keyof typeof ACTIVE>) {
    it(`keeps the other three routes when it is the active ${locale} slug`, () => {
      const record = job({ previousSlugs: [ACTIVE[locale]] });
      const before = localeRouteKeys(record);

      cleanPreviousSlugsPerLocale(record);

      expect(lost(before, localeRouteKeys(record))).toEqual([]);
      expect(record.previousSlugs).toBeUndefined();
      expect(record.previousSlugsByLocale).toEqual(Object.fromEntries(
        LOCALES.filter((other: string) => other !== locale).map((other: string) => [other, [ACTIVE[locale]]]),
      ));
      const settled = structuredClone(record);
      cleanPreviousSlugsPerLocale(record);
      expect(record).toEqual(settled);
    });
  }

  it('keeps the other routes through the ownership pass the recovery workflow applies', () => {
    const record = job({ previousSlugs: [ACTIVE.de, 'older-flat-route'] });
    const before = localeRouteKeys(record);

    decontaminateJobs([record]);

    expect(lost(before, localeRouteKeys(record))).toEqual([]);
    expect(record.previousSlugs).toEqual(['older-flat-route']);
  });

  it('adds nothing when the slug is the active one in every locale', () => {
    const same = 'one-route-everywhere';
    const record = job({
      slug: same,
      slugByLocale: { it: same, en: same, de: same, fr: same },
      previousSlugs: [same],
    });

    cleanPreviousSlugsPerLocale(record);

    expect(record.previousSlugs).toBeUndefined();
    expect(record.previousSlugsByLocale).toBeUndefined();
  });

  for (const [shape, history] of [
    ['flat-only', { previousSlugs: [ACTIVE.de] }],
    ['bucketed under it', { previousSlugs: [ACTIVE.de], previousSlugsByLocale: { it: [ACTIVE.de] } }],
  ] as const) {
    it(`keeps the Italian route of an expired record whose master is not its Italian slug (${shape})`, () => {
      const record = job({ slug: ACTIVE.de, expiredAt: new Date().toISOString(), ...structuredClone(history) });
      const before = localeRouteKeys(record);
      expect(before).toContain(`it:${ACTIVE.de}`);

      cleanPreviousSlugsPerLocale(record);

      expect(lost(before, localeRouteKeys(record))).toEqual([]);
      expect(record.previousSlugsByLocale.it).toEqual([ACTIVE.de]);
    });
  }

  it('leaves the flat entry alone when one target bucket is full, without evicting anything', () => {
    const full = Array.from({ length: DEFAULT_PREV_SLUG_CAP }, (_, i) => `older-fr-route-${i}`);
    const record = job({
      previousSlugs: [ACTIVE.de, ...full],
      previousSlugsByLocale: { fr: [...full] },
    });
    const before = localeRouteKeys(record);

    cleanPreviousSlugsPerLocale(record);

    expect(lost(before, localeRouteKeys(record))).toEqual([]);
    expect(record.previousSlugs).toContain(ACTIVE.de);
    // All or nothing: one bucket entry would end the flat fallback for the rest.
    expect(record.previousSlugsByLocale).toEqual({ fr: full });
    expect(getPreviousSlugsForLocale(record, 'it')).toContain(ACTIVE.de);
  });

  it('counts the room taken by an earlier entry of the same pass', () => {
    const nearlyFull = Array.from({ length: DEFAULT_PREV_SLUG_CAP - 1 }, (_, i) => `older-fr-route-${i}`);
    const record = job({
      previousSlugs: [ACTIVE.de, ACTIVE.en, ...nearlyFull],
      previousSlugsByLocale: { fr: [...nearlyFull] },
    });
    const before = localeRouteKeys(record);

    cleanPreviousSlugsPerLocale(record);

    expect(lost(before, localeRouteKeys(record))).toEqual([]);
    expect(record.previousSlugsByLocale.fr).toEqual([...nearlyFull, ACTIVE.de]);
    expect(record.previousSlugs).toContain(ACTIVE.en);
    expect(record.previousSlugs).not.toContain(ACTIVE.de);
  });

  it('does not widen a mirror of a bucket that only held the self-redirect', () => {
    const record = job({
      previousSlugs: [ACTIVE.de],
      previousSlugsByLocale: { de: [ACTIVE.de] },
    });
    const before = localeRouteKeys(record);

    cleanPreviousSlugsPerLocale(record);

    expect(localeRouteKeys(record)).toEqual(before);
    expect(record.previousSlugs).toBeUndefined();
    expect(record.previousSlugsByLocale).toBeUndefined();
  });

  it('still moves a slug carrying another posting hash to that posting, in every locale', () => {
    const owner = job({
      id: 'acme-2',
      url: 'https://jobs.example.com/posting/acme-2',
      slug: 'autista-acme-lugano',
      slugByLocale: { it: 'autista-acme-lugano' },
    });
    const foreign = `route-of-the-other-posting-${stableSlugHash(owner)}`;
    const claimant = job({ previousSlugs: [foreign, ACTIVE.de] });
    const own = localeRouteKeys(claimant);
    for (const locale of LOCALES) own.delete(`${locale}:${foreign}`);

    const result = decontaminateEntries([{ filePath: null, slice: { jobs: [claimant, owner] } }], { apply: false });

    expect(result.moved).toBe(1);
    expect(lost(own, localeRouteKeys(claimant))).toEqual([]);
    for (const locale of LOCALES) {
      expect(localeRouteKeys(claimant)).not.toContain(`${locale}:${foreign}`);
      expect(localeRouteKeys(owner)).toContain(`${locale}:${foreign}`);
    }
  });

  it('gives an expired owner the Italian route that its master alone does not serve', () => {
    const url = 'https://jobs.example.com/posting/expired-owner';
    const master = `rotta-del-proprietario-scaduto-${stableSlugHash({ url })}`;
    const owner = job({
      id: 'acme-3',
      url,
      slug: master,
      slugByLocale: { it: 'titolo-italiano-diverso', de: 'anderer-titel' },
      expiredAt: new Date().toISOString(),
    });
    const claimant = job({ previousSlugsByLocale: { it: [master] } });

    decontaminateEntries([{ filePath: null, slice: { jobs: [claimant, owner] } }], { apply: false });

    expect(localeRouteKeys(claimant)).not.toContain(`it:${master}`);
    expect(localeRouteKeys(owner)).toContain(`it:${master}`);
  });
});
