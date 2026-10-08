import { afterEach, describe, expect, it, vi } from 'vitest';
import { isArticleSectionRoute, parsePath } from '@/services/router';

const LOCALES = [
  {
    name: 'it',
    home: '/',
    jobs: '/cerca-lavoro-ticino/',
    calculator: '/calcola-stipendio/',
    tax: '/tasse-e-pensione/',
    guide: '/guida-frontaliere/',
    historical: '/articoli-frontaliere/',
    canton: '/articoli-ticino/',
  },
  {
    name: 'en',
    home: '/en/',
    jobs: '/en/find-jobs-ticino/',
    calculator: '/en/calculate-salary/',
    tax: '/en/taxes-and-pension/',
    guide: '/en/cross-border-guide/',
    historical: '/en/cross-border-articles/',
    canton: '/en/ticino-articles/',
  },
  {
    name: 'de',
    home: '/de/',
    jobs: '/de/jobs-im-tessin/',
    calculator: '/de/gehalt-berechnen/',
    tax: '/de/steuern-und-vorsorge/',
    guide: '/de/grenzgaenger-ratgeber/',
    historical: '/de/grenzgaenger-artikel/',
    canton: '/de/tessin-artikel/',
  },
  {
    name: 'fr',
    home: '/fr/',
    jobs: '/fr/trouver-emploi-tessin/',
    calculator: '/fr/calculer-salaire/',
    tax: '/fr/impots-et-retraite/',
    guide: '/fr/guide-frontalier/',
    historical: '/fr/articles-frontalier/',
    canton: '/fr/articles-tessin/',
  },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('article-section route scope', () => {
  it.each(LOCALES)('$name keeps jobs, calculator, tax, guide and home outside the article nav', (locale) => {
    for (const path of [locale.jobs, locale.calculator, locale.tax, locale.guide, locale.home]) {
      expect(isArticleSectionRoute(parsePath(path).route), path).toBe(false);
    }
  });

  it.each(LOCALES)('$name keeps the historical article section in scope', (locale) => {
    expect(isArticleSectionRoute(parsePath(locale.historical).route), locale.historical).toBe(true);
  });

  it.each(LOCALES)('$name keeps the canton article section in scope', (locale) => {
    vi.stubGlobal('document', {
      querySelector: () => ({ getAttribute: () => 'corpus' }),
    });

    const parsed = parsePath(locale.canton);
    expect(parsed.route.blogSection).toMatch(/^canton-/);
    expect(isArticleSectionRoute(parsed.route), locale.canton).toBe(true);
  });
});
