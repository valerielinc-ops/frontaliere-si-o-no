import { SLUG_TABLES } from '../services/routeSlugs.data';
import { buildMethodologyEditorial } from '../build-plugins/shared/editorialMethodology';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { METHODOLOGY_COPY, METHODOLOGY_PATHS, type MethodologyLocale } from '../services/editorialMethodology';
import { translateSchema } from '../services/seo/schema-translators';
import Metodologia from '../components/pages/Metodologia';

const state = vi.hoisted(() => ({ locale: 'it' as MethodologyLocale }));
vi.mock('../services/i18n', () => ({ useLocale: () => [state.locale, vi.fn()] }));
vi.mock('../services/NavigationContext', () => ({ useNavigation: () => ({ navigateTo: vi.fn() }) }));

for (const locale of ['it', 'en', 'de', 'fr'] as const) {
  describe(`methodology ${locale}`, () => {
    it('renders the disclosure and a real fact-checking fragment in the requested language', () => {
      state.locale = locale;
      const html = renderToStaticMarkup(<Metodologia />);
      const dom = new DOMParser().parseFromString(html, 'text/html');
      expect(dom.querySelector('h1')?.textContent).toBe(METHODOLOGY_COPY[locale].title);
      expect(dom.querySelector('#fact-checking')).not.toBeNull();
      for (const section of METHODOLOGY_COPY[locale].sections) {
        expect(dom.querySelector(`#${section.id}`)?.textContent).toContain(section.paragraphs[0]);
      }
      if (locale !== 'it') expect(dom.body.textContent).not.toContain(METHODOLOGY_COPY.it.sections[0].paragraphs[0]);
    });
    it('renders the same disclosure in the static page', () => {
      const blocks = buildMethodologyEditorial(locale, text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      const dom = new DOMParser().parseFromString(blocks.join('\n'), 'text/html');
      expect(dom.querySelector('#fact-checking')?.textContent).toBe(METHODOLOGY_COPY[locale].sections.find(section => section.id === 'fact-checking')?.title);
      for (const section of METHODOLOGY_COPY[locale].sections) expect(dom.body.textContent).toContain(section.paragraphs[0]);
      const prefix = locale === 'it' ? '' : `/${locale}`;
      expect(dom.querySelector(`a[href="${prefix}/${SLUG_TABLES[locale].correzioni}/"]`)).not.toBeNull();
    });
    if (locale !== 'it') it('localizes AboutPage identity and description through the production dispatcher', () => {
      const schema = { '@type': 'AboutPage', name: METHODOLOGY_COPY.it.title, description: 'Italian description', url: 'https://frontaliereticino.ch/metodologia/', inLanguage: 'it' };
      translateSchema(schema, locale);
      expect(schema).toMatchObject({ name: METHODOLOGY_COPY[locale].title, description: METHODOLOGY_COPY[locale].description, url: `https://frontaliereticino.ch${METHODOLOGY_PATHS[locale]}`, inLanguage: locale });
      // SPA sets the local name and URL before calling the same dispatcher.
      Object.assign(schema, { about: { '@type': 'CreativeWork', name: 'Editorial methodology and AI-assistance disclosure' } });
      translateSchema(schema, locale);
      expect(schema).toHaveProperty('about.name', METHODOLOGY_COPY[locale].title);
    });
  });
}
