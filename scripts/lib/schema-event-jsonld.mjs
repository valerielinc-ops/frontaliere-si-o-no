/** Shared schema.org Event JSON-LD boundaries for event crawlers. */

const SCRIPT_OPEN_RE = /<script\b/gi;
const SCRIPT_CLOSE_RE = /<\/script\s*>/gi;
const SCHEMA_ORG_EVENT_NAMES = new Set([
  'Event', 'BusinessEvent', 'ChildrensEvent', 'ComedyEvent', 'CourseInstance',
  'DanceEvent', 'DeliveryEvent', 'EducationEvent', 'EventSeries', 'ExhibitionEvent',
  'Festival', 'FoodEvent', 'Hackathon', 'LiteraryEvent', 'MusicEvent',
  'OnDemandEvent', 'PublicationEvent', 'SaleEvent', 'ScreeningEvent', 'SocialEvent',
  'SportsEvent', 'TheaterEvent', 'VisualArtsEvent',
]);
const SCHEMA_ORG_EVENT_IRI_NAME_RE = /^(?:Event|[A-Z][A-Za-z0-9]*Event|CourseInstance|Festival|Hackathon)$/;
const SCHEMA_ORG_EVENT_IRI_RE = /^https?:\/\/(?:www\.)?schema\.org[\/#]([A-Z][A-Za-z0-9]*)$/;
const JSON_LD_MIME = 'application/ld+json';

function isWhitespace(value) {
  return typeof value === 'string' && /\s/.test(value);
}

function findOpeningTagEnd(html, start) {
  let quote;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

/**
 * Read one opening-tag attribute list without treating text inside a quoted
 * value as another attribute. In particular, `data-type` is not `type`.
 */
function hasJsonLdTypeAttribute(attributes) {
  let index = 0;
  while (index < attributes.length) {
    while (index < attributes.length && (isWhitespace(attributes[index]) || attributes[index] === '/')) index += 1;
    if (index >= attributes.length) break;

    const nameStart = index;
    while (index < attributes.length
      && !isWhitespace(attributes[index])
      && !['=', '/', '>'].includes(attributes[index])) index += 1;
    const name = attributes.slice(nameStart, index).toLowerCase();

    while (index < attributes.length && isWhitespace(attributes[index])) index += 1;
    let value;
    if (attributes[index] === '=') {
      index += 1;
      while (index < attributes.length && isWhitespace(attributes[index])) index += 1;
      const quote = attributes[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < attributes.length && attributes[index] !== quote) index += 1;
        value = attributes.slice(valueStart, index);
        if (index < attributes.length) index += 1;
      } else {
        const valueStart = index;
        while (index < attributes.length && !isWhitespace(attributes[index]) && attributes[index] !== '>') index += 1;
        value = attributes.slice(valueStart, index);
      }
    }

    // HTML keeps the first duplicate attribute; do the same instead of
    // letting a later `type` silently turn an ambiguous tag into JSON-LD.
    if (name === 'type') return value?.trim().toLowerCase() === JSON_LD_MIME;
  }
  return false;
}

/** Return the raw contents of actual `<script type="application/ld+json">` tags. */
export function extractJsonLdScriptContents(html) {
  if (typeof html !== 'string' || !html) return [];
  const contents = [];
  SCRIPT_OPEN_RE.lastIndex = 0;
  let opening;
  while ((opening = SCRIPT_OPEN_RE.exec(html))) {
    const openingEnd = findOpeningTagEnd(html, SCRIPT_OPEN_RE.lastIndex);
    if (openingEnd < 0) break;
    SCRIPT_CLOSE_RE.lastIndex = openingEnd + 1;
    const closing = SCRIPT_CLOSE_RE.exec(html);
    if (!closing) break;
    if (hasJsonLdTypeAttribute(html.slice(SCRIPT_OPEN_RE.lastIndex, openingEnd))) {
      contents.push(html.slice(openingEnd + 1, closing.index));
    }
    SCRIPT_OPEN_RE.lastIndex = closing.index + closing[0].length;
  }
  return contents;
}

/**
 * Flatten JSON-LD arrays and `@graph` wrappers without consuming the call
 * stack. JSON.parse can produce deeply nested valid graphs from remote HTML.
 */
export function eventJsonLdCandidates(value) {
  const candidates = [];
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (current['@graph'] !== undefined) {
      pending.push(current['@graph']);
      continue;
    }
    candidates.push(current);
  }
  return candidates;
}

/** Accept only schema.org Event names or schema.org Event IRIs. */
export function isSchemaEventJsonLdType(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some((type) => {
    if (typeof type !== 'string') return false;
    const normalized = type.trim();
    const iriMatch = SCHEMA_ORG_EVENT_IRI_RE.exec(normalized);
    return iriMatch ? SCHEMA_ORG_EVENT_IRI_NAME_RE.test(iriMatch[1]) : SCHEMA_ORG_EVENT_NAMES.has(normalized);
  });
}

/** Flatten all JSON-LD nodes, retaining graph wrapper objects for callers that inspect them. */
export function jsonLdNodes(value) {
  const nodes = [];
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    nodes.push(current);
    if (current['@graph'] !== undefined) pending.push(current['@graph']);
  }
  return nodes;
}
