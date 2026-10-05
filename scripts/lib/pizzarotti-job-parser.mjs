import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import {
  inferAnyCanton,
  isSwissLocationText,
  isTargetSwissLocation,
} from './target-swiss-locations.mjs';
import {
  isExplicitlyOutsideTarget,
  isLocationExplicitlyForeign,
} from './dedicated-crawler-common.mjs';
import { sourceLangOfBody } from './source-locale-slots.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

function htmlFragmentToMarkdown(html = '') {
  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;
  const parts = [];

  for (const node of [...body.children]) {
    const tag = node.tagName?.toLowerCase() || '';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(`## ${text}`);
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = [...node.querySelectorAll('li')]
        .map((li) => normalizeSpace(li.textContent || ''))
        .filter(Boolean)
        .map((text) => `- ${text}`);
      if (items.length) parts.push(items.join('\n'));
      continue;
    }
    const text = normalizeSpace(
      (node.innerHTML || '')
        .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(?:p|div|li)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
    );
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

/**
 * Parse InRecruiting "large" view listing page (Pizzarotti theme).
 * Each card is a `div.vacancy__render`.
 */
export function parsePizzarottiListings(html = '') {
  const document = new JSDOM(html).window.document;
  return [...document.querySelectorAll('div.vacancy__render')]
    .map((card) => {
      const titleAnchor = card.querySelector('.vacancy__title h3 a') || card.querySelector('.vacancy__title a');
      const href = String(titleAnchor?.getAttribute('href') || '').trim();
      const title = normalizeSpace(titleAnchor?.textContent || '');

      const locationSpan = card.querySelector('.subtitle__informations[title="Sede"]');
      const categorySpan = card.querySelector('.subtitle__informations[title="Professione/Funzione"]')
        || card.querySelector('.subtitle__informations[title="Profession/Fonction"]')
        || card.querySelector('.subtitle__informations[title="Profession/Function"]');

      const location = normalizeSpace(locationSpan?.textContent || '');
      const category = normalizeSpace(categorySpan?.textContent || '');
      const teaser = normalizeSpace(card.querySelector('.vacancy__description')?.textContent || '');

      return { href, title, teaser, location, category };
    })
    .filter((row) => row.href && row.title);
}

/**
 * Classify a parsed listing snapshot before the Swiss-location filter.
 *
 * An empty card set is not evidence that the source has no vacancies: it can
 * also mean that the InRecruiting markup drifted. A non-empty card set with
 * no Swiss rows is a valid filtered-empty observation and can be published.
 */
export function classifyPizzarottiListings(listings = []) {
  const rows = Array.isArray(listings) ? listings : [];
  const swissListings = rows.filter((row) => isPizzarottiSwissLocation(row.location));
  const unclassifiedLocationCount = rows.filter(
    (row) => !isPizzarottiClassifiableLocation(row.location),
  ).length;
  const lastFetchOutcome = rows.length === 0
    ? null
    : swissListings.length === 0
      ? 'filtered_empty'
      : 'ok';
  return {
    listings: swissListings,
    discovered: rows.length,
    lastFetchOutcome,
    unclassifiedLocationCount,
    // A complete non-empty board whose every location is classifiable and
    // contains no Swiss row proves the target (Swiss) slice is empty. A
    // missing or ambiguous location keeps the health advisory fail-closed.
    authoritativeEmptySnapshot: lastFetchOutcome === 'filtered_empty'
      && unclassifiedLocationCount === 0,
  };
}

/**
 * Extract total page count from InRecruiting pagination text "Pagina X di N".
 */
export function parsePizzarottiPageCount(html = '') {
  const match = html.match(/Pagina\s+\d+\s+di\s+(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * Check if a location text indicates a Swiss position (any canton).
 */
export function isPizzarottiSwissLocation(raw = '') {
  const location = normalizeSpace(raw);
  return isTargetSwissLocation(location) || isSwissLocationText(location);
}

/**
 * A location is classifiable when the source gives us positive evidence for
 * either side of the Swiss filter. Unknown/blank locations stay ambiguous:
 * they must not turn a zero result into an authoritative filtered snapshot.
 */
export function isPizzarottiClassifiableLocation(raw = '') {
  const location = normalizeSpace(raw);
  if (!location) return false;
  return isPizzarottiSwissLocation(location)
    || isLocationExplicitlyForeign(location)
    || isExplicitlyOutsideTarget(location);
}

/**
 * Infer canton from Pizzarotti location text.
 * Falls back to '' if no known canton is matched (never a non-canonical value).
 */
export function inferPizzarottiCanton(raw = '') {
  return inferAnyCanton(raw) || '';
}

/**
 * Parse InRecruiting detail page (same structure as Zucchetti detail).
 */
export function parsePizzarottiJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  const title = normalizeSpace(document.querySelector('#description__vacancy-title')?.textContent || '');
  const subtitleInfos = [...document.querySelectorAll('#description__subtitle .subtitle__informations')].map((node) =>
    normalizeSpace(node.textContent || '')
  );
  const location = subtitleInfos[0] || '';
  const category = subtitleInfos[1] || '';

  const sections = [];
  const headings = [...document.querySelectorAll('#description__body .body__headings')];
  for (const heading of headings) {
    const next = heading.nextElementSibling;
    if (!next || !next.classList.contains('body__text')) continue;
    const sectionTitle = normalizeSpace(heading.textContent || '');
    const sectionBody = htmlFragmentToMarkdown(next.innerHTML || '');
    if (!sectionBody) continue;
    sections.push(`## ${sectionTitle}\n\n${sectionBody}`);
  }

  const shareUrl = normalizeSpace(document.querySelector('.share__hidden')?.textContent || '');
  return {
    title,
    location,
    category,
    shareUrl,
    description: sections.join('\n\n').trim(),
  };
}

export function buildPizzarottiLocalizedContent(
  detail = {},
  companyName = 'Impresa Pizzarotti & C. S.p.A.',
  sourceLang = sourceLangOfBody(detail.description, 'it'),
) {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Svizzera';
  const slug = slugify(`${title} ${companyName} ${location}`);
  // Keyed by the language the ad is written in (read from the body), not a
  // fixed `it` (#5253). The slug keeps its formula.
  return {
    sourceLang,
    slug,
    titleByLocale: { [sourceLang]: title },
    descriptionByLocale: { [sourceLang]: detail.description || '' },
    slugByLocale: { [sourceLang]: slug },
  };
}
