/**
 * Evidence extraction for Umantis tenants promoted through the Prospector.
 *
 * Umantis is a multi-tenant renderer rather than one stable HTML template.
 * These helpers recognise the small set of semantic containers emitted by its
 * current layouts while keeping the generic crawler fail-closed: no employer
 * default is invented when a page does not expose a vacancy location.
 */
import { readAttr, readMetaContent, scanHtmlTags } from '../html-attr.mjs';
import { decodeEntities } from './entities.mjs';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** @param {string} raw */
function classTokens(raw) {
  return readAttr(raw, 'class').toLowerCase().split(/\s+/).filter(Boolean);
}

/** @param {string} html */
function indexContainers(html) {
  const tags = scanHtmlTags(html);
  const pending = new Map();
  const bounds = new Map();
  for (const tag of tags) {
    if (!tag.closing) {
      if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
        if (!pending.has(tag.name)) pending.set(tag.name, []);
        pending.get(tag.name).push(tag);
      }
      continue;
    }
    const opening = pending.get(tag.name)?.pop();
    if (opening) bounds.set(opening.index, { contentEnd: tag.index, end: tag.end });
  }
  return { tags: tags.filter((tag) => !tag.closing), bounds };
}

/** @param {string} html @param {ReturnType<typeof indexContainers>} index @param {(tag: any) => boolean} predicate */
function containersMatching(html, index, predicate) {
  const out = [];
  let consumedUntil = 0;
  for (const tag of index.tags) {
    if (tag.index < consumedUntil || !predicate(tag)) continue;
    const bound = index.bounds.get(tag.index);
    if (!bound) continue;
    out.push(html.slice(tag.index, bound.end));
    consumedUntil = bound.end;
  }
  return out;
}

/**
 * Preserve headings and bullets while dropping markup. The produced string is
 * intentionally plain text because job slices store descriptions as text, but
 * line boundaries retain the useful vacancy structure.
 * @param {string} html
 */
function structuredText(html = '') {
  return decodeEntities(String(html || '')
    .replace(/<(?:script|style|template)\b[\s\S]*?<\/(?:script|style|template)\s*>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|div|section|article|h[1-6]|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && line !== '-->')
    .join('\n')
    .trim();
}

/** @param {string} value */
function cleanLocation(value = '') {
  return decodeEntities(String(value || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/^(?:\s*[|◆·•–—-]\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} value */
function locationCandidate(value = '') {
  const location = cleanLocation(value);
  if (!location) return null;
  const postalMatch = /\b(\d{4})\b/.exec(location);
  const countryMatch = /(?:,|\s)\s*(CH)\s*$/i.exec(location);
  const addressLocality = location
    .replace(/^\d{4}\s+/, '')
    .replace(/,\s*CH\s*$/i, '')
    .trim();
  return {
    // Keep postal data structured. Feeding `9000 St. Gallen` to the locality
    // resolver hides otherwise strong municipality evidence behind the CAP.
    location: postalMatch ? addressLocality : location,
    addressLocality,
    addressRegion: '',
    addressCountry: countryMatch ? 'CH' : '',
    postalCode: postalMatch?.[1] || '',
    streetAddress: '',
  };
}

/** @param {string} url */
export function umantisVacancyIdentity(url = '') {
  try {
    return /\/Vacancies\/(\d+)\//i.exec(new URL(url).pathname)?.[1] || '';
  } catch {
    return '';
  }
}

/**
 * Read row-scoped listing location evidence. Older Umantis tenants commonly
 * publish the authoritative postal locality beside the vacancy link, while
 * the detail page contains only prose.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {Map<string, ReturnType<typeof locationCandidate>>}
 */
export function extractUmantisListingEvidence(html = '', baseUrl = '') {
  const source = String(html || '');
  const index = indexContainers(source);
  const rows = containersMatching(source, index, (tag) => tag.name === 'tr');
  const evidence = new Map();
  for (const row of rows) {
    const rowIndex = indexContainers(row);
    const anchor = rowIndex.tags.find((tag) => {
      if (tag.name !== 'a') return false;
      try { return Boolean(umantisVacancyIdentity(new URL(readAttr(tag.raw, 'href'), baseUrl).toString())); } catch { return false; }
    });
    if (!anchor) continue;
    let vacancyId = '';
    try { vacancyId = umantisVacancyIdentity(new URL(readAttr(anchor.raw, 'href'), baseUrl).toString()); } catch { continue; }
    let rawLocation = '';
    for (const span of rowIndex.tags.filter((tag) => tag.name === 'span')) {
      const classes = classTokens(span.raw);
      const bound = rowIndex.bounds.get(span.index);
      if (!bound) continue;
      const value = structuredText(row.slice(span.end, bound.contentEnd));
      if (classes.some((token) => /(?:location|standort|arbeitsort)/i.test(token))
        || classes.some((token) => token === 'tableaslist_element_26476')) {
        rawLocation = value.replace(/^\s*\|\s*/, '');
        if (rawLocation) break;
      }
    }
    if (!rawLocation) {
      rawLocation = /(?:Standort|Arbeitsort|Lieu de travail|Location)\s*:\s*([^\n|]{2,80})/i.exec(structuredText(row))?.[1] || '';
    }
    const candidate = locationCandidate(rawLocation);
    if (vacancyId && candidate) evidence.set(vacancyId, candidate);
  }
  return evidence;
}

/**
 * Extract a vacancy-only description and rendered location from the supported
 * Umantis layouts. Navigation, consent chrome and footer content are outside
 * the selected containers and therefore never enter the result.
 * @param {string} html
 * @returns {{description: string, locationCandidates: Array<NonNullable<ReturnType<typeof locationCandidate>>>}}
 */
export function extractUmantisDetailFields(html = '') {
  const source = String(html || '');
  if (!source) return { description: '', locationCandidates: [] };
  const index = indexContainers(source);

  const customBlocks = containersMatching(source, index, (tag) => classTokens(tag.raw).includes('customdatablock'))
    .map(structuredText)
    .filter((text) => text.length >= 20);

  let description = customBlocks.join('\n\n');
  if (!description) {
    const bodyContainers = containersMatching(source, index, (tag) => {
      const classes = classTokens(tag.raw);
      return tag.name === 'main'
        || classes.includes('blog-main')
        || classes.includes('content-main');
    });
    description = bodyContainers.map(structuredText).sort((a, b) => b.length - a.length)[0] || '';
  }

  let rawLocation = '';
  const iconBox = containersMatching(source, index, (tag) => tag.name === 'ul' && classTokens(tag.raw).includes('icon-box'))[0] || '';
  if (iconBox) {
    rawLocation = structuredText(iconBox).split('\n').find((line) => /,\s*CH\s*$/i.test(line)) || '';
  }
  if (!rawLocation) {
    const intro = containersMatching(source, index, (tag) => classTokens(tag.raw).includes('intro'))[0] || '';
    const introLine = structuredText(intro).split('\n').find((line) => line.includes('◆')) || '';
    if (introLine) rawLocation = introLine.split('◆').map(cleanLocation).find((part) => part && !/%|\bw\s*\/\s*m\s*\/\s*d\b/i.test(part)) || '';
  }
  if (!rawLocation) {
    const meta = cleanLocation(readMetaContent(source, 'og:description'));
    const searchable = [meta, description].filter(Boolean).join('\n');
    rawLocation = /(?:Standort|Arbeitsort|Arbeitsplatz|Lieu de travail|Location)\s*:\s*([^\n|]{2,80}?)(?=\n|\s+(?:Kategorie|Category|Beginn|Anstellungsart|Pensum|Befristung)\s*:|$)/i.exec(searchable)?.[1] || '';
  }
  const candidate = locationCandidate(rawLocation);
  return { description, locationCandidates: candidate ? [candidate] : [] };
}

/**
 * Some legacy tenants respond with a headerless 302 from Description/N when
 * used through a pinned Undici dispatcher, but serve the same vacancy at the
 * documented same-origin `/Default` form. The original URL remains canonical.
 * @param {string} url
 */
export function umantisDetailFallbackUrl(url = '') {
  try {
    const parsed = new URL(url);
    if (!/\/Vacancies\/\d+\/Description\/\d+\/?$/i.test(parsed.pathname)) return '';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/Default`;
    parsed.search = '';
    return `${parsed.toString()}?`;
  } catch {
    return '';
  }
}
