import { describe, it, expect } from 'vitest';
import { createContentKeywordMatcher, rankContentDestinations } from '../packages/articles/engine/shared/contentKeywordMatcher.mjs';
import { matchContentLinks } from '../packages/articles/engine/shared/contentLinkVocabulary.mjs';
import { autoLinkKeywords } from '../components/community/BlogArticles';
import { NAV_ACTION_ROUTES, contentLinkDestinations } from '../services/internalLinks';
import { buildPath } from '../services/router';

describe('multilingual content matching', () => {
  it.each([
    ['it', 'Le code oggi ai valichi aumentano.', 'border'],
    ['en', 'Compare the net salary before applying.', 'calculator'],
    ['de', 'Die Wartezeit an der Grenze steigt.', 'border'],
    ['fr', 'Le coût de la vie augmente.', 'cost-of-living'],
  ] as const)('matches intent in %s and resolves a canonical localized destination', (locale, text, id) => {
    const hit = matchContentLinks(text, locale).find(m => m.id === id);
    expect(hit).toBeDefined();
    expect(text.slice(hit!.start, hit!.end)).toBe(hit!.text);
    const path = buildPath(NAV_ACTION_ROUTES[id], locale);
    expect(path).toMatch(/\/$/);
    if (locale !== 'it') expect(path).toMatch(new RegExp(`^/${locale}/`));
  });

  it('links fuel intent to the localized daily page, preserving an existing target', () => {
    const paths = contentLinkDestinations('fr');
    const text = 'Comparez les prix du diesel avant le trajet.';
    const out = autoLinkKeywords(text, {}, 'fr');
    expect(out).toContain(`](${paths['fuel-diesel']})`);
    expect(paths['fuel-diesel']).toBe('/fr/prix-gasoil-suisse/aujourd-hui/');
    expect(autoLinkKeywords(out, {}, 'fr')).toBe(out);
  });

  it('supports arbitrary content entries, pairs, triples and diacritics', () => {
    const match = createContentKeywordMatcher([{ id: 'guide', aliases: { fr: ['prévoyance privée'] },
      combinations: { en: [[['Swiss', 'CHF'], ['salary'], ['calculator']]] }, target: '/en/guide/' }]);
    expect(match('Swiss net salary calculator', 'en')[0]).toMatchObject({ id: 'guide', target: '/en/guide/' });
    expect(match('La prévoyance privée', 'fr')[0].text).toBe('prévoyance privée');
    expect(match('Swiss mountains. A salary calculator', 'en')).toEqual([]);
    expect(match('Swiss scenery with many irrelevant intervening words salary calculator', 'en')).toEqual([]);
  });

  it('does not reinterpret ambiguous words or substrings as financial intent', () => {
    for (const [locale, text] of [['it', 'Franchigia fiscale e offerte al supermercato'], ['en', 'A change at the river bank'], ['de', 'Die Bank im Park'], ['fr', 'Une offre au magasin']]) {
      expect(matchContentLinks(text, locale)).toEqual([]);
    }
    expect(matchContentLinks('pensionatoio', 'it')).toEqual([]);
  });

  it('prioritizes specific phrases and title intent over incidental body mentions', () => {
    expect(matchContentLinks('permesso G vs B', 'it')[0].id).toBe('permit-compare');
    expect(rankContentDestinations(matchContentLinks, {
      title: 'Code oggi ai valichi', body: 'stipendio netto '.repeat(40), locale: 'it',
    })[0].id).toBe('border');
  });

  it('links multilingual prose once, preserving links, code and headings', () => {
    const nav = { calculator: () => {}, border: () => {}, 'cost-of-living': () => {} };
    const text = '## Net salary\n`net salary` [net salary](/en/existing/)\nUse the **net salary** calculator. Net salary again.';
    const out = autoLinkKeywords(text, nav, 'en');
    expect(out).toContain('## Net salary');
    expect(out).toContain('`net salary`');
    expect(out).toContain('[net salary](/en/existing/)');
    expect(out.match(/nav:calculator/g)).toHaveLength(1);
    expect(autoLinkKeywords(out, nav, 'en')).toBe(out);
    expect(autoLinkKeywords('Le coût de la vie augmente.', nav, 'fr')).toContain('[coût de la vie](nav:cost-of-living)');
  });
});
