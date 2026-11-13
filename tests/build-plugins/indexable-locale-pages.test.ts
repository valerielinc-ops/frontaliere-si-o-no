import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLocalePagePathClaims,
  indexableLocalePageSet,
  isIndexableLocalePage,
  reciprocalSitemapLocaleGroups,
} from '../../build-plugins/shared/indexableLocalePages';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Locale = (typeof LOCALES)[number];
const BASE_URL = 'https://frontaliereticino.ch';

function renderGroups(groups: Array<{
  locale: Locale;
  href: string;
  alternates: Array<{ locale: Locale; href: string }>;
}>): string {
  return groups.map((group) => [
    '<url>',
    `  <loc>${group.href}</loc>`,
    ...group.alternates.map(({ locale, href }) => `  <xhtml:link rel="alternate" hreflang="${locale}" href="${href}" />`),
    '</url>',
  ].join('\n')).join('\n');
}

describe('shared sitemap locale eligibility in split builds', () => {
  it('keeps reciprocal city-hub locs when IT is the sitemap build and sibling pages are absent from dist', () => {
    const tempDist = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-sitemap-split-'));
    try {
      const paths: Record<Locale, string> = {
        it: '/cerca-lavoro-argovia/baden/',
        en: '/en/find-jobs-aargau/baden/',
        de: '/de/jobs-im-aargau/baden/',
        fr: '/fr/trouver-emploi-argovie/baden/',
      };
      const indexableLocales = indexableLocalePageSet(LOCALES, () => true);
      const thisBuildLocales = new Set<Locale>(['it']);

      // The IT build emits only its owned page; DE/EN/FR are intentionally not
      // present on disk even though their own locale builds emit them.
      expect(isIndexableLocalePage('it', indexableLocales) && thisBuildLocales.has('it')).toBe(true);
      for (const locale of ['en', 'de', 'fr'] as const) {
        expect(isIndexableLocalePage(locale, indexableLocales)).toBe(true);
        expect(fs.existsSync(path.join(tempDist, paths[locale].slice(1), 'index.html'))).toBe(false);
      }

      const groups = reciprocalSitemapLocaleGroups(
        LOCALES,
        indexableLocales,
        (locale) => `${BASE_URL}${paths[locale]}`,
      );
      const xml = renderGroups(groups);
      expect(groups.map((group) => group.locale)).toEqual([...LOCALES]);
      expect(groups).toHaveLength(4); // one IT loc + three restored non-IT locs
      expect(groups.filter((group) => group.locale !== 'it')).toHaveLength(3);
      for (const locale of LOCALES) {
        expect(xml).toContain(`<loc>${BASE_URL}${paths[locale]}</loc>`);
        expect(xml).toContain(`hreflang="${locale}" href="${BASE_URL}${paths[locale]}"`);
      }

    } finally {
      fs.rmSync(tempDist, { recursive: true, force: true });
    }
  });

  it('excludes below-floor and noindex editorial siblings from locs and reciprocal alternates', () => {
    const jobsByLocale: Record<Locale, number> = { it: 8, en: 3, de: 7, fr: 6 };
    const minJobs = 5;
    const editorialLocales = indexableLocalePageSet(
      LOCALES,
      (locale) => jobsByLocale[locale] >= minJobs && locale !== 'de',
    );
    const groups = reciprocalSitemapLocaleGroups(
      LOCALES,
      editorialLocales,
      (locale) => `${BASE_URL}/${locale}/editorial/qualified/`,
    );

    expect(groups.map((group) => group.locale)).toEqual(['it', 'fr']);
    const xml = renderGroups(groups);
    expect(xml).toContain(`${BASE_URL}/it/editorial/qualified/`);
    expect(xml).toContain(`${BASE_URL}/fr/editorial/qualified/`);
    expect(xml).not.toContain(`${BASE_URL}/en/editorial/qualified/`); // below the content floor
    expect(xml).not.toContain(`${BASE_URL}/de/editorial/qualified/`); // noindex decision
    for (const group of groups) {
      expect(group.alternates.map((alternate) => alternate.locale)).toEqual(['it', 'fr']);
    }
  });

  it('uses the same eligible page set for editorial emitters and sitemap locs', () => {
    const jobCount = 7;
    const minIndexableJobs = 5;
    const editorialLocales = indexableLocalePageSet(
      LOCALES,
      () => jobCount >= minIndexableJobs,
    );
    const selectedByItBuild = new Set<Locale>(['it']);

    for (const locale of LOCALES) {
      const emitterWouldIndex = isIndexableLocalePage(locale, editorialLocales);
      const emitterWritesHere = selectedByItBuild.has(locale) && emitterWouldIndex;
      expect(emitterWouldIndex).toBe(true);
      if (locale !== 'it') expect(emitterWritesHere).toBe(false);
    }

    const groups = reciprocalSitemapLocaleGroups(
      LOCALES,
      editorialLocales,
      (locale) => `${BASE_URL}/${locale}/editorial/qualified/`,
    );
    expect(groups.map((group) => group.locale)).toEqual([...LOCALES]);
  });

  it('keeps exact sibling path owners visible to split-build writers, including noindex pages', () => {
    const claims = createLocalePagePathClaims(LOCALES);
    claims.claim('de', '/de/jobs-im-aargau/company-northstar/');

    expect(claims.has('de', 'de/jobs-im-aargau/company-northstar')).toBe(true);
    expect(claims.has('it', '/de/jobs-im-aargau/company-northstar/')).toBe(false);
    expect(claims.has('de', '/de/jobs-im-aargau/company-northstar-city/')).toBe(false);
  });
});
