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
const POSTAL_LOCALITY_LINE_RX = /^([1-9]\d{3})\s+([\p{Lu}][\p{L}.'’\-]*(?:\s+[\p{L}.'’\-]+){0,5})\s*$/u;
const LOCATION_FIELD_RX = /(?:^|[\s_-])(?:location|locality|standort|arbeitsort|arbeitsplatz|lieu(?:[\s_-]+de)?[\s_-]+travail)(?:$|[\s_-])/i;
const KNOWN_LOCATION_FIELD_RX = /\btableaslist_element_26476\b/i;
const FIELD_DESCRIPTOR_ATTRS = ['id', 'class', 'title', 'aria-label', 'aria-labelledby', 'name', 'data-field', 'data-column', 'data-name'];

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

/**
 * Read the postal/locality pair used by Umantis' newer `column-value` rows.
 * This deliberately accepts a complete metadata value only: a four-digit
 * number in arbitrary row text is not enough to become workplace evidence.
 * @param {string} value
 * @returns {string}
 */
function postalLocalityValue(value = '') {
  const text = cleanLocation(value).replace(/^\s*\|\s*/, '').trim();
  if (!text || /(?:online seit|art|befristung|berufsgruppe|unternehmensbereich)\s*:/i.test(text)) return '';
  const match = POSTAL_LOCALITY_LINE_RX.exec(text);
  return match ? `${match[1]} ${match[2].trim()}` : '';
}

/** @param {any} tag */
function fieldDescriptor(tag) {
  return FIELD_DESCRIPTOR_ATTRS.map((name) => readAttr(tag.raw, name)).filter(Boolean).join(' ');
}

/** @param {any} tag @param {ReturnType<typeof indexContainers>} index */
function containingListItem(tag, index) {
  return index.tags
    .filter((candidate) => candidate.name === 'li' && candidate.index < tag.index)
    .filter((candidate) => tag.index < (index.bounds.get(candidate.index)?.contentEnd ?? -1))
    .sort((a, b) => b.index - a.index)[0] || null;
}

/** @param {any} tag @param {ReturnType<typeof indexContainers>} rowIndex @param {string} row */
function hasProvenLocationField(tag, rowIndex, row = '') {
  const descriptor = fieldDescriptor(tag);
  if (LOCATION_FIELD_RX.test(descriptor) || KNOWN_LOCATION_FIELD_RX.test(descriptor)) return true;

  const item = containingListItem(tag, rowIndex);
  if (!item) return false;
  const itemDescriptor = fieldDescriptor(item);
  if (LOCATION_FIELD_RX.test(itemDescriptor) || KNOWN_LOCATION_FIELD_RX.test(itemDescriptor)) return true;

  const itemBound = rowIndex.bounds.get(item.index);
  if (!itemBound) return false;
  return rowIndex.tags.some((label) => {
    if (!['label', 'span'].includes(label.name)
      || label.index <= item.index || label.index >= itemBound.contentEnd) return false;
    const labelId = readAttr(label.raw, 'id');
    const labelClasses = classTokens(label.raw);
    if (!labelClasses.includes('visually-hidden') && !/(?:^|[_-])label(?:$|[_-])/i.test(labelId)) return false;
    const labelBound = rowIndex.bounds.get(label.index);
    const labelText = labelBound ? structuredText(row.slice(label.end, labelBound.contentEnd)) : '';
    return LOCATION_FIELD_RX.test(`${fieldDescriptor(label)} ${labelText}`);
  });
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
 * Read row-scoped listing location evidence. Umantis tenants publish the
 * authoritative postal locality beside the vacancy link, while the detail
 * page often contains only prose. Both the older pipe-style span and the
 * newer `column-value` metadata value are supported.
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
      // The newer Umantis table keeps row metadata in generic `column-value`
      // spans. A postal/locality pair is the source's workplace field here;
      // accept it only from that metadata element, never from arbitrary row
      // prose or a neighbouring vacancy.
      if (classes.includes('column-value') && hasProvenLocationField(span, rowIndex, row)) {
        const postalValue = postalLocalityValue(value);
        if (postalValue) {
          rawLocation = postalValue;
          break;
        }
      }
    }
    if (!rawLocation) {
      // Some Umantis themes put the value directly in a location-labelled list
      // item while the nested span has no stable class. Generic list items are
      // intentionally ignored: a postal/locality-shaped title or category is
      // not workplace evidence.
      for (const item of rowIndex.tags.filter((tag) => tag.name === 'li')) {
        if (!hasProvenLocationField(item, rowIndex, row)) continue;
        const bound = rowIndex.bounds.get(item.index);
        if (!bound) continue;
        const postalValue = postalLocalityValue(structuredText(row.slice(item.end, bound.contentEnd)));
        if (postalValue) {
          rawLocation = postalValue;
          break;
        }
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
