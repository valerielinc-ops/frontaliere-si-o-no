import { cleanEventText, parsePriceText, withEventPriceSource } from './events-utils.mjs';
import { normalizeSchemaOrgDateTime, normalizeSchemaOrgItemAvailability } from './schema-org-values.mjs';

/**
 * Small normalizers for optional schema.org Event metadata.
 *
 * They preserve source-named event people and usable HTTP(S) URLs. A source
 * or catalog label and an event-page URL are not substitutes for the actual
 * event host or participant.
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

function pageUrlIdentity(value, baseUrl) {
  const absolute = absoluteHttpUrl(value, baseUrl);
  if (!absolute) return undefined;
  const url = new URL(absolute);
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return `${url.origin}${pathname}`;
}

function sourceType(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.find((entry) => typeof entry === 'string' && entry.trim())?.trim();
}

const OFFER_METADATA_FIELDS = ['availability', 'validFrom', 'url'];

function offerEntries(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.filter((entry) => entry && typeof entry === 'object');
}

function selectedOffer(value, baseUrl) {
  const entries = offerEntries(value);
  if (!entries.length) return undefined;
  const priced = entries
    .map((offer) => ({ offer, amount: eventOfferPriceAmount(offer.price) }))
    .filter(({ amount }) => Number.isFinite(amount));
  if (!priced.length) {
    const candidates = entries.map((offer) => ({
      offer,
      // A usable booking URL takes priority over other unpriced metadata.
      score: OFFER_METADATA_FIELDS.reduce((score, field) => (
        score + (normalizedOfferField(field, offer[field], baseUrl) ? (field === 'url' ? 4 : 1) : 0)
      ), 0),
    }));
    return candidates.reduce((best, candidate) => (candidate.score > best.score ? candidate : best));
  }
  return priced.reduce((best, candidate) => (candidate.amount < best.amount ? candidate : best));
}

/**
 * Price from the structured fields of a schema.org Event JSON-LD node:
 * `isAccessibleForFree: true` first, otherwise the cheapest typed
 * `offers[].price`. The result is stamped with `priceSource` and the field it
 * came from, so `hasConfidentPrice()` can tell it apart from a parsed tariff
 * text. Returns undefined when neither structured field carries a value.
 */
export function extractStructuredEventPrice(ld, baseUrl, priceSource) {
  const offersRaw = ld?.offers;
  const offers = offerEntries(offersRaw);
  if (ld?.isAccessibleForFree === true) {
    const zeroOffer = offers.find((offer) => eventOfferPriceAmount(offer?.price) === 0);
    return withEventPriceSource({
      amount: 0,
      currency: zeroOffer?.priceCurrency || offers.find((o) => typeof o?.priceCurrency === 'string')?.priceCurrency || 'CHF',
      isFree: true,
      ...(zeroOffer ? extractEventOfferMetadata(zeroOffer, baseUrl) || {} : {}),
    }, priceSource, 'isAccessibleForFree');
  }
  const priced = offers
    .map((offer) => ({ offer, amount: eventOfferPriceAmount(offer?.price) }))
    .filter(({ amount }) => Number.isFinite(amount));
  if (!priced.length) return undefined;
  const cheapest = priced.reduce((best, candidate) => (candidate.amount < best.amount ? candidate : best));
  const currency = typeof cheapest.offer?.priceCurrency === 'string'
    ? cheapest.offer.priceCurrency
    : offers.find((o) => typeof o?.priceCurrency === 'string')?.priceCurrency || 'CHF';
  return withEventPriceSource({
    amount: cheapest.amount,
    currency,
    isFree: cheapest.amount === 0,
    ...(extractEventOfferMetadata(cheapest.offer, baseUrl) || {}),
  }, priceSource, 'offers.price');
}

/** Parse a source Offer price without treating blank/null values as zero. */
export function eventOfferPriceAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : NaN;
}

const TARIFF_NUMBER = String.raw`(?:\d{1,3}(?:['’\u00a0\u202f ]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
const TARIFF_AMOUNT = String.raw`${TARIFF_NUMBER}(?:[.,][-–—]{1,2})?`;
const TARIFF_RANGE = String.raw`${TARIFF_AMOUNT}(?:\s*[-–—]\s*${TARIFF_AMOUNT})?`;
const TARIFF_CURRENCY = String.raw`(?:CHF|EUR|€|S?Fr\.|francs?|franchi|franken)(?!\p{L})`;
const TARIFF_MONEY_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,'’+\-–—])(?:(?<prefix>${TARIFF_CURRENCY})\s*¤?\s*(?<after>${TARIFF_RANGE})|(?<before>${TARIFF_RANGE})\s*(?<suffix>${TARIFF_CURRENCY}))(?![\p{N}'’]|[.,]\d)`,
  'giu',
);
const SWISS_MARKED_TARIFF_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,'’+\-–—])(${TARIFF_NUMBER})[.,][-–—]{1,2}(?!\p{N})`,
  'gu',
);
const TARIFF_CURRENCY_RE = new RegExp(TARIFF_CURRENCY, 'iu');
const BARE_TARIFF_RE = new RegExp(
  String.raw`^${TARIFF_AMOUNT}(?:\s*[-–]\s*${TARIFF_AMOUNT})?(?:\s*(?:pro Person|per person|par personne|per persona))?\s*[.!]?$`,
  'iu',
);

/** Parse an admission tariff without treating categories, quantities or contact numbers as prices. */
export function parseEventPriceText(value) {
  if (typeof value !== 'string') return undefined;
  const tariff = value
    .replace(/\b(?:t[ée]l(?:efon|ephone|[ée]phone|efono)?\.?|phone|au|al|at)\s*:?\s*\+?\d[\d\s().-]{5,}/gi, ' ')
    .replace(/(?<![\p{L}\p{N}])(?:ab|under|below|over|from|(?:a partire )?da[il]?|fino a|d[èe]s|[àa] partir de|jusqu['’][àa])\s*\d+(?:\s*[-–]\s*\d+)?\s*(?:jahren?|years?|anni|ans)\b/giu, ' ')
    .replace(/\bgratuita\b/gi, 'gratuito');
  const amountFromText = text => Number.parseFloat(text.replace(/['’\s]/g, '').replace(',', '.'));
  const money = [...tariff.matchAll(TARIFF_MONEY_RE)].map(({ groups }) => ({
    amount: Math.min(...[...(groups.after || groups.before).matchAll(new RegExp(TARIFF_NUMBER, 'gu'))]
      .map(match => amountFromText(match[0]))),
    currency: /EUR|€/iu.test(groups.prefix || groups.suffix) ? 'EUR' : 'CHF',
  })).filter(({ amount }) => Number.isFinite(amount));
  const unknown = { amount: null, currency: 'CHF', isFree: false };
  // Swiss trailing-dash prices are monetary markers too, unlike a category or
  // quantity. A standalone marker means CHF; an explicitly labelled amount
  // such as EUR 15.– was already parsed with its own currency above.
  const marked = [...tariff.replace(TARIFF_MONEY_RE, ' ').matchAll(SWISS_MARKED_TARIFF_RE)]
    .map(match => amountFromText(match[1])).filter(Number.isFinite);
  if (!money.length && TARIFF_CURRENCY_RE.test(tariff)) return unknown;
  for (const amount of marked) money.push({ amount, currency: 'CHF' });
  const currencies = new Set(money.map(({ currency }) => currency));
  if (currencies.size > 1) return unknown;
  if (money.length) {
    // Different currencies are not comparable without an exchange rate.
    const cheapest = money.reduce((best, candidate) => candidate.amount < best.amount ? candidate : best);
    return { ...cheapest, isFree: cheapest.amount === 0 };
  }
  // A currency marker with an invalid amount must not fall through to the
  // legacy numeric parser (e.g. a partial match inside "CHF 1,000").
  if (TARIFF_CURRENCY_RE.test(tariff)) return unknown;
  // A leading free tariff is authoritative even when dates or opening hours
  // follow it. Do not promote a conditional "Children free, adults 20".
  if (/\b(?:free|gratuit[oa]?|gratis|kostenlos|frei|libre)(?:\s+(?:entrance|entry|admission))?\s+(?:for|pour|per|für|nur|solo|soltanto|seulement|under|below|children|kids|bambini|enfants|kinder)\b/iu.test(tariff)) return unknown;
  const leadingWords = tariff.trim().match(/^([\p{L}]+)(?:[\s:]+([\p{L}]+))?/u);
  if (leadingWords) {
    const freeWord = parsePriceText(leadingWords[1]);
    const admissionLabel = /^(?:admission|entry|entrance|eintritt|entr[ée]e|ingresso|entrata|prices?|preis|prix|prezzo)$/iu;
    const freeAdmission = admissionLabel.test(leadingWords[1]) && leadingWords[2]
      ? parsePriceText(`${leadingWords[1]} ${leadingWords[2]}`) : undefined;
    if (freeWord?.isFree || freeAdmission?.isFree) return { amount: 0, currency: 'CHF', isFree: true };
  }
  if (/\d/u.test(tariff) && !BARE_TARIFF_RE.test(tariff.trim())) return unknown;
  if (BARE_TARIFF_RE.test(tariff.trim())) {
    return parsePriceText(tariff.replace(/['’\u00a0\u202f]/g, '').replace(/(?<=\d) (?=\d)/g, ''));
  }
  return parsePriceText(tariff);
}

function normalizedOfferField(field, value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  if (field === 'url') return absoluteHttpUrl(raw, baseUrl);
  if (field === 'availability') {
    return normalizeSchemaOrgItemAvailability(raw);
  }
  if (field === 'validFrom') return normalizeSchemaOrgDateTime(raw);
  return raw;
}

/**
 * Preserve only source-published optional Offer fields. Ticket availability,
 * sale start and purchase URLs are facts about the source ticketing flow; the
 * event information page or the event date is not a safe substitute.
 */
export function extractEventOfferMetadata(value, baseUrl) {
  const selected = selectedOffer(value, baseUrl);
  if (!selected) return undefined;
  const metadata = {};
  for (const field of OFFER_METADATA_FIELDS) {
    const normalized = normalizedOfferField(field, selected.offer[field], baseUrl);
    if (normalized) metadata[field] = normalized;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

/** Fill missing source Offer fields from a later localized JSON-LD variant. */
export function mergeEventOfferMetadata(primaryValue, candidateValue, primaryUrl, candidateUrl) {
  const primaryEntries = offerEntries(primaryValue);
  if (!primaryEntries.length) {
    const candidateEntries = offerEntries(candidateValue);
    const selectedCandidate = selectedOffer(candidateValue, candidateUrl);
    if (!selectedCandidate) return candidateValue || primaryValue;
    const normalizedCandidate = { ...selectedCandidate.offer };
    for (const field of OFFER_METADATA_FIELDS) {
      const normalized = normalizedOfferField(field, normalizedCandidate[field], candidateUrl);
      if (normalized) normalizedCandidate[field] = normalized;
    }
    const normalizedEntries = candidateEntries.map((entry) => (
      entry === selectedCandidate.offer ? normalizedCandidate : entry
    ));
    return Array.isArray(candidateValue) ? normalizedEntries : normalizedEntries[0];
  }
  if (!candidateValue) return primaryValue;
  const candidateMetadata = extractEventOfferMetadata(candidateValue, candidateUrl);
  if (!candidateMetadata) return primaryValue;
  const selected = selectedOffer(primaryValue, primaryUrl);
  const selectedCandidate = selectedOffer(candidateValue, candidateUrl);
  const primaryAmount = eventOfferPriceAmount(selected?.offer?.price);
  const candidateAmount = eventOfferPriceAmount(selectedCandidate?.offer?.price);
  if (!selected || !selectedCandidate || !Number.isFinite(primaryAmount)
    || !Number.isFinite(candidateAmount) || primaryAmount !== candidateAmount) {
    return primaryValue;
  }

  const mergedOffer = { ...selected.offer };
  let changed = false;
  for (const field of OFFER_METADATA_FIELDS) {
    if (normalizedOfferField(field, mergedOffer[field], primaryUrl)) continue;
    if (!candidateMetadata[field]) continue;
    mergedOffer[field] = candidateMetadata[field];
    changed = true;
  }
  if (!changed) return primaryValue;
  const mergedEntries = primaryEntries.map((entry) => (entry === selected.offer ? mergedOffer : entry));
  return Array.isArray(primaryValue) ? mergedEntries : mergedEntries[0];
}

/** Return the first usable image URL from schema.org Image/Object/array forms. */
export function firstEventImageUrl(value, baseUrl) {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    const raw = typeof entry === 'string'
      ? entry
      : entry?.url || entry?.contentUrl || entry?.thumbnailUrl || entry?.src || entry?.imageUrl || entry?.href;
    const url = absoluteHttpUrl(raw, baseUrl);
    if (url) return url;
  }
  return undefined;
}

/**
 * Normalize schema.org organizer/performer values while preserving the source
 * entity type and URL when present. A singular source value stays singular;
 * arrays stay arrays so the dataset does not invent cardinality. The event
 * page URL is discarded when an older crawl persisted it as an entity URL.
 */
export function normalizeEventPeople(value, baseUrl, eventPageUrl) {
  if (value === undefined || value === null) return undefined;
  const inputWasArray = Array.isArray(value);
  const entries = inputWasArray ? value : [value];
  const eventPageIdentity = pageUrlIdentity(eventPageUrl, baseUrl);
  const seen = new Set();
  const people = [];

  for (const entry of entries) {
    const rawName = typeof entry === 'string' ? entry : entry?.name;
    const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : '';
    if (!name) continue;
    const sourceUrl = absoluteHttpUrl(typeof entry === 'object' ? entry?.url : undefined, baseUrl);
    const url = sourceUrl && pageUrlIdentity(sourceUrl, baseUrl) !== eventPageIdentity ? sourceUrl : undefined;
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

/** Normalize only source-named event people; a catalog is not the event host. */
export function fillEventPeopleDefaults(event, source = {}) {
  const baseUrl = absoluteHttpUrl(event?.url, source?.homepage)
    || absoluteHttpUrl(source?.homepage)
    || 'https://frontaliereticino.ch';
  const organizer = normalizeEventPeople(event?.organizer, baseUrl, event?.url);
  const performer = normalizeEventPeople(event?.performer, baseUrl, event?.url);
  const { organizer: _organizer, performer: _performer, ...rest } = event;
  return {
    ...rest,
    ...(organizer ? { organizer } : {}),
    ...(performer ? { performer } : {}),
  };
}

const ADDRESS_NAME_STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'd', 'l']);
const ADDRESS_TOKEN_ALIASES = Object.freeze({
  av: 'avenue',
  ave: 'avenue',
  bd: 'boulevard',
  rte: 'route',
  ch: 'chemin',
  pl: 'place',
  str: 'strasse',
  strasse: 'strasse',
});

function comparisonToken(value) {
  const token = String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  return ADDRESS_TOKEN_ALIASES[token] || token;
}

function nameTokens(value) {
  const text = String(value ?? '');
  const tokens = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const key = comparisonToken(match[0]);
    if (key && !ADDRESS_NAME_STOPWORDS.has(key)) tokens.push({ key, start: match.index });
  }
  return tokens;
}

const foldName = (value) => nameTokens(value).map(({ key }) => key).join(' ');

function nameWithoutAddress(name, addressParts) {
  const nameText = String(name ?? '');
  const tokens = nameTokens(nameText);
  const folded = tokens.map(({ key }) => key);
  for (const part of addressParts) {
    const addressTokens = nameTokens(part).map(({ key }) => key);
    if (!addressTokens.length || addressTokens.length > folded.length) continue;
    const suffixStart = folded.length - addressTokens.length;
    if (!addressTokens.every((token, index) => folded[suffixStart + index] === token)) continue;
    if (suffixStart === 0) return '';
    return nameText.slice(0, tokens[suffixStart].start).replace(/[\s,;:–—-]+$/u, '').trim();
  }
  return nameText;
}

function cleanEntities(value, addressParts, droppedNames = []) {
  if (value === undefined || value === null) return undefined;
  const wasArray = Array.isArray(value);
  const cleaned = (wasArray ? value : [value]).flatMap((entity) => {
    const name = nameWithoutAddress(entity?.name, addressParts);
    if (!name || droppedNames.includes(foldName(name))) return [];
    return [name === entity.name ? entity : { ...entity, name }];
  });
  if (!cleaned.length) return undefined;
  return wasArray ? cleaned : cleaned[0];
}

/**
 * Remove addresses from the people of an event. Records already carry them:
 * the crawlers stamped the venue as performer ("Fiescheralp 4") and agendas
 * concatenate the address to the organizer ("Schweizer Skischule Fiesch
 * Fiescheralp 4"). Only the address the event itself states counts: a name
 * like "Maroon 5" reads as one but has no such evidence. A venue without
 * digits is a place name, so it may organize its own show, not perform in it.
 */
export function withoutAddressPeople(event, source = {}) {
  const venue = foldName(event?.venue);
  const street = foldName(event?.address?.street);
  const locality = foldName(event?.address?.locality);
  const addressParts = [
    street && locality ? `${street} ${locality}` : '',
    street,
    /\d/.test(venue) ? venue : '',
  ].filter(Boolean);
  const organizer = cleanEntities(event?.organizer, addressParts);
  const performer = cleanEntities(event?.performer, addressParts, [
    venue,
    foldName(source?.label),
    foldName(event?.sourceName),
  ].filter(Boolean));
  const { organizer: _organizer, performer: _performer, ...rest } = event;
  return {
    ...rest,
    ...(organizer ? { organizer } : {}),
    ...(performer ? { performer } : {}),
  };
}

/** Return true only when every normalized named entity has a usable URL. */
export function hasCompleteEventPeopleUrls(value) {
  if (value === undefined || value === null) return false;
  const entries = Array.isArray(value) ? value : [value];
  return entries.length > 0 && entries.every((entry) => typeof entry?.url === 'string' && /^https?:\/\//i.test(entry.url));
}

function eventPersonNameKey(value) {
  return typeof value?.name === 'string' ? value.name.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

/** Merge source-backed URLs into matching primary people without dropping entries. */
export function mergeEventPeopleUrls(primary, candidate) {
  if (primary === undefined || primary === null) return candidate;
  if (candidate === undefined || candidate === null) return primary;
  const primaryWasArray = Array.isArray(primary);
  const primaryEntries = primaryWasArray ? primary : [primary];
  const candidateEntries = Array.isArray(candidate) ? candidate : [candidate];
  const merged = primaryEntries.map((entry) => (
    entry && typeof entry === 'object' ? { ...entry } : entry
  ));

  for (const candidateEntry of candidateEntries) {
    const candidateName = eventPersonNameKey(candidateEntry);
    if (!candidateName || typeof candidateEntry?.url !== 'string') continue;
    const index = merged.findIndex((entry) => eventPersonNameKey(entry) === candidateName);
    if (index < 0) continue;
    const current = merged[index];
    if (current && typeof current === 'object' && !current.url) {
      merged[index] = { ...current, url: candidateEntry.url };
    }
  }

  return primaryWasArray ? merged : merged[0];
}

function sourceText(value) {
  return cleanEventText(value);
}

function sourceEntityName(value) {
  const name = sourceText(value)
    .replace(/^[\s:;,.()\[\]{}"“”„«»'‘’-]+|[\s,;:.()\[\]{}"“”„«»'‘’-]+$/g, '')
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
    .split(/\s*,\s*|\s+(?:und|and|e|et)\s+|\s*&\s*/iu)
    .map((part) => sourceEntityName(part))
    .filter(Boolean);
  return parts.length > 1 ? parts : [raw];
}

const PERFORMER_NAME_TOKEN = String.raw`\p{Lu}[\p{L}\p{M}'’\-]*`;
const PERFORMER_NAME = String.raw`${PERFORMER_NAME_TOKEN}(?:\s+${PERFORMER_NAME_TOKEN}){0,2}`;
const PERFORMER_PERSON_NAME = String.raw`${PERFORMER_NAME_TOKEN}(?:\s+${PERFORMER_NAME_TOKEN}){1,3}`;
const PERFORMER_GROUP_NAME_RE = /\b(?:string\s+quartet|trio|quartet|quartett|quartetto|ensemble|orchestra|orchester|band|duo)\s*$/iu;
const PERFORMANCE_CATEGORY_RE = /\b(?:music[\s-]?event|music(?:al)?|musik|musique|musica|pop|jazz|rock|rap|hip[\s-]?hop|cantautor[ei]|singer[\s-]?songwriter|liedermacher|chanson|concert|konzert|cabaret|kabarett)\b/iu;
const SOLO_PERFORMER_CATEGORY_RE = /\b(?:music[\s-]?event|altri\s+musica(?:le)?|altre?\s+musiche?|other\s+music|autres?\s+musiques?|(?:andere|sonstige)\s+musik)\b/iu;
const PERFORMER_TITLE_RESERVED_PHRASE_RE = /\bopen\s+air\b/iu;
const PERFORMER_TITLE_RESERVED_WORD_RE = /^(?:music(?:al)?|musik|musique|musica|concert|konzert|concerto|festival|fest|gala|show|event|evento|veranstaltung|abend|evening|soiree|soirée|serata|party|opera|oper|operette|cabaret|kabarett|jazz|pop|rock|rap|hip[\s-]?hop|cantautor[ei]|singer[\s-]?songwriter|liedermacher|chanson|dance|tanz|ballet|ballett|theater|theatre|fair|fiera|foire|messe|exhibition|ausstellung|exposition|conference|konferenz|summit|award(?:s)?|prize|preis)$/iu;

function isCapitalizedPerformerName(value) {
  const name = sourceEntityName(value);
  if (!name) return false;
  return name.split(/\s+/u).every((token) => (
    /^(?:and|und|e|et|de|del|della|di|da|du|der|den|van|von|la|le|al|bin|ibn|of)$/iu.test(token)
    || /^\p{Lu}/u.test(token)
  ));
}

function isSpecificPerformerTitle(value) {
  const name = sourceEntityName(value);
  return Boolean(name)
    && isCapitalizedPerformerName(name)
    && !PERFORMER_TITLE_RESERVED_PHRASE_RE.test(name)
    && !name.split(/\s+/u).some((token) => PERFORMER_TITLE_RESERVED_WORD_RE.test(token));
}

function collectCapturedNames(text, patterns) {
  const names = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const expression = new RegExp(pattern.source, flags);
    let match;
    while ((match = expression.exec(text))) {
      const captured = sourceEntityName(match[1]?.replace(/\s+(?:und|and|e|et)$/iu, ''));
      if (captured) {
        for (const name of splitPerformerNames(captured)) {
          if (isCapitalizedPerformerName(name)) names.push(name);
        }
      }
      if (match[0].length === 0) expression.lastIndex += 1;
    }
  }
  const unique = new Map();
  for (const name of names) {
    const key = name.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, name);
  }
  return [...unique.values()];
}

function performerEntities(names, forceGroup = false) {
  return names.map((name) => ({
    ...((forceGroup || PERFORMER_GROUP_NAME_RE.test(name)) ? { '@type': 'PerformingGroup' } : {}),
    name,
  }));
}

function performerValue(names, forceGroup = false) {
  const entities = performerEntities(names, forceGroup);
  if (!entities.length) return undefined;
  return entities.length === 1 ? entities[0] : entities;
}

const ORGANIZER_PATTERNS = [
  /\b(?:präsentiert|presentiert)\s+von\s+(.+?)(?=Mitwirkende(?:\s+und\s+Zusatzinformationen)?\s*:|[.!?](?:\s|$)|$)/iu,
  /\b(?:presentat[oaie]|présent(?:é|ée|és|ées))\s+(?:da|par)\s+(.+?)(?=Mitwirkende(?:\s+und\s+Zusatzinformationen)?\s*:|[.!?](?:\s|$)|$)/iu,
  /\b(?:presented|organ(?:ized|ised)|organizzat[oaie]|organis(?:iert|é|ée|és|ées))\s+(?:by|da|par|von)\s+(.+?)(?=Mitwirkende(?:\s+und\s+Zusatzinformationen)?\s*:|[.!?](?:\s|$)|$)/iu,
  /\b(?:veranstalter(?:in)?|organizzatore|organisateur(?:rice)?|organizer|organiser)\s*:\s*(.+?)(?=[.!?](?:\s|$)|$)/iu,
];

const PERFORMER_PATTERNS = [
  /\b(?:mit|con|avec|with|featuring|feat\.?)\s+[«“„"']([^.!?«„"']{1,120}?)(?:[»”"']|(?=[.!?](?:\s|$)|$))/iu,
  /Mitwirkende(?:\s+und\s+Zusatzinformationen)?\s*:\s*([^.!?]+?)(?=$|[.!?](?:\s|$)|\b(?:Treffpunkt|Ort|Location|Lieu|Luogo)\s*:)/iu,
  /\bGestaltet\s+wird\s+(?:der|die|das)\s+.+?\s+von\s+([^.!?]+?)(?=[.!?](?:\s|$)|$)/iu,
  /\bvon\s+und\s+mit\s+([^.!?]+?)(?=[.!?](?:\s|$)|$)/iu,
  /\b(?:di\s+e\s+con|de\s+et\s+avec)\s+([A-ZÀ-ÖØ-Þ][^.!?]{1,120}?)(?=[.!?](?:\s|$)|$)/iu,
  new RegExp(String.raw`\b(${PERFORMER_NAME}(?:\s+(?:und|and|e|et)\s+${PERFORMER_NAME}){1,3})\s+(?:greifen|spielen|musizieren|singen|performen|adattano|adapts?|play(?:s|ed|ing)?|perform(?:s|ed|ing)?|sing(?:s|ing)?|joue(?:nt)?|suon(?:a|ano)|interpret(?:a|ano|an))\b`, 'gu'),
  new RegExp(String.raw`\b(?:[Tt]rio|[Qq]uartet|[Qq]uartett|[Qq]uartetto|[Ee]nsemble|[Bb]and|[Oo]rchestra|[Oo]rchester)\b[^.!?]{0,80}?\b(?:[Bb]rings\s+together|[Ii]s\s+made\s+up\s+of|[Cc]onsists\s+of|[Cc]omprises|[Ii]ncludes|[Gg]athers|[Bb]esteht\s+aus|[Bb]ringt\s+.+?\s+zusammen|[Rr]éunit|[Rr]eunit|[Rr]iunisce|[Cc]omprend|[Cc]omprende)\s+(${PERFORMER_NAME}(?:\s*,\s*${PERFORMER_NAME})*(?:\s+(?:and|und|e|et)\s+${PERFORMER_NAME}){0,3})`, 'gu'),
  new RegExp(String.raw`\b(?:[Mm]usic(?:al)?|[Mm]usik|[Mm]usique|[Mm]usica|[Pp]op|[Jj]azz|[Rr]ock|[Cc]oncert|[Kk]onzert|[Cc]abaret|[Kk]abarett|[Ee]vent|[Ee]vento|[Aa]ppuntamento|[Vv]eranstaltung|[Éé]vénement|[Ee]venement|[Rr]endez-vous)[\p{L}\p{M}\s-]{0,48}?\b(?:[Pp]resents|[Pp]resented|[Ff]eatures|[Pp]räsentiert|[Pp]resentiert|[Pp]resenta|[Pp]résente)\s+(${PERFORMER_NAME})\b`, 'gu'),
  new RegExp(String.raw`\b(?:[Cc]antante|[Cc]hitarrista|[Ff]licornista|[Ff]licorniste|[Ff]lugelhorn|[Ff]lügelhorn|[Ff]lugelhornist|[Pp]ianista|[Mm]usicista|[Vv]iolinista|[Ss]inger|[Vv]ocalist|[Gg]uitarist|[Pp]ianist|[Mm]usician|[Aa]ctor|[Aa]ctress|[Pp]erformer|[Cc]hanteur|[Cc]hanteuse|[Gg]uitariste|[Mm]usicien|[Mm]usicienne|[Ss]änger(?:in)?|[Gg]itarrist(?:in)?|[Mm]usiker(?:in)?|[Kk]ünstler(?:in)?)[^,;.!?]{0,80}?\b(${PERFORMER_NAME})\b`, 'gu'),
  new RegExp(String.raw`\b(${PERFORMER_NAME}\s+(?:[Ss]tring\s+[Qq]uartet|[Tt]rio|[Qq]uartet|[Qq]uartett|[Qq]uartetto|[Ee]nsemble|[Oo]rchestra|[Oo]rchester|[Bb]and|[Dd]uo))\b`, 'gu'),
  /\b(?:mit|con|avec|with|featuring|feat\.?)\s+([A-ZÀ-ÖØ-Þ][^.!?]{1,120}?)(?=[.!?](?:\s|$)|$)/iu,
];

const TITLE_PERFORMER_PATTERNS = [
  /\b(?:präsentiert|presentiert|presented|presenta|présente)\s*:\s*(\p{Lu}[\p{L}\p{M}'’\-]*(?:\s+\p{Lu}[\p{L}\p{M}'’\-]*){1,4}(?:\s*(?:&|und|and|e|et)\s*\p{Lu}[\p{L}\p{M}'’\-]*(?:\s+\p{Lu}[\p{L}\p{M}'’\-]*){1,4})*)/iu,
  /\b(?:mit|con|avec|with|featuring|feat\.?)\s+[«“„"']([^.!?«„"']{1,120}?)(?:[»”"']|(?=[.!?](?:\s|$)|$))/iu,
  new RegExp(String.raw`\b(?:[Mm]it|[Cc]on|[Aa]vec|[Ww]ith|[Ff]eaturing|[Ff]eat\.?)\s+(\p{Lu}[\p{L}\p{M}'’\-]*(?:\s+\p{Lu}[\p{L}\p{M}'’\-]*){1,4}(?:\s*(?:&|und|and|e|et)\s*\p{Lu}[\p{L}\p{M}'’\-]*(?:\s+\p{Lu}[\p{L}\p{M}'’\-]*){1,4})*)`, 'u'),
];

/**
 * Extract only explicit source-language attribution phrases from event copy.
 * This is intentionally narrower than a generic named-entity recognizer:
 * venue, title and prose must never be promoted to organizer/performer just
 * because they contain a capitalized word.
 */
export function extractEventPeopleFromText(value, options = {}) {
  const text = sourceText(value);
  if (!text) return {};

  const organizerName = firstCaptured(text, ORGANIZER_PATTERNS);
  const performerPatterns = options.includePerformer === false
    ? []
    : options.includePerformer === 'explicit'
      ? PERFORMER_PATTERNS.slice(0, -1)
      : PERFORMER_PATTERNS;
  const performerNames = collectCapturedNames(text, performerPatterns);
  return {
    ...(organizerName ? { organizer: { '@type': 'Organization', name: organizerName } } : {}),
    ...(performerNames.length ? { performer: performerValue(performerNames) } : {}),
  };
}

/**
 * Extract the deliberately stronger performer signal used by event titles.
 * Unquoted titles require at least two capitalized name tokens, so phrases
 * such as "Menschen mit Demenz" or "Klangmeditation mit Bergkristall" do
 * not become false performers merely because they contain "mit".
 */
export function extractEventPeopleFromTitle(value, options = {}) {
  const text = sourceText(value);
  if (!text) return {};
  const explicitName = firstCaptured(text, TITLE_PERFORMER_PATTERNS);
  if (explicitName) return { performer: performerValue(splitPerformerNames(explicitName)) };
  const category = sourceText(options.category);
  if (!PERFORMANCE_CATEGORY_RE.test(category)) return {};

  const groupMatch = new RegExp(String.raw`^\s*(${PERFORMER_NAME}(?:\s+${PERFORMER_NAME_TOKEN}){0,1}\s+(?:[Ss]tring\s+[Qq]uartet|[Tt]rio|[Qq]uartet|[Qq]uartett|[Qq]uartetto|[Ee]nsemble|[Oo]rchestra|[Oo]rchester|[Bb]and|[Dd]uo))\s*$`, 'u').exec(text);
  if (groupMatch && isSpecificPerformerTitle(groupMatch[1])) return { performer: performerValue([groupMatch[1]], true) };

  const nameBeforeShow = new RegExp(String.raw`^\s*(${PERFORMER_PERSON_NAME})\s+[«“„"'][^.!?«„"']+[»”„"']\s*$`, 'u').exec(text)?.[1];
  if (nameBeforeShow && isSpecificPerformerTitle(nameBeforeShow)) return { performer: performerValue([nameBeforeShow]) };

  const nameBeforeSubtitle = new RegExp(String.raw`^\s*(${PERFORMER_PERSON_NAME})\s*[–—-]\s+.+$`, 'u').exec(text)?.[1];
  if (nameBeforeSubtitle && isSpecificPerformerTitle(nameBeforeSubtitle)) return { performer: performerValue([nameBeforeSubtitle]) };

  const duoName = new RegExp(String.raw`^\s*(${PERFORMER_NAME}(?:\s+${PERFORMER_NAME_TOKEN}){0,1}\s*&\s*${PERFORMER_NAME}(?:\s+${PERFORMER_NAME_TOKEN}){0,1})\s*$`, 'u').exec(text)?.[1];
  if (duoName) {
    const names = splitPerformerNames(duoName);
    if (names.length === 2 && names.every(isSpecificPerformerTitle)) return { performer: performerValue(names) };
  }

  const personName = new RegExp(String.raw`^\s*(${PERFORMER_PERSON_NAME})\s*$`, 'u').exec(text)?.[1];
  // Standalone names need a source category that identifies a music act;
  // broad labels like "Music" also classify events titled "Open Air".
  return personName && SOLO_PERFORMER_CATEGORY_RE.test(category) && isSpecificPerformerTitle(personName)
    ? { performer: performerValue([personName]) }
    : {};
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
