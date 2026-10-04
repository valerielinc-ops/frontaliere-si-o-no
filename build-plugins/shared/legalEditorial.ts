import { buildLegalSeo, getLegalDocument, type LegalPage } from '../../services/legal/documents';
import { LEGAL_BODY_CLASS, LEGAL_CONSENT_STATIC_LABEL, legalLinks, type LegalLocale } from '../../services/legal/types';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function resolveLegalPage(path: string): LegalPage | undefined {
  const normalized = `${path.replace(/\/+$/, '')}/`;
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    const links = legalLinks(locale);
    if (normalized === links.privacy) return 'privacy';
    if (normalized === links.terms) return 'terms';
    if (normalized === links.dataDeletion) return 'data-deletion';
  }
  if (normalized === '/privacy-policy/') return 'privacy';
}

/** Same reviewed content as the SPA; the page shell already provides H1. */
export function renderLegalEditorial(page: LegalPage, locale: LegalLocale): string[] {
  const document = getLegalDocument(page, locale);
  return [document.updated ? `<p>${escapeHtml(document.updated)}</p>` : '',
    `<div class="${LEGAL_BODY_CLASS}">${document.introHtml}</div>`,
    ...document.sections.map(section => `<section${section.id ? ` id="${escapeHtml(section.id)}"` : ''}><h2 class="text-xl font-bold text-strong mb-4">${escapeHtml(section.title)}</h2><div class="${LEGAL_BODY_CLASS}">${section.blocks.map(block => 'html' in block ? block.html : `<p>${escapeHtml(LEGAL_CONSENT_STATIC_LABEL[locale])}</p>`).join('')}</div></section>`),
  ].filter(Boolean);
}

export function resolveLegalStaticSeo(path: string, locale: LegalLocale) {
  const page = resolveLegalPage(path);
  if (!page) return undefined;
  const seo = buildLegalSeo(page, locale);
  return { title: seo.title, desc: seo.description, ogT: seo.title, ogD: seo.description, sd: JSON.stringify([seo.jsonLd]) };
}
