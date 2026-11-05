const EVENT_STATUSES = new Set([
  'EventCancelled',
  'EventPostponed',
  'EventRescheduled',
  'EventScheduled',
]);
const EVENT_AVAILABILITY = new Set(['InStock', 'SoldOut', 'PreOrder']);
const EVENT_ATTENDANCE_MODES = new Set([
  'OfflineEventAttendanceMode',
  'OnlineEventAttendanceMode',
  'MixedEventAttendanceMode',
]);
const PERFORMER_TYPES = new Set([
  'Person',
  'PerformingGroup',
  'MusicGroup',
  'DanceGroup',
  'TheaterGroup',
  'SportsTeam',
]);
const ORGANIZER_TYPES = new Set(['Organization', 'Person']);

function typeNames(value) {
  const types = Array.isArray(value) ? value : [value];
  return types
    .filter((type) => typeof type === 'string')
    .map((type) => type.trim().split(/[\/#]/u).pop());
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDateTime(value) {
  if (!isNonEmpty(value)) return false;
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (!dateParts) return false;
  const year = Number(dateParts[1]);
  const month = Number(dateParts[2]);
  const day = Number(dateParts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return false;

  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const isZonedDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
  return (isDateOnly || isZonedDateTime) && Number.isFinite(Date.parse(value));
}

function isHttpUrl(value) {
  if (!isNonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidCurrency(value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/u.test(value)) return false;
  try {
    return value !== 'XXX'
      && new Intl.NumberFormat('en', { style: 'currency', currency: value }).resolvedOptions().currency === value;
  } catch {
    return false;
  }
}

function hasNamedEntities(value, allowedTypes) {
  const entities = Array.isArray(value) ? value : [value];
  return entities.length > 0 && entities.every((entity) => (
    entity
    && typeof entity === 'object'
    && isNonEmpty(entity.name)
    && typeNames(entity['@type']).some((type) => allowedTypes.has(type))
  ));
}

function hasHttpUrls(value) {
  const entities = Array.isArray(value) ? value : [value];
  return entities.length > 0 && entities.every((entity) => isHttpUrl(entity?.url));
}

function imageUrls(value) {
  const images = Array.isArray(value) ? value : [value];
  return images.map((image) => (
    typeof image === 'string'
      ? image
      : image && typeof image === 'object'
        ? image.url || image.contentUrl
        : undefined
  ));
}

function hasCompleteOffer(offer, event) {
  const availability = typeNames(offer?.availability);
  return offer
    && typeof offer === 'object'
    && typeNames(offer['@type']).includes('Offer')
    && typeof offer.price === 'number'
    && Number.isFinite(offer.price)
    && offer.price >= 0
    && isValidCurrency(offer.priceCurrency)
    && availability.some((value) => EVENT_AVAILABILITY.has(value))
    && isValidDateTime(offer.validFrom)
    && isHttpUrl(offer.url)
    && (offer.price !== 0 || event.isAccessibleForFree === true);
}

/**
 * Publish Event markup only when Search Console's reported recommended facts
 * and their supporting details are present. Missing facts stay unknown and
 * the page can still render without Event markup.
 */
export function hasCompleteGoogleEventData(event) {
  if (!event || event['@type'] !== 'Event') return false;
  const location = event.location;
  const address = location?.address;
  const offers = Array.isArray(event.offers) ? event.offers : [event.offers];
  const images = imageUrls(event.image);
  const status = typeNames(event.eventStatus);
  const attendanceModes = typeNames(event.eventAttendanceMode);

  return isNonEmpty(event.name)
    && isValidDateTime(event.startDate)
    && isValidDateTime(event.endDate)
    && isHttpUrl(event.url)
    && isNonEmpty(event.description)
    && event.description.trim().length >= 30
    && images.some(isHttpUrl)
    && typeNames(location?.['@type']).includes('Place')
    && isNonEmpty(location.name)
    && typeNames(address?.['@type']).includes('PostalAddress')
    && isNonEmpty(address.streetAddress)
    && isNonEmpty(address.addressLocality)
    && isNonEmpty(address.addressRegion)
    && isNonEmpty(address.postalCode)
    && isNonEmpty(address.addressCountry)
    && hasNamedEntities(event.performer, PERFORMER_TYPES)
    && hasNamedEntities(event.organizer, ORGANIZER_TYPES)
    && hasHttpUrls(event.organizer)
    && status.some((value) => EVENT_STATUSES.has(value))
    && attendanceModes.some((value) => EVENT_ATTENDANCE_MODES.has(value))
    && offers.length > 0
    && offers.every((offer) => hasCompleteOffer(offer, event))
    && (status.includes('EventRescheduled')
      ? isValidDateTime(event.previousStartDate)
      : !event.previousStartDate);
}
