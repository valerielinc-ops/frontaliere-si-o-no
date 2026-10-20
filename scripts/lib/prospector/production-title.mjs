const GENERIC_VACANCY_TITLES = new Set([
  'header', 'home', 'menu', 'navigation', 'search', 'job search', 'jobs search',
  'job', 'jobs', 'career', 'careers', 'vacancy', 'vacancies', 'open jobs',
  'open positions', 'positionen', 'offene stellen', 'stellenangebot',
  'stellenangebote', 'stellen', 'annunci', 'offerte', 'posizioni aperte',
  'offres', 'offres d emploi', 'offre d emploi', 'emplois', 'recherche',
  'mehr erfahren', 'weitere informationen', 'weiterlesen', 'read more',
  'learn more', 'apply now', 'jetzt bewerben', 'zum job', 'zur stelle',
  'en savoir plus', 'scopri di piu',
]);

/**
 * Read title evidence directly from the raw detail-page markup. These signals
 * remain independent of the crawler's structured-detail extractor and its
 * final output title.
 *
 * @param {string} html
 * @returns {{ rawH1Title: string, rawDocumentTitle: string }}
 */
export function rawDetailTitleEvidence(html = '') {
  const h1 = /<h1\b[^>]*>([\s\S]{0,1000}?)<\/h1>/i.exec(String(html))?.[1] || '';
  const documentTitle = /<title\b[^>]*>([\s\S]{0,1000}?)<\/title>/i.exec(String(html))?.[1] || '';
  const clean = (value) => String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    rawH1Title: clean(h1),
    rawDocumentTitle: clean(documentTitle),
  };
}

function normalizedTitle(value) {
  return String(value || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value */
export function isGenericVacancyTitle(value) {
  return GENERIC_VACANCY_TITLES.has(normalizedTitle(value));
}

/**
 * Prefer the detail-page title only when it names a vacancy. Some sources put
 * a generic layout heading such as "Header" in the detail H1 while the listing
 * still carries the real role title; publishing the H1 would replace good
 * listing evidence with detail chrome. Raw H1 and document-title evidence are
 * later fallbacks when both extracted fields are generic calls to action.
 *
 * @param {unknown} detailTitle
 * @param {unknown} listingTitle
 * @param {unknown[]} [rawDetailTitles]
 * @returns {string}
 */
export function selectPublishableTitle(detailTitle, listingTitle, rawDetailTitles = []) {
  for (const value of [detailTitle, listingTitle, ...rawDetailTitles]) {
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    if (title && !isGenericVacancyTitle(title)) return title;
  }
  return '';
}
