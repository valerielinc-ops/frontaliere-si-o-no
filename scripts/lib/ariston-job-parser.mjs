import { XMLParser } from 'fast-xml-parser';
import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation, TARGET_CANTONS  } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function htmlToText(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function localizeAristonTitle(rawTitle = '', locale = 'it') {
  const title = String(rawTitle || '').trim();
  if (!title) return '';
  if (locale === 'it') return title;
  if (/^COLLABORATORE\/TRICE SERVICE CENTER 80%$/i.test(title)) {
    if (locale === 'en') return 'Service Center Associate 80%';
    if (locale === 'de') return 'Mitarbeiter:in Service Center 80%';
    if (locale === 'fr') return 'Collaborateur/trice Service Center 80%';
  }
  return title;
}

export function isAristonTargetLocation(rawLocation = '') {
  return isTargetSwissLocation(rawLocation);
}

export function inferAristonRegion(rawLocation = '') {
  const canton = inferAnyCanton(rawLocation);
  return {
    canton: canton || TARGET_CANTONS[0],
    country: 'CH',
  };
}

export function inferAristonCategory(title = '', description = '') {
  const haystack = `${title} ${description}`.toLowerCase();
  if (/(service|servicetechnik|field|trainer|technical|tecnico)/i.test(haystack)) return 'engineering';
  if (/(sales|vente|commercial|verkauf|consul)/i.test(haystack)) return 'sales';
  if (/(backoffice|customer|service center|assist)/i.test(haystack)) return 'admin';
  return 'other';
}

export function parseAristonSitemapFeed(xml = '') {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: false,
  });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  const normalizedItems = Array.isArray(items) ? items : [items];
  return normalizedItems
    .map((item) => ({
      title: normalizeSpace(item?.title || ''),
      url: normalizeSpace(item?.link || ''),
      location: normalizeSpace(item?.['g:location'] || item?.location || ''),
      employer: normalizeSpace(item?.['g:employer'] || ''),
      category: normalizeSpace(item?.['g:job_function'] || ''),
      validThrough: normalizeSpace(item?.['g:expiration_date'] || ''),
    }))
    .filter((item) => item.title && item.url && item.location);
}

function extractDescriptionSections(body) {
  const sections = [];
  if (!body) return sections;
  let currentHeading = '';
  let currentBlocks = [];
  const flush = () => {
    if (!currentHeading && currentBlocks.length === 0) return;
    const parts = [];
    if (currentHeading) parts.push(`## ${currentHeading}`);
    if (currentBlocks.length > 0) parts.push(currentBlocks.join('\n\n'));
    sections.push(parts.join('\n\n').trim());
    currentHeading = '';
    currentBlocks = [];
  };

  for (const node of [...body.children]) {
    const tag = node.tagName?.toLowerCase() || '';
    if (tag === 'h2' || tag === 'h3') {
      flush();
      currentHeading = normalizeSpace(node.textContent || '');
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const bullets = [...node.querySelectorAll('li')]
        .map((item) => normalizeSpace(htmlToText(item.innerHTML || '')))
        .filter(Boolean)
        .map((item) => `- ${item}`);
      if (bullets.length > 0) currentBlocks.push(bullets.join('\n'));
      continue;
    }
    const prose = normalizeSpace(htmlToText(node.outerHTML || node.textContent || ''));
    if (prose) currentBlocks.push(prose);
  }
  flush();
  return sections;
}

export function parseAristonJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  const title = normalizeSpace(
    document.querySelector('.job .title, .jobTitle h1, .job h1, .jobDisplay h1, .title-page h1')?.textContent ||
    document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
    ''
  );
  const location = normalizeSpace(
    document.querySelector('.jobGeoLocation')?.textContent ||
    document.querySelector('#job-location')?.textContent ||
    ''
  );
  const postedDate = normalizeSpace(document.querySelector('meta[itemprop="datePosted"]')?.getAttribute('content') || '');
  const validThrough = normalizeSpace(document.querySelector('meta[itemprop="validThrough"]')?.getAttribute('content') || '');
  const applyHref = normalizeSpace(document.querySelector('a.apply.dialogApplyBtn')?.getAttribute('href') || '');
  const body = document.querySelector('.jobdescription');
  const sections = extractDescriptionSections(body);
  const description = sections.join('\n\n').trim() || normalizeSpace(htmlToText(body?.innerHTML || ''));

  return {
    title,
    location,
    postedDate,
    validThrough,
    applyHref,
    description,
  };
}

export function buildAristonLocalizedContent(detail = {}) {
  const sourceTitle = String(detail.title || '').trim();
  const location = String(detail.location || '').trim();
  const titleByLocale = {
    it: localizeAristonTitle(sourceTitle, 'it'),
    en: localizeAristonTitle(sourceTitle, 'en'),
    de: localizeAristonTitle(sourceTitle, 'de'),
    fr: localizeAristonTitle(sourceTitle, 'fr'),
  };
  return {
    titleByLocale,
    slugByLocale: {
      it: slugify(`${titleByLocale.it} Ariston Group ${location}`),
      en: slugify(`${titleByLocale.en} Ariston Group ${location}`),
      de: slugify(`${titleByLocale.de} Ariston Group ${location}`),
      fr: slugify(`${titleByLocale.fr} Ariston Group ${location}`),
    },
    descriptionByLocale: {
      it: detail.description || '',
    },
  };
}
