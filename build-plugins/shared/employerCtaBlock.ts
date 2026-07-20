/**
 * Employer acquisition CTA — shared block for static SEO pages.
 *
 * Renders the "Assumete? Pubblicate il vostro annuncio" self-serve CTA on the
 * employer-facing SSG surfaces (weekly-employers city/company/canton pages and
 * job detail pages). Copy is BENEFIT-FIRST by owner rule: it sells reach
 * (cross-border audience, featured listing, dedicated SEO page, newsletter
 * blast included) and NEVER mentions paying upfront.
 *
 * Tracking contract: the anchor carries `data-employer-cta="<surface>"`.
 * The SPA (services/analytics.ts) binds a document-level click listener and an
 * IntersectionObserver on that attribute and fires the PostHog funnel events
 * `employer_cta_click` / `employer_cta_view` with `{ surface, locale }` —
 * works on static pages too because the SPA shell hydrates around the static
 * content (single document).
 *
 * Zero CLS by construction: the block is part of the server-emitted HTML
 * (in-flow, fixed copy, no async swap) and reuses the `.s-cbody` / `.s-cta`
 * classes whose geometry is already reserved by the shared critical CSS.
 *
 * One source of truth for the localized `/per-le-aziende/` target: derived
 * from the shared SLUG_TABLES[locale].forEmployers (#4315). Trailing slash
 * mandatory (repo rule).
 */

import { escHtml as esc } from './htmlEscape';
import { SMALL_HEADING_STYLE, BODY_STYLE, CARD_BODY_CLASS } from './seoContentTokens';
import { SLUG_TABLES } from '../../services/routeSlugs.data';

export type EmployerCtaLocale = 'it' | 'en' | 'de' | 'fr';

/** Localized for-employers landing path — trailing slash by construction. */
export const FOR_EMPLOYERS_PATH: Record<EmployerCtaLocale, string> = {
  it: `/${SLUG_TABLES.it.forEmployers}/`,
  en: `/en/${SLUG_TABLES.en.forEmployers}/`,
  de: `/de/${SLUG_TABLES.de.forEmployers}/`,
  fr: `/fr/${SLUG_TABLES.fr.forEmployers}/`,
};

interface EmployerCtaCopy {
  readonly title: string;
  readonly body: string;
  readonly cta: string;
}

/** Benefit-first copy — NEVER "pay first" (owner rule). */
export const EMPLOYER_CTA_COPY: Record<EmployerCtaLocale, EmployerCtaCopy> = {
  it: {
    title: 'Assumete? Pubblicate il vostro annuncio',
    body: 'Raggiungete ogni settimana migliaia di frontalieri e candidati locali: annuncio in evidenza, pagina SEO dedicata e segnalazione alla newsletter incluse.',
    cta: 'Pubblica il tuo annuncio',
  },
  en: {
    title: 'Hiring? Publish your job ad',
    body: 'Reach thousands of cross-border and local candidates every week: featured listing, dedicated SEO page and newsletter blast included.',
    cta: 'Publish your ad',
  },
  de: {
    title: 'Sie stellen ein? Veröffentlichen Sie Ihre Stellenanzeige',
    body: 'Erreichen Sie jede Woche Tausende Grenzgänger und lokale Kandidaten: hervorgehobene Anzeige, eigene SEO-Seite und Newsletter-Versand inklusive.',
    cta: 'Anzeige veröffentlichen',
  },
  fr: {
    title: 'Vous recrutez ? Publiez votre annonce',
    body: 'Touchez chaque semaine des milliers de frontaliers et de candidats locaux : annonce mise en avant, page SEO dédiée et envoi newsletter inclus.',
    cta: 'Publier votre annonce',
  },
};

function normalizeLocale(locale: string): EmployerCtaLocale {
  return (['it', 'en', 'de', 'fr'] as const).includes(locale as EmployerCtaLocale)
    ? (locale as EmployerCtaLocale)
    : 'it';
}

/**
 * Card-style CTA for pages built with the shared seoContentTokens system
 * (weekly-employers city/company/canton pages). Sits in the footer content
 * area of the page body.
 */
export function renderEmployerCtaBlock(locale: string, surface: string): string {
  const l = normalizeLocale(locale);
  const copy = EMPLOYER_CTA_COPY[l];
  return `<section class="${CARD_BODY_CLASS}" style="margin:32px 0 0;padding:20px 24px" aria-label="${esc(copy.title)}">
  <p style="${SMALL_HEADING_STYLE}">${esc(copy.title)}</p>
  <p style="${BODY_STYLE};margin:8px 0 14px">${esc(copy.body)}</p>
  <a href="${FOR_EMPLOYERS_PATH[l]}" class="s-cta" data-employer-cta="${esc(surface)}">${esc(copy.cta)} →</a>
</section>`;
}

/**
 * Job-detail-page variant — reuses the job template's own `.section` /
 * `.lnk-acc` classes (public/assets/seo-static.css) so the block inherits the
 * page look without new CSS. Non-invasive: rendered in the footer content
 * area, right before the closing `<nav class="fn">`.
 */
export function renderEmployerCtaJobPage(locale: string, surface: string): string {
  const l = normalizeLocale(locale);
  const copy = EMPLOYER_CTA_COPY[l];
  return `<section class="section" aria-label="${esc(copy.title)}">
  <h4>${esc(copy.title)}</h4>
  <p>${esc(copy.body)}</p>
  <a href="${FOR_EMPLOYERS_PATH[l]}" class="s-cta" data-employer-cta="${esc(surface)}">${esc(copy.cta)} →</a>
</section>`;
}
