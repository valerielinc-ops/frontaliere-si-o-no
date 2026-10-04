import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LegalDocumentPage } from '../components/pages/LegalDocumentPage';
import { buildLegalSeo, getLegalDocument, type LegalPage } from '../services/legal/documents';
import { legalLinks, type LegalLocale } from '../services/legal/types';
import { renderLegalEditorial, resolveLegalPage, resolveLegalStaticSeo } from '../build-plugins/shared/legalEditorial';

const locales: LegalLocale[] = ['it', 'en', 'de', 'fr'];
const pages: LegalPage[] = ['privacy', 'terms', 'data-deletion'];
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

describe('complete legal copy shared by static and hydrated pages', () => {
  for (const locale of locales) for (const page of pages) {
    it(`${locale}/${page}: complete sections, localized metadata and same paragraphs`, () => {
      const document = getLegalDocument(page, locale);
      const staticDom = parse(renderLegalEditorial(page, locale).join(''));
      const spaDom = parse(renderToStaticMarkup(<LegalDocumentPage document={document} locale={locale} adsControls={<button>consent test control</button>}/>));
      const expectedCount = page === 'privacy' ? 20 : page === 'terms' ? 8 : 5;
      expect(staticDom.querySelectorAll('section')).toHaveLength(expectedCount);
      expect(spaDom.querySelectorAll('section')).toHaveLength(expectedCount);
      expect(staticDom.querySelector('h1')).toBeNull();
      expect(text(spaDom.querySelector('h1'))).toBe(document.title);
      const staticSections = [...staticDom.querySelectorAll('section')];
      [...spaDom.querySelectorAll('section')].forEach((section, index) => {
        expect(text(section.querySelector('h2'))).toBe(text(staticSections[index].querySelector('h2')));
        // Interactive consent is intentionally replaced by an honest static notice.
        for (const block of document.sections[index].blocks) if ('html' in block) {
          const expected = text(parse(block.html).body)!;
          expect(text(section)).toContain(expected);
          expect(text(staticSections[index])).toContain(expected);
        }
      });
      const seo = buildLegalSeo(page, locale);
      expect(seo.jsonLd.inLanguage).toBe(locale);
      expect(seo.jsonLd.name).toBe(document.title);
      expect(seo.description).toBe(document.description);
      expect(seo.canonical).toMatch(/\/$/);
      expect(resolveLegalPage(new URL(seo.canonical).pathname)).toBe(page);
      expect(resolveLegalStaticSeo(new URL(seo.canonical).pathname, locale)?.desc).toBe(seo.description);
      for (const anchor of [...staticDom.querySelectorAll('a[href^="/"]')]) {
        const href = anchor.getAttribute('href')!;
        if (locale !== 'it') expect(href).toMatch(new RegExp(`^/${locale}/`));
        expect(href.split('#')[0]).toMatch(/\/$/);
      }
      if (page === 'terms') for (const id of ['licenza-immagini', 'software-terze-parti', 'candidatura-assistita']) {
        expect(spaDom.getElementById(id)).not.toBeNull();
        expect(staticDom.getElementById(id)).not.toBeNull();
      }
      if (page === 'privacy') {
        expect(spaDom.querySelectorAll('button')).toHaveLength(1);
        expect(staticDom.querySelector('button')).toBeNull();
        const storage = document.sections.flatMap(section => section.blocks)
          .find(block => 'html' in block && block.html.startsWith('<h3>LocalStorage</h3>'));
        expect(storage && 'html' in storage ? storage.html : '').toContain({ it: 'valuta selezionata', en: 'selected currency', de: 'gewählte Währung', fr: 'devise sélectionnée' }[locale]);
      }
      if (page === 'data-deletion') {
        expect(staticDom.querySelector(`a[href="${legalLinks(locale).profile}"]`)).not.toBeNull();
        expect(staticDom.body.textContent).not.toMatch(/DATA_DELETABLE|No Data to Delete|dati non vengono mai trasmessi/i);
      }
    });
  }
  it('legacy privacy route resolves to the same policy', () => {
    expect(resolveLegalPage('/privacy-policy/')).toBe('privacy');
    expect(resolveLegalPage('/unrelated/')).toBeUndefined();
  });
});
