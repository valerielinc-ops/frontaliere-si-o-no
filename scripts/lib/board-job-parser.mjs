import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { hasExplicitEmptyJobListing } from './job-listing-evidence.mjs';

// ApplyToJob/JazzHR renders this public board in pages of at most 30 rows.
// This is a source-completeness signal only; it is not a minimum vacancy gate.
export const BOARD_LISTING_FULL_PAGE_SIZE = 30;

export function hasBoardShortListingPageProof(sourceRowCount) {
  const count = Number(sourceRowCount);
  return Number.isInteger(count) && count >= 0 && count < BOARD_LISTING_FULL_PAGE_SIZE;
}

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

  for (const node of [...body.childNodes]) {
    if (node.nodeType === 3) {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(text);
      continue;
    }
    if (!node.tagName) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') {
      parts.push('');
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
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
    if (tag === 'p' || tag === 'div') {
      const inner = normalizeSpace(
        (node.innerHTML || '')
          .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
          .replace(/<\/(?:p|div|li)>/gi, '\n')
          .replace(/<li[^>]*>/gi, '- ')
          .replace(/<[^>]+>/g, ' ')
      );
      if (inner) parts.push(inner);
      continue;
    }
    const text = normalizeSpace(node.textContent || '');
    if (text) parts.push(text);
  }

  return parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readJsonLd(document) {
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')]) {
    const raw = normalizeSpace(script.textContent || '');
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed['@type'] === 'JobPosting') return parsed;
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  }
  return null;
}

function extractTextAfterIcon(container, selector) {
  const node = container?.querySelector(selector);
  return normalizeSpace(node?.textContent || '');
}

function findBoardListingContainer(document, { atsItems = [], cards = [] } = {}) {
  return document.querySelector('ul.list-group, .job-list, #job-list, [data-job-list], .career-list, .jobs-list')
    || atsItems[0]?.parentElement
    || cards[0]?.parentElement
    || null;
}

export function parseBoardListings(html = '') {
  const document = new JSDOM(html).window.document;

  // Primary: ApplyToJob ATS listing structure (li.list-group-item)
  const atsItems = [...document.querySelectorAll('li.list-group-item')];
  if (atsItems.length) {
    const listingContainer = findBoardListingContainer(document, { atsItems });
    let skippedMalformedRows = 0;
    const rows = atsItems
      .map((li) => {
        const anchor = li.querySelector('h3.list-group-item-heading a');
        if (!anchor) return null;
        const title = normalizeSpace(anchor.textContent || '');
        const href = String(anchor.getAttribute('href') || '').trim();
        const locationLi = li.querySelector('ul.list-group-item-text li');
        const location = normalizeSpace(locationLi?.textContent || '');
        return { title, location, href };
      })
      .filter((row) => {
        const valid = row && row.title && row.location && row.href;
        if (!valid) skippedMalformedRows += 1;
        return valid;
      });
    Object.defineProperties(rows, {
      boardListingMarkupSeen: { value: true, enumerable: false },
      boardListingSourceRowCount: { value: atsItems.length, enumerable: false },
      boardListingShortPageProof: {
        value: hasBoardShortListingPageProof(atsItems.length),
        enumerable: false,
      },
      boardListingSkippedMalformedRows: { value: skippedMalformedRows, enumerable: false },
      boardListingEmptyStateObserved: {
        value: hasExplicitEmptyJobListing(listingContainer?.textContent || '', {
          scopedToListing: Boolean(listingContainer),
        }),
        enumerable: false,
      },
    });
    return rows;
  }

  // Fallback: board.com card layout (legacy)
  const cards = [...document.querySelectorAll('article.card--career')];
  const listingContainer = findBoardListingContainer(document, { cards });
  let skippedMalformedRows = 0;
  const rows = cards
    .map((article) => ({
      title: normalizeSpace(article.querySelector('.card-title')?.textContent || ''),
      location: normalizeSpace(article.querySelector('.location-with-pin strong')?.textContent || ''),
      href: String(article.querySelector('a.btn-link--primary')?.getAttribute('href') || '').trim(),
    }))
    .filter((row) => {
      const valid = row.title && row.location && row.href;
      if (!valid) skippedMalformedRows += 1;
      return valid;
    });
  Object.defineProperties(rows, {
    boardListingMarkupSeen: { value: Boolean(listingContainer), enumerable: false },
    boardListingSourceRowCount: { value: cards.length, enumerable: false },
    boardListingShortPageProof: {
      value: hasBoardShortListingPageProof(cards.length),
      enumerable: false,
    },
    boardListingSkippedMalformedRows: { value: skippedMalformedRows, enumerable: false },
    boardListingEmptyStateObserved: {
      value: hasExplicitEmptyJobListing(listingContainer?.textContent || '', {
        scopedToListing: Boolean(listingContainer),
      }),
      enumerable: false,
    },
  });
  return rows;
}

export function isBoardTargetLocation(raw = '') {
  const value = normalizeSpace(raw);
  return !isLocationExplicitlyForeign(value)
    && isTargetSwissLocation(value, { includeGrigioni: true });
}

export function inferBoardCanton(raw = '') {
  return inferAnyCanton(raw) || 'TI';
}

export function parseBoardJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  const jobPosting = readJsonLd(document);
  const header = document.querySelector('.job-header');
  const descriptionNode =
    document.querySelector('#job-description') ||
    document.querySelector('.job-description');
  const canonicalUrl = String(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '').trim();

  return {
    title:
      normalizeSpace(header?.querySelector('h2')?.textContent || '') ||
      normalizeSpace(document.querySelector('h2')?.textContent || '') ||
      normalizeSpace(jobPosting?.title || ''),
    location:
      extractTextAfterIcon(header, '.job-attributes-container div[title="Location"]') ||
      normalizeSpace(jobPosting?.jobLocation?.address?.addressLocality || ''),
    region: normalizeSpace(jobPosting?.jobLocation?.address?.addressRegion || ''),
    employmentType:
      extractTextAfterIcon(header, '#resumator-job-employment') ||
      normalizeSpace(jobPosting?.employmentType || ''),
    department:
      extractTextAfterIcon(header, '.job-attributes-container div[title="Department"]') || '',
    experience:
      extractTextAfterIcon(header, '#resumator-job-experience') ||
      normalizeSpace(jobPosting?.experienceRequirements || ''),
    postedDate: normalizeSpace(jobPosting?.datePosted || ''),
    validThrough: normalizeSpace(jobPosting?.validThrough || ''),
    description: htmlFragmentToMarkdown(descriptionNode?.innerHTML || ''),
    canonicalUrl,
  };
}

export function inferBoardCategory(title = '', detail = {}) {
  const haystack = normalizeSpace(`${title} ${detail.department || ''} ${detail.description || ''}`).toLowerCase();
  if (/(engineer|developer|ux|ai|product|platform|software|designer)/.test(haystack)) return 'tech';
  if (/(consultant|account manager|sales)/.test(haystack)) return 'sales';
  if (/(financial|consolidation|finance)/.test(haystack)) return 'finance';
  return 'tech';
}

export function buildBoardLocalizedContent(detail = {}, companyName = 'Board International') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Chiasso';
  return {
    titleByLocale: {
      en: title,
    },
    descriptionByLocale: {
      en: detail.description || '',
    },
    slugByLocale: {
      en: slugify(`${title} ${companyName} ${location}`),
    },
  };
}
