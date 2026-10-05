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

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ITALIAN_DAYS = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
const ENGLISH_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SOURCE_TYPES = new Set([
  'official',
  'association',
  'pharmacy',
  'verified_partner',
  'directory',
  'google_business_profile',
  'facebook',
]);
const FIELDS = new Set(['address', 'phone', 'website', 'openingHours', 'services', 'contactEmail']);
const SOURCE_RANK = Object.freeze({
  official: 60,
  association: 50,
  pharmacy: 45,
  verified_partner: 40,
  google_business_profile: 30,
  facebook: 25,
  directory: 10,
});

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

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function digits(value) {
  return text(value).replace(/\D/g, '');
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
  return dedupeHours(result);
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

function identityMatches(pharmacy, bodyText) {
  const body = normalize(bodyText);
  const city = normalize(pharmacy.city);
  const address = normalize(pharmacy.address);
  const streetName = address.replace(/\b\d+[a-z]?\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const number = (address.match(/\b\d+[a-z]?\b/i) || [])[0];
  if (!city || !body.includes(city)) return false;
  if (streetName && !body.includes(streetName)) return false;
  if (number && !body.includes(number)) return false;
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
    const acceptedFields = [];
    for (const field of source.fields || []) {
      if (setFact(record, field, parsed.facts[field], source, checkedAt)) acceptedFields.push(field);
    }
    addExternalSource(record, source, checkedAt, acceptedFields, parsed.sourceUpdatedAt);
  } catch (error) {
    warnings.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function enrichGoogleProvider(records, pharmacies, provider, checkedAt, fetchJson, apiKey, warnings) {
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
  for (const pharmacy of pharmacies.filter((candidate) => ids.includes(candidate.id))) {
    if (providerSourceIsFresh(records[pharmacy.id], 'google_business_profile', checkedAt, provider.maxAgeDays)) continue;
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
      const acceptedFields = [];
      for (const field of source.fields) {
        if (setFact(records[pharmacy.id], field, facts[field], source, checkedAt)) acceptedFields.push(field);
      }
      addExternalSource(records[pharmacy.id], source, checkedAt, acceptedFields);
    } catch (error) {
      warnings.push(`facebook:${pharmacy.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function validatePharmacyEnrichmentConfig(config) {
  const errors = [];
  if (config?.schemaVersion !== 1) errors.push('enrichment source registry schemaVersion must be 1');
  if (!Array.isArray(config?.sources)) errors.push('enrichment source registry sources must be an array');
  for (const source of config?.sources || []) {
    if (!source?.id) errors.push('enrichment source is missing id');
    if (!source?.pharmacyId) errors.push(`${source?.id || '<unknown>'}: missing pharmacyId`);
    if (!safeHttpsUrl(source?.url)) errors.push(`${source?.id || '<unknown>'}: URL must be HTTPS`);
    if (!SOURCE_TYPES.has(source?.sourceType)) errors.push(`${source?.id || '<unknown>'}: invalid sourceType`);
    if (!Array.isArray(source?.fields) || source.fields.some((field) => !FIELDS.has(field))) errors.push(`${source?.id || '<unknown>'}: invalid fields`);
    if (source?.status !== 'active') errors.push(`${source?.id || '<unknown>'}: source must be active`);
  }
  for (const [providerName, provider] of Object.entries(config?.providers || {})) {
    if (typeof provider?.enabled !== 'boolean') errors.push(`${providerName}: enabled must be boolean`);
    if (!Array.isArray(provider?.pharmacyIds)) errors.push(`${providerName}: pharmacyIds must be an array`);
    if (provider?.maxAgeDays !== undefined && (!Number.isFinite(Number(provider.maxAgeDays)) || Number(provider.maxAgeDays) <= 0)) errors.push(`${providerName}: maxAgeDays must be a positive number`);
  }
  return errors;
}

export function validatePharmacyEnrichmentSnapshot(snapshot) {
  const errors = [];
  if (snapshot?.schemaVersion !== 1) errors.push('enrichment snapshot schemaVersion must be 1');
  if (!snapshot?.generatedAt || !Number.isFinite(Date.parse(snapshot.generatedAt))) errors.push('enrichment snapshot generatedAt is invalid');
  if (!snapshot?.records || typeof snapshot.records !== 'object' || Array.isArray(snapshot.records)) errors.push('enrichment snapshot records must be an object');
  for (const [id, record] of Object.entries(snapshot?.records || {})) {
    if (!record?.checkedAt || !Number.isFinite(Date.parse(record.checkedAt))) errors.push(`${id}: checkedAt is invalid`);
    if (record?.googlePlaceId !== undefined && !/^[A-Za-z0-9_-]+$/.test(String(record.googlePlaceId))) errors.push(`${id}: googlePlaceId is invalid`);
    for (const [field, source] of Object.entries(record?.fieldSources || {})) {
      if (!FIELDS.has(field)) errors.push(`${id}: invalid field ${field}`);
      if (!safeHttpsUrl(source?.url)) errors.push(`${id}.${field}: source URL must be HTTPS`);
      if (!SOURCE_TYPES.has(source?.sourceType)) errors.push(`${id}.${field}: invalid sourceType`);
      if (!source?.checkedAt || !Number.isFinite(Date.parse(source.checkedAt))) errors.push(`${id}.${field}: checkedAt is invalid`);
    }
    for (const source of record?.externalSources || []) {
      if (!safeHttpsUrl(source?.url)) errors.push(`${id}: external source URL must be HTTPS`);
      if (!source?.label || !SOURCE_TYPES.has(source?.sourceType)) errors.push(`${id}: invalid external source identity`);
      if (!Array.isArray(source?.fields) || source.fields.some((field) => !FIELDS.has(field)) || (!source.fields.length && source.sourceType !== 'google_business_profile')) errors.push(`${id}: invalid external source fields`);
      if (source?.sourceType === 'google_business_profile' && (typeof source.placeId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(source.placeId))) errors.push(`${id}: Google external source is missing a valid placeId`);
      if (!source?.checkedAt || !Number.isFinite(Date.parse(source.checkedAt))) errors.push(`${id}: external source checkedAt is invalid`);
    }
  }
  return errors;
}

export async function enrichPharmacyRecords(
  pharmacies,
  config,
  {
    previous = { records: {} },
    checkedAt = new Date().toISOString(),
    fetchDocument,
    fetchJson,
    googleApiKey,
    facebookPageId,
    facebookAccessToken,
  } = {},
) {
  const catalogueIds = new Set((pharmacies || []).map((pharmacy) => pharmacy.id));
  const records = Object.fromEntries(
    Object.entries(previous?.records || {})
      .filter(([id]) => catalogueIds.has(id))
      .map(([id, record]) => [id, cloneRecord(record)]),
  );
  const warnings = [];
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
  if (typeof fetchDocument === 'function') {
    for (const source of config?.sources || []) {
      if (source.status !== 'active') continue;
      const pharmacy = pharmacies.find((candidate) => candidate.id === source.pharmacyId);
      if (!pharmacy) {
        warnings.push(`${source.id}: pharmacyId ${source.pharmacyId} is not in the catalogue`);
        continue;
      }
      await enrichHtmlSource(records[pharmacy.id], pharmacy, source, checkedAt, fetchDocument, warnings);
    }
  }
  if (config?.providers?.googlePlaces?.enabled && typeof fetchJson === 'function') {
    await enrichGoogleProvider(records, pharmacies, config.providers.googlePlaces, checkedAt, fetchJson, googleApiKey, warnings);
  }
  if (config?.providers?.facebook?.enabled && typeof fetchJson === 'function') {
    await enrichFacebookProvider(records, pharmacies, config.providers.facebook, checkedAt, fetchJson, facebookPageId, facebookAccessToken, warnings);
  }
  return { records, warnings };
}

export function buildPharmacyEnrichmentSnapshot(previous, result, generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    generatedAt,
    records: result?.records || previous?.records || {},
    warnings: result?.warnings || [],
  };
}
