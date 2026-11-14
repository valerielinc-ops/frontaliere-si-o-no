import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import {  isTargetSwissLocation, inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { sourceLangOfBody } from './source-locale-slots.mjs';
import { hasExplicitEmptyJobListing } from './job-listing-evidence.mjs';
import { extractJobPostingNodes } from './jobposting-jsonld.mjs';

const HQ = getCompanyDefaults('delvitech');
const DELVITECH_LEGACY_CAREER_URL = 'https://legacy.delvi.tech/career/';
const DELVITECH_NAV_PATH_RE = /^\/(?:about(?:-us)?|company|contact|industr(?:y|ies)|news|solutions?|technology|sustainability|certifications?)(?:\/|$)/i;
const DELVITECH_CAREER_ROOT_RE = /^\/careers?\/?$/i;
const GENERIC_ROLE_LINK_TEXT_RE = /^(?:apply(?: now)?|learn more|read more|see (?:open )?roles?|view (?:role|details?)|discover more)$/i;
const LISTING_CONTAINER_SELECTOR = [
  '.post-content',
  'main',
  '[role="main"]',
  'section[id*="job" i]',
  'section[id*="role" i]',
  'section[id*="career" i]',
  'section[class*="job" i]',
  'section[class*="role" i]',
  'section[class*="career" i]',
  '[data-job-list]',
  '[data-testid*="job" i]',
  '[class*="job-list" i]',
  '[class*="role-list" i]',
  '[class*="career-list" i]',
].join(', ');

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

function htmlToText(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;/g, "'")
    .replace(/&#038;/g, '&')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeSectionHeading(text = '') {
  const value = normalizeSpace(text);
  if (!value || value.length > 70) return false;
  return /^[A-Z0-9&/ +()-]+$/.test(value);
}

function inferLocation(text = '') {
  const value = normalizeSpace(text);
  if (/germany/i.test(value)) return 'Germany';
  if (/mendrisio/i.test(value)) return 'Mendrisio';
  if (/ticino|tessin/i.test(value)) return 'Mendrisio';
  if (/switzerland/i.test(value)) return 'Mendrisio';
  return '';
}

function resolveDelvitechDetailUrl(rawHref = '', baseUrl = DELVITECH_LEGACY_CAREER_URL) {
  try {
    const url = new URL(String(rawHref || '').trim(), baseUrl);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (host !== 'legacy.delvi.tech' && host !== 'delvi.tech' && !host.endsWith('.delvi.tech')) return '';
    if (!url.pathname || url.pathname === '/' || DELVITECH_CAREER_ROOT_RE.test(url.pathname) || DELVITECH_NAV_PATH_RE.test(url.pathname)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizedHref(anchor, baseUrl) {
  return resolveDelvitechDetailUrl(anchor?.getAttribute?.('href') || '', baseUrl);
}

function roleCardForAnchor(anchor) {
  return anchor.closest(
    'article, li, [data-job-card], [data-job], [data-role-card], [class*="job-card" i], [class*="role-card" i], [class*="career-card" i], [class*="job-item" i], [class*="role-item" i], [class*="career-item" i], .fusion-layout-column',
  ) || anchor.parentElement;
}

function roleTitleForAnchor(anchor) {
  const card = roleCardForAnchor(anchor);
  const heading = card?.querySelector?.(
    '[data-job-title], [data-role-title], h1, h2, h3, h4, h5, h6, [class*="job-title" i], [class*="role-title" i], [class*="career-title" i]',
  );
  const headingText = normalizeSpace(heading?.textContent || '');
  if (headingText) return headingText;
  const anchorText = normalizeSpace(anchor?.textContent || '');
  return GENERIC_ROLE_LINK_TEXT_RE.test(anchorText) ? '' : anchorText;
}

function isListingContainer(element) {
  if (!element) return false;
  const text = normalizeSpace(element.textContent || '');
  const hasListingHeading = /\b(?:open\s+roles?|open\s+positions?|job\s+openings?|vacanc(?:y|ies)|available\s+(?:roles?|positions?))\b/i.test(text);
  const hasRoleAttribute = /(?:job|role|career|vacanc|position)/i.test(
    [element.id, element.getAttribute?.('class'), element.getAttribute?.('data-testid')].filter(Boolean).join(' '),
  );
  return hasListingHeading || hasRoleAttribute;
}

function findListingContainer(document) {
  const candidates = [...document.querySelectorAll(LISTING_CONTAINER_SELECTOR)];
  return candidates.find(isListingContainer)
    || candidates.find((candidate) => candidate.matches?.('.post-content'))
    || null;
}

function collectSemanticListingAnchors(listingContainer) {
  if (!listingContainer) return [];
  return [...listingContainer.querySelectorAll('a[href], [data-job-url], [data-role-url]')]
    .map((element) => {
      if (element.matches?.('a[href]')) return element;
      const href = element.getAttribute('data-job-url') || element.getAttribute('data-role-url') || '';
      const anchor = element.ownerDocument.createElement('a');
      anchor.setAttribute('href', href);
      anchor.textContent = element.getAttribute('data-job-title') || element.textContent || '';
      return anchor;
    });
}

function collectStructuredListings(html, baseUrl) {
  return extractJobPostingNodes(html)
    .map((posting) => ({
      href: resolveDelvitechDetailUrl(posting.url || posting.mainEntityOfPage?.['@id'] || posting.mainEntityOfPage, baseUrl),
      title: normalizeSpace(posting.title || ''),
    }))
    .filter(({ href, title }) => Boolean(href && title));
}

export function parseDelvitechCareerPage(html = '', pageUrl = DELVITECH_LEGACY_CAREER_URL) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const listingContainer = findListingContainer(document);
  const legacyCards = [...document.querySelectorAll('.post-content a.fusion-column-anchor[href]')]
    .map((anchor) => ({
      anchor,
      href: normalizedHref(anchor, pageUrl),
    }))
    .filter(({ href }) => Boolean(href));
  const semanticCards = collectSemanticListingAnchors(listingContainer)
    .filter((anchor) => !anchor.matches?.('.fusion-column-anchor'))
    .map((anchor) => ({ anchor, href: normalizedHref(anchor, pageUrl) }))
    .filter(({ href }) => Boolean(href));
  const structuredListings = collectStructuredListings(html, pageUrl);
  const seen = new Set();
  const jobs = [];
  let skippedMalformedRows = 0;

  for (const { anchor, href } of [...legacyCards, ...semanticCards]) {
    if (seen.has(href)) continue;
    seen.add(href);

    const card = anchor.closest('.fusion-layout-column')
      || anchor.parentElement?.nextElementSibling
      || anchor.nextElementSibling
      || roleCardForAnchor(anchor);
    const title = normalizeSpace(
      card?.querySelector?.('h5')?.textContent
        || roleTitleForAnchor(anchor)
        || '',
    );
    if (!title) {
      skippedMalformedRows += 1;
      continue;
    }
    jobs.push({ href, title });
  }

  for (const { href, title } of structuredListings) {
    if (seen.has(href)) continue;
    seen.add(href);
    jobs.push({ href, title });
  }

  Object.defineProperties(jobs, {
    delvitechListingMarkupSeen: { value: Boolean(listingContainer) || structuredListings.length > 0, enumerable: false },
    delvitechListingRecordCount: { value: legacyCards.length + semanticCards.length + structuredListings.length, enumerable: false },
    delvitechListingSkippedMalformedRows: { value: skippedMalformedRows, enumerable: false },
    delvitechListingEmptyStateObserved: {
      value: hasExplicitEmptyJobListing(listingContainer, {
        scopedToListing: Boolean(listingContainer),
      }),
      enumerable: false,
    },
  });
  return jobs;
}

export function parseDelvitechJobDetail(html = '', url = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const root = document.querySelector('.post-content, main, [role="main"]') || document.body;
  const structuredPosting = extractJobPostingNodes(html)[0] || {};
  const structuredTitle = normalizeSpace(structuredPosting.title || '');
  const title = normalizeSpace(root.querySelector('h1')?.textContent || structuredTitle);
  const email = String(root.querySelector('a[href^="mailto:"]')?.getAttribute('href') || '')
    .replace(/^mailto:/i, '')
    .trim();
  let datePublished = '';
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const value = JSON.parse(script.textContent || '{}');
      const nodes = Array.isArray(value) ? value : (Array.isArray(value?.['@graph']) ? value['@graph'] : [value]);
      const pages = nodes.filter((node) => {
        const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
        if (!types.includes('WebPage')) return false;
        try {
          const source = new URL(node.url || node['@id']);
          const detail = new URL(url);
          return source.origin === detail.origin
            && source.pathname.replace(/\/+$/, '') === detail.pathname.replace(/\/+$/, '');
        } catch {
          return false;
        }
      });
      if (pages.length === 1) datePublished = String(pages[0].datePublished || '').trim();
    } catch {
      // Ignore unrelated malformed JSON-LD blocks; page identity remains required.
    }
  }
  if (!datePublished) datePublished = String(structuredPosting.datePosted || '').trim();

  const mainContainer = root.querySelector('.fusion-fullwidth') || root;
  const textBlocks = [...mainContainer.querySelectorAll('.fusion-text')];
  const sections = [];
  let currentHeading = '';
  let currentBody = [];

  const flush = () => {
    if (!currentHeading && currentBody.length === 0) return;
    const block = [];
    if (currentHeading) block.push(`## ${currentHeading}`);
    if (currentBody.length) block.push(currentBody.join('\n\n'));
    sections.push(block.join('\n\n').trim());
    currentHeading = '';
    currentBody = [];
  };

  for (const block of textBlocks) {
    const h = normalizeSpace(block.querySelector('h2,h3,h4,h5,strong')?.textContent || '');
    const listItems = [...block.querySelectorAll('li')]
      .map((item) => normalizeSpace(item.textContent || ''))
      .filter(Boolean);
    const prose = normalizeSpace(htmlToText(block.innerHTML || block.textContent || ''));
    const contentWithoutHeading = prose === h ? '' : prose;

    if (looksLikeSectionHeading(h)) {
      flush();
      currentHeading = h;
      if (listItems.length) currentBody.push(listItems.map((item) => `- ${item}`).join('\n'));
      else if (contentWithoutHeading) currentBody.push(contentWithoutHeading);
      continue;
    }

    if (listItems.length) {
      currentBody.push(listItems.map((item) => `- ${item}`).join('\n'));
    } else if (contentWithoutHeading) {
      currentBody.push(contentWithoutHeading);
    }
  }
  flush();

  const description = sections.join('\n\n').trim()
    || htmlToText(structuredPosting.description || '');
  const structuredLocations = Array.isArray(structuredPosting.jobLocation)
    ? structuredPosting.jobLocation
    : [structuredPosting.jobLocation].filter(Boolean);
  const structuredLocation = structuredLocations.flatMap((locationEntry) => {
    const address = locationEntry?.address || {};
    const country = typeof address.addressCountry === 'object'
      ? address.addressCountry.name || address.addressCountry['@id']
      : address.addressCountry;
    return [
      locationEntry?.name,
      address.addressLocality,
      address.postalCode,
      address.streetAddress,
      country,
    ].filter((value) => typeof value === 'string' && value.trim());
  }).join(', ');
  const location = inferLocation(`${structuredLocation}\n${title}\n${description}\n${url}`);
  return {
    title,
    location,
    description,
    email,
    datePublished,
  };
}

export function isDelvitechTicinoJob(detail = {}) {
  const location = normalizeSpace(detail.location || '');
  // The source location is authoritative. Description prose can mention
  // foreign countries as customers, partners, or travel destinations without
  // changing the vacancy's workplace; including it here turned a valid Swiss
  // detail into a false source-zero candidate.
  if (isLocationExplicitlyForeign(location)) return false;
  if (/germany/i.test(location)) return false;
  return isTargetSwissLocation(location) || /switzerland/i.test(location);
}

export function inferDelvitechCategory(title = '', description = '') {
  const haystack = normalizeSpace(`${title} ${description}`).toLowerCase();
  if (/(sales|support|back office|customer)/.test(haystack)) return 'sales';
  if (/(project manager|office manager)/.test(haystack)) return 'admin';
  if (/(engineer|developer|firmware|software|devops|test)/.test(haystack)) return 'engineering';
  return 'other';
}

/**
 * Title, body and slug of a posting in the SOURCE slot only: the language the
 * body is written in (English for today's postings), never a fixed `en` key.
 * The other slots belong to the translation pipeline. The slug keeps its
 * formula (title + company + location), so existing jobs keep the value they
 * already publish.
 *
 * @param {{ title?: string, location?: string, description?: string }} detail
 * @returns {{ sourceLang: string, slug: string, titleByLocale: object, descriptionByLocale: object, slugByLocale: object }}
 */
export function buildDelvitechLocalizedContent(detail = {}) {
  const sourceTitle = normalizeSpace(detail.title || '');
  const sourceDesc = String(detail.description || '').trim();
  const location = detail.location || 'Mendrisio';
  const baseSlug = slugify(`${sourceTitle} Delvitech ${location}`);
  const sourceLang = sourceLangOfBody(sourceDesc, 'en');
  return {
    sourceLang,
    slug: baseSlug,
    titleByLocale: { [sourceLang]: sourceTitle },
    descriptionByLocale: { [sourceLang]: sourceDesc },
    slugByLocale: { [sourceLang]: baseSlug },
  };
}

/** Infer canton (TI or GR) from location/detail text. Falls back to HQ canton. */
export function inferDelvitechCanton(detail = {}) {
  // Location-first: resolve the specific location before the noisier title and
  // description text, so it wins over inferAnyCanton's TARGET_CANTONS array-order
  // sensitivity (a combined string could let an unrelated canton name override).
  return inferAnyCanton(detail.location || '')
    || inferAnyCanton(detail.title || '')
    || inferAnyCanton(detail.description || '')
    || HQ.canton;
}
