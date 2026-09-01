import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation, TARGET_CANTONS  } from './target-swiss-locations.mjs';
import { assertRssChannelItems } from './assert-json-list-shape.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readOptionalRssScalar(item, field, itemNumber) {
  const value = item?.[field];
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new Error(`Ariston RSS item ${itemNumber} ${field} must be a single scalar string`);
  }
  return value;
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
  // The SuccessFactors RSS feed carries an authoritative ISO country marker
  // in every location (for example `Bedano, CH, 6930`). Require that marker
  // before applying fuzzy municipality/canton matching: otherwise German
  // vacancies mentioning names such as Koblenz are mistaken for their Swiss
  // homonyms and published on the CH board.
  const countryMatch = String(rawLocation || '').match(/,\s*([a-z]{2})\s*,\s*(?:\d{4}|x)(?=\s|$)/i);
  if (!countryMatch || countryMatch[1].toUpperCase() !== 'CH') return false;
  return isTargetSwissLocation(rawLocation);
}

export function inferAristonRegion(rawLocation = '') {
  const canton = inferAnyCanton(rawLocation);
  return {
    canton: canton || '',
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
  if (typeof xml !== 'string') {
    throw new Error('Ariston sitemap feed failed to parse as XML: expected a string');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const detail = validation?.err?.msg || validation?.err?.code || 'invalid XML';
    throw new Error(`Ariston sitemap feed failed to parse as XML: ${detail}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: false,
  });
  // The genuine feed is well-formed RSS/XML (depth ~4, ~180 <item>s) and always
  // parses cleanly. A parse-time throw here (fast-xml-parser's strict XMLParser,
  // e.g. "Maximum nested tags exceeded") means `xml` is NOT the real feed — most
  // likely fetchHtml's Jina fallback (crawler-template.mjs) fired on a
  // connection-level failure / WAF-block status and Jina's `X-Return-Format: html`
  // re-rendered the feed as an HTML DOM tree with unclosed void elements (<br>,
  // <meta>) that never pop off fast-xml-parser's strict tag stack, so it grows
  // unbounded across every item and blows past maxNestedTags (verified live:
  // https://r.jina.ai/<feed> with X-Return-Format:html reproduces the exact
  // error). Surface a clear, low-drama error instead of the opaque library
  // exception and let it propagate the SAME way as the zero-feed guard below
  // (thrown before fetchAristonListings' caller writes anything → safe-fail,
  // existing dataset preserved) rather than crashing with an unrecognisable
  // library-internal message (#4246).
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new Error(`Ariston sitemap feed failed to parse as XML: ${err?.message || err}`);
  }
  const normalizedItems = assertRssChannelItems(parsed, { source: 'ariston' });
  return normalizedItems
    .map((item, index) => {
      const itemNumber = index + 1;
      try {
        const namespacedLocation = readOptionalRssScalar(item, 'g:location', itemNumber);
        const fallbackLocation = readOptionalRssScalar(item, 'location', itemNumber);
        return {
          title: normalizeSpace(readOptionalRssScalar(item, 'title', itemNumber)),
          url: normalizeSpace(readOptionalRssScalar(item, 'link', itemNumber)),
          location: normalizeSpace(namespacedLocation || fallbackLocation),
          employer: normalizeSpace(readOptionalRssScalar(item, 'g:employer', itemNumber)),
          category: normalizeSpace(readOptionalRssScalar(item, 'g:job_function', itemNumber)),
          validThrough: normalizeSpace(readOptionalRssScalar(item, 'g:expiration_date', itemNumber)),
        };
      } catch (err) {
        // Per-item guard: one degenerate leaf (non-scalar/repeated field) must
        // not zero out the whole ~180-item feed. Feed-shape drift (malformed
        // XML, missing envelope) still throws above, before this map.
        console.warn(`⚠️ Ariston RSS item ${itemNumber} skipped: ${err?.message || err}`);
        return null;
      }
    })
    .filter((item) => item && item.title && item.url && item.location);
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
