/**
 * Optional pharmacy-facts enrichment.
 *
 * The official catalogue remains the identity source. This module only reads
 * explicitly allow-listed public pages and authorised provider APIs, and
 * stores every accepted first-party fact with field-level provenance. For
 * Google Places it retains only the stable place ID after a transient identity
 * match, because the provider's caching policy does not permit persisting the
 * returned place content. It never scrapes a Google/Facebook search-result
 * page and never republishes reviews or ratings.
 */

import { JSDOM } from 'jsdom';
import {
  MAX_GOOGLE_PLACES_MONTHLY_REQUESTS,
  safeHttpsUrl,
  validatePharmacyEnrichmentConfig,
  validatePharmacyEnrichmentSnapshot,
} from './pharmacy-enrichment-validation.mjs';

export { validatePharmacyEnrichmentConfig, validatePharmacyEnrichmentSnapshot };

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ITALIAN_DAYS = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
const ENGLISH_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ITALIAN_MONTHS = new Map([
  ['gennaio', 1], ['febbraio', 2], ['marzo', 3], ['aprile', 4],
  ['maggio', 5], ['giugno', 6], ['luglio', 7], ['agosto', 8],
  ['settembre', 9], ['ottobre', 10], ['novembre', 11], ['dicembre', 12],
]);
const SOURCE_RANK = Object.freeze({
  official: 60,
  association: 50,
  pharmacy: 45,
  verified_partner: 40,
  google_business_profile: 30,
  facebook: 25,
  directory: 10,
});

function monthKey(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

function providerUsageFor(previous, checkedAt) {
  const month = monthKey(checkedAt);
  const previousUsage = previous?.providerUsage;
  const previousRequests = previousUsage?.month === month
    ? Number(previousUsage?.googlePlaces?.requests)
    : 0;
  return {
    month,
    googlePlaces: {
      // A malformed or already-exhausted ledger fails closed: it can never
      // authorize a request above the hard monthly ceiling.
      requests: Number.isInteger(previousRequests)
        ? Math.min(Math.max(previousRequests, 0), MAX_GOOGLE_PLACES_MONTHLY_REQUESTS)
        : MAX_GOOGLE_PLACES_MONTHLY_REQUESTS,
    },
  };
}

function googleMonthlyLimit(provider) {
  const configured = Number(provider?.monthlyRequestLimit);
  if (!Number.isInteger(configured) || configured <= 0) return MAX_GOOGLE_PLACES_MONTHLY_REQUESTS;
  return Math.min(configured, MAX_GOOGLE_PLACES_MONTHLY_REQUESTS);
}

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizedTokens(value) {
  return new Set(normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !['farmacia', 'farmacie', 'dott', 'dr', 'del', 'dei', 'della', 'sas', 'srl'].includes(token)));
}

function digits(value) {
  return text(value).replace(/\D/g, '');
}

function vatNumber(value) {
  const candidate = digits(value);
  return /^\d{11}$/.test(candidate) ? candidate : undefined;
}

function normaliseTime(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 24 || m < 0 || m > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseTime(value) {
  const match = text(value).match(/^(\d{1,2})[.:](\d{2})$/);
  return match ? normaliseTime(match[1], match[2]) : undefined;
}

function parseIntervalList(value) {
  return [...text(value).matchAll(/(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})/g)]
    .map((match) => ({ opens: normaliseTime(match[1], match[2]), closes: normaliseTime(match[3], match[4]) }))
    .filter((entry) => entry.opens && entry.closes);
}

function dayIndex(value, names) {
  const needle = normalize(value);
  return names.findIndex((day) => normalize(day) === needle);
}

function parseDayRange(value, names) {
  const raw = normalize(value).replace(/\./g, '');
  const range = raw.match(/^(?:da\s+)?([^\s,;-]+)\s+(?:a|al|ad|-)\s+([^\s,;-]+)$/i);
  if (range) {
    const from = dayIndex(range[1], names);
    const to = dayIndex(range[2], names);
    if (from >= 0 && to >= from) return DAYS.slice(from, to + 1);
  }
  const single = dayIndex(raw, names);
  return single >= 0 ? [DAYS[single]] : [];
}

export function parseItalianHours(value) {
  const raw = text(value);
  const result = [];
  // Handles the common municipal wording: "da lunedì a sabato: 8.30-20.00".
  const dayExpression = raw.match(/(?:da\s+)?(lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica)(?:\s+(?:a|al|ad|-)\s+(lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica))?\s*:?\s*([^;]+)/i);
  if (dayExpression) {
    const dayText = dayExpression[2] ? `${dayExpression[1]} a ${dayExpression[2]}` : dayExpression[1];
    const days = parseDayRange(dayText, ITALIAN_DAYS);
    for (const interval of parseIntervalList(dayExpression[3])) {
      for (const day of days) result.push({ dayOfWeek: day, opens: interval.opens, closes: interval.closes });
    }
  }

  // Also accept line-oriented English/Italian schedules when a source lists
  // each weekday separately instead of using a range.
  for (const names of [ITALIAN_DAYS, ENGLISH_DAYS]) {
    const pattern = new RegExp(`(?:^|[;|])\\s*(lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\s*:?\\s*([^;|]+)`, 'ig');
    for (const match of raw.matchAll(pattern)) {
      const days = parseDayRange(match[1], names);
      for (const interval of parseIntervalList(match[2])) {
        for (const day of days) result.push({ dayOfWeek: day, opens: interval.opens, closes: interval.closes });
      }
    }
  }

  // Preserve an explicitly published closed day instead of silently making
  // the schedule look incomplete. The renderer and JSON-LD both know how to
  // distinguish this marker from an opening interval.
  const closedPattern = /\b(lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:a|al|ad|-)\s+(lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|monday|tuesday|wednesday|thursday|friday|saturday|sunday))?\s*:?\s*(?:chius[oa]|closed)\b/gi;
  for (const match of raw.matchAll(closedPattern)) {
    const names = ITALIAN_DAYS.some((day) => normalize(day) === normalize(match[1])) ? ITALIAN_DAYS : ENGLISH_DAYS;
    const dayText = match[2] ? `${match[1]} a ${match[2]}` : match[1];
    for (const day of parseDayRange(dayText, names)) result.push({ dayOfWeek: day, opens: '', closes: '', isClosed: true });
  }
  return dedupeHours(result);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pdfIdentityMatches(pharmacy, bodyText) {
  const body = normalize(bodyText);
  const city = normalize(pharmacy.city);
  const number = (String(pharmacy.address || '').match(/\b\d+[a-z]?\b/i) || [])[0];
  const streetTokens = [...normalizedTokens(pharmacy.address)]
    .filter((token) => !/^(via|viale|piazza|corso|largo|strada|vicolo|contrada)$/.test(token));
  const nameTokens = [...normalizedTokens(pharmacy.name)].filter((token) => token !== city);
  return Boolean(
    city
    && body.includes(city)
    && number
    && body.includes(normalize(number))
    && streetTokens.some((token) => body.includes(token))
    && nameTokens.some((token) => body.includes(token)),
  );
}

function pdfSourceUpdatedAt(pdfText) {
  const match = normalize(pdfText).match(/\b(?:ed|edizione|aggiornato)\.?\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})\b/i);
  if (!match) return undefined;
  const month = ITALIAN_MONTHS.get(match[1].toLowerCase());
  const year = Number(match[2]);
  return month && Number.isInteger(year) ? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01T00:00:00.000Z` : undefined;
}

function pdfPhoneCandidate(pdfText, pharmacy) {
  const normalizedPdf = normalize(pdfText);
  const currentPhone = digits(pharmacy.phone);
  const streetToken = [...normalizedTokens(pharmacy.address)]
    .filter((token) => !/^(via|viale|piazza|corso|largo|strada|vicolo|contrada)$/.test(token))
    .sort((left, right) => right.length - left.length)[0];
  const nameToken = [...normalizedTokens(pharmacy.name)]
    .filter((token) => token !== normalize(pharmacy.city))
    .sort((left, right) => right.length - left.length)[0];
  const number = (String(pharmacy.address || '').match(/\b\d+[a-z]?\b/i) || [])[0];
  const rowAnchor = nameToken && streetToken && number
    ? new RegExp(`${escapeRegExp(nameToken)}[\\s\\S]{0,260}${escapeRegExp(streetToken)}[^0-9]{0,20}${escapeRegExp(number)}`, 'i')
    : null;
  const streetAnchor = streetToken && number
    ? new RegExp(`${escapeRegExp(streetToken)}[^0-9]{0,20}${escapeRegExp(number)}`, 'i')
    : null;
  const anchor = rowAnchor || streetAnchor;
  const anchorIndex = anchor ? normalizedPdf.search(anchor) : -1;
  const context = anchorIndex >= 0 ? normalizedPdf.slice(anchorIndex, anchorIndex + 180) : normalizedPdf;
  const candidates = [...context.matchAll(/(?:\+39[\s./-]*)?0(?:[\s./-]*\d){7,10}/g)]
    .map((match) => ({ raw: text(match[0]), value: digits(match[0]) }))
    .filter((candidate) => candidate.value.length >= 8 && candidate.value.length <= 12);
  const selected = candidates.find((candidate) => currentPhone && candidate.value === currentPhone) || candidates[0];
  return selected?.raw;
}

function pdfVatNumberCandidate(pdfText, pharmacy) {
  const normalizedPdf = normalize(pdfText);
  const nameToken = [...normalizedTokens(pharmacy.name)]
    .filter((token) => token !== normalize(pharmacy.city))
    .sort((left, right) => right.length - left.length)[0];
  if (!nameToken) return undefined;
  const matches = [...normalizedPdf.matchAll(/(?:p\.?\s*iva|partita\s+iva|vat)\s*[:#-]?\s*((?:\d[\s./-]*){10}\d)/gi)];
  const candidates = matches
    .filter((match) => {
      const vatIndex = match.index ?? -1;
      if (vatIndex < 0) return false;
      const beforeVat = normalizedPdf.slice(Math.max(0, vatIndex - 360), vatIndex);
      const nameIndex = beforeVat.lastIndexOf(nameToken);
      if (nameIndex < 0) return false;
      const contextStart = Math.max(0, vatIndex - 360) + nameIndex;
      return pdfIdentityMatches(pharmacy, normalizedPdf.slice(contextStart, vatIndex + match[0].length));
    })
    .map((match) => vatNumber(match[1]))
    .filter(Boolean);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}

/** Extract only allow-listed facts from an official PDF row/list. */
export function extractPdfFacts(pdfText, pharmacy, source) {
  const sourceUpdatedAt = pdfSourceUpdatedAt(pdfText);
  if (!pdfIdentityMatches(pharmacy, pdfText)) return { facts: {}, sourceUpdatedAt, matched: false };
  const facts = {};
  if (new Set(source.fields || []).has('phone')) {
    const phone = pdfPhoneCandidate(pdfText, pharmacy);
    if (phone) facts.phone = phone;
  }
  if (new Set(source.fields || []).has('vatNumber')) {
    const value = pdfVatNumberCandidate(pdfText, pharmacy);
    if (value) facts.vatNumber = value;
  }
  return { facts, sourceUpdatedAt, matched: true };
}

/** Convert PDF bytes to text without persisting the source document. */
export async function extractPharmacyPdfText(bytes) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const data = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : null;
  if (!data) throw new TypeError('pharmacy PDF source must be an ArrayBuffer or typed array');
  const pdf = await getDocumentProxy(data);
  try {
    const extracted = await extractText(pdf, { mergePages: false });
    return Array.isArray(extracted?.text) ? extracted.text.join('\n') : text(extracted?.text);
  } finally {
    try {
      await pdf.destroy();
    } catch {
      /* noop */
    }
  }
}

function dedupeHours(hours) {
  const seen = new Set();
  return hours.filter((hour) => {
    const key = `${hour.dayOfWeek}|${hour.opens}|${hour.closes}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceMeta(source, checkedAt, fields, sourceUpdatedAt) {
  return {
    url: source.url,
    label: source.label,
    sourceType: source.sourceType,
    checkedAt,
    fields: [...new Set(fields)],
    ...(source.placeId ? { placeId: source.placeId } : {}),
    status: 'verified',
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

function sourceField(source, checkedAt) {
  return {
    url: source.url,
    sourceType: source.sourceType,
    checkedAt,
  };
}

function sourceRank(sourceType) {
  return SOURCE_RANK[sourceType] || 0;
}

function hasFieldValue(value) {
  return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0;
}

function setFact(record, field, value, source, checkedAt) {
  if (!hasFieldValue(value)) return false;
  const currentSource = record.fieldSources?.[field];
  if (currentSource && sourceRank(source.sourceType) < sourceRank(currentSource.sourceType)) return false;
  if (currentSource && sourceRank(source.sourceType) === sourceRank(currentSource.sourceType) && currentSource.url !== source.url) return false;
  record[field] = Array.isArray(value) ? value : text(value);
  record.fieldSources ||= {};
  record.fieldSources[field] = sourceField(source, checkedAt);
  return true;
}

function addExternalSource(record, source, checkedAt, fields, sourceUpdatedAt) {
  const googlePlaceIdentity = source.sourceType === 'google_business_profile' && source.placeId;
  if (!fields.length && !googlePlaceIdentity) return;
  record.externalSources ||= [];
  const next = sourceMeta(source, checkedAt, fields, sourceUpdatedAt);
  const key = `${next.sourceType}|${next.url}`;
  record.externalSources = [
    ...record.externalSources.filter((candidate) => `${candidate.sourceType}|${candidate.url}` !== key),
    next,
  ];
}

function sanitizePublicFacebookFacts(value) {
  const facts = value && typeof value === 'object' ? value : {};
  const sanitized = {};
  const phone = text(facts.phone);
  if (digits(phone).length >= 8 && digits(phone).length <= 15) sanitized.phone = phone;
  const email = text(facts.contactEmail);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) sanitized.contactEmail = email;
  const website = safeHttpsUrl(facts.website);
  if (website) sanitized.website = website;
  if (Array.isArray(facts.openingHours)) {
    const openingHours = facts.openingHours.flatMap((hour) => {
      if (!hour || !DAYS.includes(hour.dayOfWeek)) return [];
      if (hour.isClosed === true) return [{ dayOfWeek: hour.dayOfWeek, opens: '', closes: '', isClosed: true }];
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(hour.opens || '')) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(hour.closes || ''))) return [];
      return [{ dayOfWeek: hour.dayOfWeek, opens: hour.opens, closes: hour.closes }];
    });
    if (openingHours.length) sanitized.openingHours = openingHours;
  }
  return sanitized;
}

function identityMatches(pharmacy, bodyText) {
  const body = normalize(bodyText);
  const city = normalize(pharmacy.city);
  const address = normalize(pharmacy.address);
  const streetName = address.replace(/\b\d+[a-z]?\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const number = (address.match(/\b\d+[a-z]?\b/i) || [])[0];
  if (!city || !body.includes(city)) return false;
  const streetTokens = [...normalizedTokens(streetName)]
    .filter((token) => !['via', 'viale', 'piazza', 'corso', 'largo', 'strada', 'vicolo', 'contrada'].includes(token))
    .filter((token) => token !== city && token.length >= 4);
  const numberPattern = number
    ? new RegExp(`(?:^|[^0-9])${escapeRegExp(number)}(?=$|[^0-9])`, 'i')
    : null;
  const civicNumberNear = (anchorIndex) => {
    if (!numberPattern || anchorIndex < 0) return !numberPattern;
    const windowStart = Math.max(0, anchorIndex - 24);
    const windowEnd = Math.min(body.length, anchorIndex + streetName.length + 96);
    return numberPattern.test(body.slice(windowStart, windowEnd));
  };
  const fullStreetIndex = streetName ? body.indexOf(streetName) : -1;
  const fullStreetMatch = !streetName || (fullStreetIndex >= 0 && civicNumberNear(fullStreetIndex));
  // Public registries may omit a middle street-name component (for example
  // "Via Matteotti" versus the catalogue's "Via Giacomo Matteotti"). Keep a
  // full normalized street-name + nearby civic-number match as the default;
  // the abbreviated fallback still requires a non-city street token beside a
  // street label and the same civic number.
  const abbreviatedStreetMatch = streetTokens.some((token) => {
    const tokenIndex = body.indexOf(token);
    if (tokenIndex < 0 || !civicNumberNear(tokenIndex)) return false;
    const prefix = body.slice(Math.max(0, tokenIndex - 80), tokenIndex);
    return /\b(?:via|viale|piazza|corso|largo|strada|vicolo|contrada)\b/i.test(prefix);
  });
  const streetMatch = fullStreetMatch || abbreviatedStreetMatch;
  if (!streetMatch) return false;
  const tokens = [...normalizedTokens(pharmacy.name)];
  return tokens.length === 0 || tokens.some((token) => body.includes(token));
}

function parseSourceModifiedAt(document) {
  const value = document.querySelector('meta[property="article:modified_time"], meta[name="last-modified"]')?.getAttribute('content');
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function extractHtmlFacts(html, pharmacy, source) {
  const dom = new JSDOM(String(html || ''));
  const document = dom.window.document;
  const bodyText = text(document.body?.textContent);
  if (!identityMatches(pharmacy, bodyText)) return { facts: {}, sourceUpdatedAt: parseSourceModifiedAt(document), matched: false };

  const wanted = new Set(source.fields || []);
  const facts = {};
  const telLinks = [...document.querySelectorAll('a[href^="tel:"]')]
    .map((link) => link.getAttribute('href')?.replace(/^tel:/i, '').trim())
    .filter((value) => digits(value).length >= 8);
  const currentPhone = digits(pharmacy.phone);
  const phone = telLinks.find((value) => digits(value) === currentPhone) || telLinks[0];
  if (wanted.has('phone') && phone) facts.phone = digits(phone) === currentPhone && pharmacy.phone ? pharmacy.phone : text(phone);

  const email = [...document.querySelectorAll('a[href^="mailto:"]')]
    .map((link) => link.getAttribute('href')?.replace(/^mailto:/i, '').split('?')[0].trim())
    .find((value) => value && !/pec|privacy|noreply/i.test(value));
  if (wanted.has('contactEmail') && email) facts.contactEmail = email;

  if (wanted.has('vatNumber')) {
    const value = bodyText.match(/(?:p\.?\s*iva|partita\s+iva|vat)\s*[:#-]?\s*((?:\d[\s./-]*){10}\d)/i)?.[1];
    const parsedVat = vatNumber(value);
    if (parsedVat) facts.vatNumber = parsedVat;
  }

  if (wanted.has('openingHours')) {
    const heading = [...document.querySelectorAll('h1,h2,h3,h4,strong')]
      .find((node) => /orari|orario|opening hours|hours/i.test(text(node.textContent)));
    const container = heading?.closest('section,article') || heading?.parentElement;
    const scheduleText = text(container?.textContent || bodyText);
    facts.openingHours = parseItalianHours(scheduleText);
    if (!facts.openingHours.length && scheduleText !== bodyText) facts.openingHours = parseItalianHours(bodyText);
  }

  if (wanted.has('services')) {
    const serviceText = normalize(bodyText);
    const services = [];
    if (/consegna\s+(?:a\s+domicilio|domiciliare)/i.test(serviceText)) services.push('Consegna a domicilio');
    if (/accessibile\s+in\s+sedia\s+a\s+rotelle|ingresso\s+accessibile/i.test(serviceText)) services.push('Accesso senza barriere');
    if (services.length) facts.services = services;
  }

  return { facts, sourceUpdatedAt: parseSourceModifiedAt(document), matched: true };
}

function scoreGooglePlace(pharmacy, place) {
  const haystack = normalize(`${place?.displayName?.text || ''} ${place?.formattedAddress || ''}`);
  const nameOverlap = [...normalizedTokens(pharmacy.name)].filter((token) => haystack.includes(token)).length;
  const cityMatch = haystack.includes(normalize(pharmacy.city));
  const street = normalize(pharmacy.address).replace(/\b\d+[a-z]?\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const number = (pharmacy.address.match(/\b\d+[a-z]?\b/i) || [])[0];
  const streetMatch = street && haystack.includes(street);
  const numberMatch = number && haystack.includes(number);
  // City + street is not enough to identify a branch: require both a
  // meaningful name token and the catalogue's civic number before retaining
  // Google's stable place ID. This fails closed for same-street candidates.
  if (nameOverlap === 0 || !numberMatch) return 0;
  return nameOverlap * 3 + (cityMatch ? 4 : 0) + (streetMatch ? 4 : 0) + 3;
}

function facebookHours(hours) {
  if (!hours || typeof hours !== 'object') return [];
  const result = [];
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  keys.forEach((key, index) => {
    const opens = parseTime(hours[`${key}_1_open`]);
    const closes = parseTime(hours[`${key}_1_close`]);
    if (opens && closes) result.push({ dayOfWeek: DAYS[index], opens, closes });
  });
  return result;
}

function parseFacebookPage(pharmacy, page) {
  const body = normalize(`${page?.name || ''} ${page?.location?.city || ''} ${page?.location?.street || ''}`);
  const nameOverlap = [...normalizedTokens(pharmacy.name)].filter((token) => body.includes(token)).length;
  if (!body.includes(normalize(pharmacy.city)) || nameOverlap === 0) return {};
  const facts = {};
  if (page.phone) facts.phone = page.phone;
  const website = safeHttpsUrl(page.website);
  if (website) facts.website = website;
  const email = Array.isArray(page.emails) ? page.emails.find((value) => /@/.test(value)) : undefined;
  if (email) facts.contactEmail = email;
  const openingHours = facebookHours(page.hours);
  if (openingHours.length) facts.openingHours = openingHours;
  return facts;
}

function cloneRecord(record) {
  if (!record || typeof record !== 'object') return { checkedAt: '' };
  return JSON.parse(JSON.stringify(record));
}

function idsForProvider(provider, allIds) {
  const configured = Array.isArray(provider?.pharmacyIds) ? provider.pharmacyIds : [];
  return configured.length ? configured.filter((id) => allIds.has(id)) : [];
}

function providerSourceIsFresh(record, sourceType, checkedAt, maxAgeDays) {
  if (!Number.isFinite(Number(maxAgeDays)) || Number(maxAgeDays) <= 0) return false;
  const source = (record?.externalSources || []).find((candidate) => candidate.sourceType === sourceType);
  const sourceCheckedAt = Date.parse(source?.checkedAt || '');
  const current = Date.parse(checkedAt);
  return Number.isFinite(sourceCheckedAt)
    && Number.isFinite(current)
    && current >= sourceCheckedAt
    && current - sourceCheckedAt < Number(maxAgeDays) * 86_400_000;
}

async function enrichHtmlSource(record, pharmacy, source, checkedAt, fetchDocument, warnings) {
  try {
    const html = await fetchDocument(source.url);
    const parsed = extractHtmlFacts(html, pharmacy, source);
    if (!parsed.matched) {
      warnings.push(`${source.id}: page did not match ${pharmacy.id}; no facts published`);
      return;
    }
    const observedFields = (source.fields || []).filter((field) => hasFieldValue(parsed.facts[field]));
    for (const field of observedFields) setFact(record, field, parsed.facts[field], source, checkedAt);
    // Keep a matched source even when its values lose field-level precedence
    // to an official source. The selected fact and the corroborating source
    // are separate pieces of provenance and both help readers/agents audit
    // the identity without allowing a lower-trust source to overwrite it.
    addExternalSource(record, source, checkedAt, observedFields, parsed.sourceUpdatedAt);
  } catch (error) {
    warnings.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function enrichPdfSource(record, pharmacy, source, checkedAt, fetchPdfText, warnings) {
  try {
    const pdfText = await fetchPdfText(source.url);
    const parsed = extractPdfFacts(pdfText, pharmacy, source);
    if (!parsed.matched) {
      warnings.push(`${source.id}: PDF did not match ${pharmacy.id}; no facts published`);
      return;
    }
    const observedFields = (source.fields || []).filter((field) => hasFieldValue(parsed.facts[field]));
    for (const field of observedFields) setFact(record, field, parsed.facts[field], source, checkedAt);
    addExternalSource(record, source, checkedAt, observedFields, parsed.sourceUpdatedAt);
  } catch (error) {
    warnings.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function enrichGoogleProvider(records, pharmacies, provider, checkedAt, fetchJson, apiKey, warnings, providerUsage) {
  const ids = idsForProvider(provider, new Set(pharmacies.map((pharmacy) => pharmacy.id)));
  if (!ids.length) return;
  if (!apiKey) {
    warnings.push('googlePlaces: skipped because GOOGLE_MAPS_API_KEY is not configured');
    return;
  }
  // Google Maps Platform permits retaining the stable place ID, but not
  // pre-fetching/caching the returned place content. Display name and address
  // are requested transiently only to prove the match before storing the ID.
  const fieldMask = 'places.id,places.displayName,places.formattedAddress';
  const monthlyLimit = googleMonthlyLimit(provider);
  for (const pharmacy of pharmacies.filter((candidate) => ids.includes(candidate.id))) {
    if (providerSourceIsFresh(records[pharmacy.id], 'google_business_profile', checkedAt, provider.maxAgeDays)) continue;
    if (providerUsage.googlePlaces.requests >= monthlyLimit) {
      warnings.push(`googlePlaces: monthly request limit reached (${monthlyLimit}); remaining pharmacies were skipped`);
      return;
    }
    // Reserve before the request. Failed responses are counted too: a retry
    // cannot turn a transient error into a quota overrun in the same month.
    providerUsage.googlePlaces.requests += 1;
    try {
      const payload = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify({
          textQuery: `${pharmacy.name}, ${pharmacy.address}, ${pharmacy.city}, Italy`,
          languageCode: 'it',
          regionCode: 'IT',
          includedType: 'pharmacy',
          strictTypeFiltering: true,
        }),
      });
      const places = Array.isArray(payload?.places) ? payload.places : [];
      const best = places
        .map((place) => ({ place, score: scoreGooglePlace(pharmacy, place) }))
        .sort((left, right) => right.score - left.score)[0];
      if (!best || best.score < 7) {
        warnings.push(`googlePlaces:${pharmacy.id}: no sufficiently certain place match`);
        continue;
      }
      const placeId = text(best.place.id);
      if (!placeId) {
        warnings.push(`googlePlaces:${pharmacy.id}: matched place has no stable place ID`);
        continue;
      }
      const source = {
        id: `google-places:${pharmacy.id}`,
        url: 'https://www.google.com/maps',
        label: 'Google Maps',
        sourceType: 'google_business_profile',
        fields: [],
        placeId,
      };
      records[pharmacy.id].googlePlaceId = placeId;
      addExternalSource(records[pharmacy.id], source, checkedAt, []);
    } catch (error) {
      warnings.push(`googlePlaces:${pharmacy.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function enrichFacebookProvider(records, pharmacies, provider, checkedAt, fetchJson, pageId, accessToken, warnings) {
  const ids = idsForProvider(provider, new Set(pharmacies.map((pharmacy) => pharmacy.id)));
  if (!ids.length) return;
  if (!pageId || !accessToken) {
    warnings.push('facebook: skipped because PHARMACY_FACEBOOK_PAGE_ID or PHARMACY_FACEBOOK_PAGE_ACCESS_TOKEN is not configured');
    return;
  }
  for (const pharmacy of pharmacies.filter((candidate) => ids.includes(candidate.id))) {
    if (providerSourceIsFresh(records[pharmacy.id], 'facebook', checkedAt, provider.maxAgeDays)) continue;
    try {
      const page = await fetchJson(`https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}?fields=name,link,phone,website,emails,hours,location`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const facts = parseFacebookPage(pharmacy, page);
      const url = safeHttpsUrl(page?.link);
      if (!url || !Object.keys(facts).length) {
        warnings.push(`facebook:${pharmacy.id}: page did not match or exposed no reusable facts`);
        continue;
      }
      const source = {
        id: `facebook:${pharmacy.id}`,
        url,
        label: 'Facebook',
        sourceType: 'facebook',
        fields: ['phone', 'website', 'openingHours', 'contactEmail'],
      };
      const observedFields = source.fields.filter((field) => hasFieldValue(facts[field]));
      for (const field of observedFields) setFact(records[pharmacy.id], field, facts[field], source, checkedAt);
      // Preserve the matched Page as corroborating provenance even when the
      // official catalogue/municipal source remains the selected fact source.
      addExternalSource(records[pharmacy.id], source, checkedAt, observedFields);
    } catch (error) {
      warnings.push(`facebook:${pharmacy.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Apply facts collected by the unauthenticated public-page discovery job.
 * The discovery report is deliberately a separate input so that a search
 * result can never become a site fact by itself: only a candidate with a
 * strict identity match and an HTTPS Facebook page URL is accepted here.
 */
export function applyPublicFacebookDiscovery(records, pharmacies, discovery, checkedAt, warnings = []) {
  const byId = new Map((pharmacies || []).map((pharmacy) => [pharmacy.id, pharmacy]));
  const allowedFields = ['phone', 'website', 'openingHours', 'contactEmail'];
  for (const candidate of discovery?.candidates || []) {
    if (candidate?.status !== 'candidate_publicly_verified') continue;
    const pharmacy = byId.get(candidate.pharmacyId);
    const verified = candidate.verified;
    const url = safeHttpsUrl(verified?.pageUrl);
    let host = '';
    try { host = url ? new URL(url).hostname.toLowerCase() : ''; } catch { /* validated below */ }
    if (!pharmacy || !verified?.matched || !url || !/(^|\.)facebook\.com$/.test(host)) {
      warnings.push(`facebook-public:${candidate?.pharmacyId || '<unknown>'}: invalid verified candidate; no facts published`);
      continue;
    }
    const facts = sanitizePublicFacebookFacts(verified.facts);
    const fields = allowedFields.filter((field) => hasFieldValue(facts[field]));
    if (!fields.length) continue;
    records[pharmacy.id] ||= { checkedAt };
    const source = {
      id: `facebook-public:${pharmacy.id}`,
      url,
      label: 'Facebook — pagina pubblica',
      sourceType: 'facebook',
      fields,
    };
    for (const field of fields) setFact(records[pharmacy.id], field, facts[field], source, checkedAt);
    addExternalSource(records[pharmacy.id], source, checkedAt, fields);
  }
}

export async function enrichPharmacyRecords(
  pharmacies,
  config,
  {
    previous = { records: {} },
    checkedAt = new Date().toISOString(),
    fetchDocument,
    fetchPdfText,
    fetchJson,
    googleApiKey,
    facebookPageId,
    facebookAccessToken,
    facebookPublicDiscovery,
  } = {},
) {
  const catalogueIds = new Set((pharmacies || []).map((pharmacy) => pharmacy.id));
  const records = Object.fromEntries(
    Object.entries(previous?.records || {})
      .filter(([id]) => catalogueIds.has(id))
      .map(([id, record]) => [id, cloneRecord(record)]),
  );
  const warnings = [];
  const providerUsage = providerUsageFor(previous, checkedAt);
  const configuredIds = new Set([
    ...(config?.sources || []).map((source) => source.pharmacyId),
    ...(config?.providers?.googlePlaces?.pharmacyIds || []),
    ...(config?.providers?.facebook?.pharmacyIds || []),
  ]);
  for (const pharmacy of pharmacies || []) {
    if (!configuredIds.has(pharmacy.id)) continue;
    if (!records[pharmacy.id]) records[pharmacy.id] = { checkedAt };
    records[pharmacy.id].checkedAt = checkedAt;
  }
  for (const source of config?.sources || []) {
    if (source.status !== 'active') continue;
    const pharmacy = pharmacies.find((candidate) => candidate.id === source.pharmacyId);
    if (!pharmacy) {
      warnings.push(`${source.id}: pharmacyId ${source.pharmacyId} is not in the catalogue`);
      continue;
    }
    if ((source.kind || 'html') === 'pdf') {
      if (typeof fetchPdfText !== 'function') {
        warnings.push(`${source.id}: PDF source skipped because fetchPdfText is not configured`);
        continue;
      }
      await enrichPdfSource(records[pharmacy.id], pharmacy, source, checkedAt, fetchPdfText, warnings);
    } else if (typeof fetchDocument === 'function') {
      await enrichHtmlSource(records[pharmacy.id], pharmacy, source, checkedAt, fetchDocument, warnings);
    }
  }
  if (config?.providers?.googlePlaces?.enabled && typeof fetchJson === 'function') {
    await enrichGoogleProvider(records, pharmacies, config.providers.googlePlaces, checkedAt, fetchJson, googleApiKey, warnings, providerUsage);
  }
  if (config?.providers?.facebook?.enabled && typeof fetchJson === 'function') {
    await enrichFacebookProvider(records, pharmacies, config.providers.facebook, checkedAt, fetchJson, facebookPageId, facebookAccessToken, warnings);
  }
  applyPublicFacebookDiscovery(records, pharmacies, facebookPublicDiscovery, checkedAt, warnings);
  return { records, warnings, providerUsage };
}

export function buildPharmacyEnrichmentSnapshot(previous, result, generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    generatedAt,
    records: result?.records || previous?.records || {},
    warnings: result?.warnings || [],
    ...(result?.providerUsage || previous?.providerUsage
      ? { providerUsage: result?.providerUsage || previous?.providerUsage }
      : {}),
  };
}
