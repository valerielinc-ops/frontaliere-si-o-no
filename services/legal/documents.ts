import { getPrivacyLegalDocument } from './privacy';
import { getTermsLegalDocument } from './terms';
import { getDataDeletionLegalDocument } from './dataDeletion';
import { legalLinks, type LegalLocale } from './types';

export type LegalPage = 'privacy' | 'terms' | 'data-deletion';
export function getLegalDocument(page: LegalPage, locale: LegalLocale) {
  return page === 'privacy' ? getPrivacyLegalDocument(locale)
    : page === 'terms' ? getTermsLegalDocument(locale) : getDataDeletionLegalDocument(locale);
}
export function buildLegalSeo(page: LegalPage, locale: LegalLocale) {
  const document = getLegalDocument(page, locale);
  const links = legalLinks(locale);
  const path = page === 'data-deletion' ? links.dataDeletion : links[page];
  const canonical = `https://frontaliereticino.ch${path}`;
  return {
    title: `${document.title} | Frontaliere Ticino`, description: document.description,
    canonical, jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage',
      '@id': `${canonical}#webpage`, name: document.title, description: document.description,
      url: canonical, inLanguage: locale },
  };
}
