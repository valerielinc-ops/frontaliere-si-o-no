// E-E-A-T P0 — editorial signatures with person-like names must say what they are.
//
// "Marco Ferrari" (1.494 articles) and "Laura Bianchi" (858) look like people
// but are newsroom signatures. The bare "Profilo editoriale" label did not tell
// a reader that no such person exists; the disclosure now does, on the author
// page (static + React), in /chi-siamo/ and in the profile JSON-LD. Samuele
// Valente is a real guest author and must never carry it.
import { describe, expect, it } from 'vitest';
import { EDITORIAL_PROFILE_DISCLOSURE } from '../data/authorLocales';
import { getAuthorBySlug } from '../data/authors';
import { renderAuthorEditorial } from '../build-plugins/shared/authorEditorial';
import { buildAuthorSeo } from '../services/seo/seo-authors';
import { DISCLOSURE_ROUTE_CONTRACT } from '../packages/articles/engine/shared/aiDisclosure';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const NOT_A_PERSON = { it: /non una persona reale/, en: /not a real person/, de: /keine reale Person/, fr: /pas une personne réelle/ };
const PSEUDONYM = { it: /pseudonim/, en: /pseudonym/, de: /Pseudonym/, fr: /pseudonyme/ };
const AUTHOR_PATH = { it: '/autori', en: '/en/authors', de: '/de/autoren', fr: '/fr/auteurs' };

describe('editorial pseudonyms are declared as such', () => {
  it.each(LOCALES)('disclosure (%s) says pseudonym, not a real person, AI-prepared', (locale) => {
    const text = EDITORIAL_PROFILE_DISCLOSURE[locale];
    expect(text).toMatch(NOT_A_PERSON[locale]);
    expect(text).toMatch(PSEUDONYM[locale]);
    expect(text).toMatch(/IA|AI|KI/);
  });

  it.each(LOCALES.flatMap((locale) => ['marco-ferrari', 'laura-bianchi'].map((slug) => [locale, slug] as const)))(
    '%s /%s/ renders the disclosure, links the methodology and is an Organization in JSON-LD',
    (locale, slug) => {
      expect(getAuthorBySlug(slug)?.kind).toBe('editorial-profile');
      const html = (renderAuthorEditorial(`${AUTHOR_PATH[locale]}/${slug}/`, locale) ?? []).join('');
      expect(html).toContain(EDITORIAL_PROFILE_DISCLOSURE[locale].replace(/'/g, '&#39;'));
      expect(html).toContain(`href="${DISCLOSURE_ROUTE_CONTRACT[locale].methodology}"`);
      const ld = buildAuthorSeo(slug, locale).jsonLd;
      expect(ld['@type']).toBe('Organization');
      expect(ld.disambiguatingDescription).toBe(EDITORIAL_PROFILE_DISCLOSURE[locale]);
    },
  );

  it('the real guest author carries no pseudonym disclosure', () => {
    const html = (renderAuthorEditorial('/autori/samuele-valente/', 'it') ?? []).join('');
    expect(html).not.toContain(EDITORIAL_PROFILE_DISCLOSURE.it);
    expect(buildAuthorSeo('samuele-valente', 'it').jsonLd['@type']).toBe('Person');
  });
});
