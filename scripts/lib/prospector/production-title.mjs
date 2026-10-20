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
 * Read a quoted or unquoted HTML attribute without depending on its position
 * among the other attributes in the tag.
 *
 * @param {string} tag
 * @param {'property'|'name'|'content'} attributeName
 * @returns {string}
 */
function readHtmlAttribute(tag, attributeName) {
  const pattern = new RegExp(
    `(?:^|\\s)${attributeName}\\s*=\\s*(?:"([^"]{0,1000})"|'([^']{0,1000})'|([^\\s>]{1,1000}))`,
    'i',
  );
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

/**
 * Extract meta tags while treating `>` inside a quoted attribute as content.
 *
 * @param {string} html
 * @returns {string[]}
 */
function metaTagsFromHtml(html) {
  const source = String(html);
  const tags = [];
  const openingTag = /<meta\b/gi;
  let match;
  while ((match = openingTag.exec(source))) {
    const start = match.index;
    let quote = '';
    let end = start + match[0].length;
    let closed = false;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        closed = true;
        end++;
        break;
      }
    }
    if (closed) tags.push(source.slice(start, end));
    openingTag.lastIndex = end;
  }
  return tags;
}

/**
 * Read title evidence directly from the raw detail-page markup. These signals
 * remain independent of the crawler's structured-detail extractor and its
 * final output title.
 *
 * @param {string} html
 * @returns {{ rawH1Title: string, rawOpenGraphTitle: string, rawDocumentTitle: string }}
 */
export function rawDetailTitleEvidence(html = '') {
  const source = String(html);
  const h1 = /<h1\b[^>]*>([\s\S]{0,1000}?)<\/h1>/i.exec(source)?.[1] || '';
  let openGraphTitle = '';
  for (const tag of metaTagsFromHtml(source)) {
    const property = readHtmlAttribute(tag, 'property').toLowerCase();
    const name = readHtmlAttribute(tag, 'name').toLowerCase();
    if (property !== 'og:title' && name !== 'og:title') continue;
    const content = readHtmlAttribute(tag, 'content');
    if (content) {
      openGraphTitle = content;
      break;
    }
  }
  const documentTitle = /<title\b[^>]*>([\s\S]{0,1000}?)<\/title>/i.exec(source)?.[1] || '';
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
    rawOpenGraphTitle: clean(openGraphTitle),
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
 * A document title often appends the site's breadcrumb after the vacancy name.
 * Use only its leading segment; a chrome-only title such as "Careers | Employer"
 * therefore remains generic and cannot become a vacancy title.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function vacancyTitleFromDocumentTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) return '';
  return title.split(/\s+(?:\||–|—|-)\s+/)[0]?.trim() || '';
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
 * @param {unknown[]} [rawDetailTitles] Raw H1, Open Graph and document title evidence, in priority order
 * @returns {string}
 */
export function selectPublishableTitle(detailTitle, listingTitle, rawDetailTitles = []) {
  const rawTitles = Array.isArray(rawDetailTitles) ? rawDetailTitles : [];
  const documentTitle = rawTitles.at(-1);
  for (const value of [detailTitle, listingTitle, ...rawTitles.slice(0, -1)]) {
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    if (title && !isGenericVacancyTitle(title)) return title;
  }
  const documentTitleCandidate = vacancyTitleFromDocumentTitle(documentTitle);
  if (documentTitleCandidate && !isGenericVacancyTitle(documentTitleCandidate)) return documentTitleCandidate;
  return '';
}
