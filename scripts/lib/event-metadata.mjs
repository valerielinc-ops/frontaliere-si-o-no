import { cleanEventText } from './events-utils.mjs';

/**
 * Small normalizers for optional schema.org Event metadata.
 *
 * They deliberately preserve only named entities and usable HTTP(S) URLs:
 * source JSON-LD is not trusted enough to copy arbitrary objects into the
 * public dataset, and an unnamed organizer/performer is not useful markup.
 */

function absoluteHttpUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim(), baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function sourceType(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.find((entry) => typeof entry === 'string' && entry.trim())?.trim();
}

/** Return the first usable image URL from schema.org Image/Object/array forms. */
export function firstEventImageUrl(value, baseUrl) {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry?.url || entry?.contentUrl || entry?.thumbnailUrl;
    const url = absoluteHttpUrl(raw, baseUrl);
    if (url) return url;
  }
  return undefined;
}

/**
 * Normalize schema.org organizer/performer values while preserving the source
 * entity type and URL when present. A singular source value stays singular;
 * arrays stay arrays so the dataset does not invent cardinality.
 */
export function normalizeEventPeople(value, baseUrl) {
  if (value === undefined || value === null) return undefined;
  const inputWasArray = Array.isArray(value);
  const entries = inputWasArray ? value : [value];
  const seen = new Set();
  const people = [];

  for (const entry of entries) {
    const rawName = typeof entry === 'string' ? entry : entry?.name;
    const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : '';
    if (!name) continue;
    const url = absoluteHttpUrl(typeof entry === 'object' ? entry?.url : undefined, baseUrl);
    const key = `${name.toLowerCase()}|${url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = typeof entry === 'object' ? sourceType(entry?.['@type']) : undefined;
    people.push({
      ...(type ? { '@type': type } : {}),
      name,
      ...(url ? { url } : {}),
    });
  }

  if (!people.length) return undefined;
  return inputWasArray ? people : people[0];
}

function sourceText(value) {
  return cleanEventText(value);
}

function sourceEntityName(value) {
  const name = sourceText(value)
    .replace(/^[\s:;-]+|[\s,;:.-]+$/g, '')
    .trim();
  if (!name || name.length > 160) return undefined;
  // The broad "Mit/Con/With/Avec" patterns below are deliberately limited to
  // proper-looking names. Never turn a sentence fragment into a performer.
  if (/^(?:der|die|das|dem|den|des|ein|eine|einem|einer|eines|il|la|le|les|un|une|des|du|the|a|an|this|that|elementen|elementi|éléments?)\b/i.test(name)) {
    return undefined;
  }
  if (!/^[A-ZÀ-ÖØ-Þ]/u.test(name)) return undefined;
  return name;
}

function firstCaptured(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const name = sourceEntityName(match[1]);
    if (name) return name;
  }
  return undefined;
}

function splitPerformerNames(value) {
  const raw = sourceEntityName(value);
  if (!raw) return [];
  const parts = raw
    .split(/\s+(?:und|and|e|et)\s+|\s*&\s*/iu)
    .map((part) => sourceEntityName(part))
    .filter(Boolean);
  return parts.length > 1 ? parts : [raw];
}

const ORGANIZER_PATTERNS = [
  /\b(?:präsentiert|presentiert)\s+von\s+(.+?)(?=Mitwirkende(?:\s+und\s+Zusatzinformationen)?\s*:|[.!?](?:\s|$)|$)/iu,
  /\b(?:presentat[oaie]|présent(?:é|ée|és|ées))\s+(?:da|par)\s+(.+?)(?=Mitwirkende(?:\s+und\s+Zusatzinformationen)?\s*:|[.!?](?:\s|$)|$)/iu,
  /\b(?:presented|organ(?:ized|ised)|organizzat[oaie]|organis(?:iert|é|ée|és|ées))\s+(?:by|da|par|von)\s+(.+?)(?=Mitwirkende(?:\s+und\s+Zusatzinformationen)?\s*:|[.!?](?:\s|$)|$)/iu,
  /\b(?:veranstalter(?:in)?|organizzatore|organisateur(?:rice)?|organizer|organiser)\s*:\s*(.+?)(?=[.!?](?:\s|$)|$)/iu,
];

const PERFORMER_PATTERNS = [
  /Mitwirkende(?:\s+und\s+Zusatzinformationen)?\s*:\s*([^.!?]+?)(?=$|[.!?](?:\s|$)|\b(?:Treffpunkt|Ort|Location|Lieu|Luogo)\s*:)/iu,
  /\bGestaltet\s+wird\s+(?:der|die|das)\s+.+?\s+von\s+([^.!?]+?)(?=[.!?](?:\s|$)|$)/iu,
  /\bvon\s+und\s+mit\s+([^.!?]+?)(?=[.!?](?:\s|$)|$)/iu,
  /\b(?:mit|con|avec|with|featuring|feat\.?)\s+([A-ZÀ-ÖØ-Þ][^.!?]{1,120}?)(?=[.!?](?:\s|$)|$)/iu,
];

/**
 * Extract only explicit source-language attribution phrases from event copy.
 * This is intentionally narrower than a generic named-entity recognizer:
 * venue, title and prose must never be promoted to organizer/performer just
 * because they contain a capitalized word.
 */
export function extractEventPeopleFromText(value) {
  const text = sourceText(value);
  if (!text) return {};

  const organizerName = firstCaptured(text, ORGANIZER_PATTERNS);
  const performerNames = splitPerformerNames(firstCaptured(text, PERFORMER_PATTERNS));
  return {
    ...(organizerName ? { organizer: { '@type': 'Organization', name: organizerName } } : {}),
    ...(performerNames.length
      ? { performer: performerNames.length === 1 ? { name: performerNames[0] } : performerNames.map((name) => ({ name })) }
      : {}),
  };
}

function htmlAttribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag);
  return match ? cleanEventText(match[2]) : undefined;
}

/** Read a source page's event image without trusting arbitrary body images. */
export function firstEventImageUrlFromHtml(html, baseUrl) {
  if (typeof html !== 'string' || !html) return undefined;
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const property = htmlAttribute(tag, 'property') || htmlAttribute(tag, 'name');
    if (!/^(?:og:image|twitter:image(?::src)?)$/i.test(property || '')) continue;
    const image = firstEventImageUrl(htmlAttribute(tag, 'content'), baseUrl);
    if (image) return image;
  }

  // Some localized pages expose only an itemprop image rather than OpenGraph
  // metadata. It is still an event-scoped signal, unlike the first arbitrary
  // <img> on the page (which is often the site logo).
  const imageTags = html.match(/<(?:img|link)\b[^>]*>/gi) || [];
  for (const tag of imageTags) {
    if (!/\bitemprop\s*=\s*["']image["']/i.test(tag)) continue;
    const image = firstEventImageUrl(htmlAttribute(tag, 'content') || htmlAttribute(tag, 'src') || htmlAttribute(tag, 'href'), baseUrl);
    if (image) return image;
  }
  return undefined;
}

/** Return a value from a localized HTML key/value table or definition list. */
export function extractDetailTableValue(html, labels) {
  if (typeof html !== 'string' || !html || !Array.isArray(labels) || !labels.length) return undefined;
  const normalizedLabels = new Set(labels.map((label) => sourceText(label).toLowerCase()).filter(Boolean));
  if (!normalizedLabels.size) return undefined;

  const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html))) {
    const row = rowMatch[0];
    const labelMatch = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(row);
    const valueMatch = /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(row);
    if (!labelMatch || !valueMatch) continue;
    if (!normalizedLabels.has(sourceText(labelMatch[1]).toLowerCase())) continue;
    return sourceText(valueMatch[1]) || undefined;
  }

  const definitionRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let definitionMatch;
  while ((definitionMatch = definitionRe.exec(html))) {
    if (normalizedLabels.has(sourceText(definitionMatch[1]).toLowerCase())) {
      return sourceText(definitionMatch[2]) || undefined;
    }
  }
  return undefined;
}

function contactOrganizationName(value) {
  let name = sourceText(value);
  if (!name) return undefined;
  name = name.split(/\b(?:e-?mail|email|telefono|telefon|phone|tél|tel\.?|website|web)\b/i)[0].trim();
  const postal = /\b(?:CH[- ]?)?\d{4}\b/i.exec(name);
  if (postal) name = name.slice(0, postal.index).trim();
  // Contact blocks often continue with "Street 12" after the organization.
  name = name.replace(/\s+\S*[\p{L}]?(?:strasse|straße|street|weg|gasse|platz|via|route|rue|rue)\s+\d+[A-Za-z]?$/iu, '').trim();
  return sourceEntityName(name);
}

const CONTACT_LABELS = [
  'Contact address',
  'Kontaktadresse',
  'Indirizzo di contatto',
  'Adresse de contact',
  'Contatto',
  'Kontakt',
  'Contact',
];

/** Extract the named organization from a source page's dedicated contact block. */
export function extractDetailContactName(html) {
  if (typeof html !== 'string' || !html) return undefined;
  const tableValue = extractDetailTableValue(html, CONTACT_LABELS);
  const fromTable = contactOrganizationName(tableValue);
  if (fromTable) return fromTable;

  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let heading;
  while ((heading = headingRe.exec(html))) {
    const label = sourceText(heading[2]).toLowerCase();
    if (!/^(?:contatto|kontakt|contact|contact address|kontaktadresse|indirizzo di contatto|adresse de contact)\s*:?[.!]?$/i.test(label)) continue;
    const rest = html.slice(heading.index + heading[0].length);
    const nextHeading = /<h[1-6]\b/i.exec(rest);
    const block = nextHeading ? rest.slice(0, nextHeading.index) : rest.slice(0, 2400);
    if (!/\b\d{4}\b|@|\b(?:tel\.?|telefon|phone|website|web)\b|https?:\/\/|www\./i.test(sourceText(block))) continue;
    const name = contactOrganizationName(block);
    if (name) return name;
  }
  return undefined;
}
