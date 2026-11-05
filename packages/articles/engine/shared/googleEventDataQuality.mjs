import {
  areSupportedGoogleEventStatuses,
  isGoogleEventStatusCompatible,
  isSupportedGoogleEventAttendanceMode,
  isValidEventDateRange,
} from './google-event-values.mjs';

const EVENT_AVAILABILITY = new Set(['InStock', 'SoldOut', 'PreOrder']);
const ISO_4217_CURRENCIES = new Set(
  // ECMA-402 exposes the runtime's canonical, well-formed ISO 4217 currency set.
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('currency')
    : [],
);
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
  if (types.some((type) => typeof type !== 'string')) return [];
  return types
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

  // Google Search Central accepts date-only values for all-day events and when
  // the event hour is unknown; keep them distinct from synthetic midnight times.
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const isLocalDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.test(value);
  const isZonedDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
  return (isDateOnly || isLocalDateTime || isZonedDateTime) && Number.isFinite(Date.parse(value));
}

function isValidPreviousStartDate(value) {
  const dates = Array.isArray(value) ? value : [value];
  return dates.length > 0 && dates.every(isValidDateTime);
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
  return value !== 'XXX' && ISO_4217_CURRENCIES.has(value);
}

function isSupportedEventAvailability(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (EVENT_AVAILABILITY.has(raw)) return true;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'schema.org' || url.port) return false;
  const member = url.pathname.replace(/^\/+|\/+$/gu, '');
  return EVENT_AVAILABILITY.has(member) && !url.search && !url.hash;
}

function isCompletePhysicalLocation(location) {
  const address = location?.address;
  return location
    && typeof location === 'object'
    && !Array.isArray(location)
    && typeNames(location['@type']).includes('Place')
    && isNonEmpty(location.name)
    && typeNames(address?.['@type']).includes('PostalAddress')
    && isNonEmpty(address.addressLocality)
    && isNonEmpty(address.addressCountry);
}

function isCompleteVirtualLocation(location) {
  return location
    && typeof location === 'object'
    && !Array.isArray(location)
    && typeNames(location['@type']).includes('VirtualLocation')
    && isHttpUrl(location.url);
}

function hasCompleteEventLocation(location, attendanceModes) {
  const locations = Array.isArray(location) ? location : [location];
  if (locations.length === 0) return false;

  if (attendanceModes.length !== 1 || !isSupportedGoogleEventAttendanceMode(attendanceModes[0])) return false;

  const physicalLocations = locations.filter(isCompletePhysicalLocation);
  const virtualLocations = locations.filter(isCompleteVirtualLocation);
  if (physicalLocations.length + virtualLocations.length !== locations.length) return false;

  const [attendanceMode] = attendanceModes;
  if (attendanceMode === 'OfflineEventAttendanceMode') {
    return physicalLocations.length > 0 && virtualLocations.length === 0;
  }
  if (attendanceMode === 'OnlineEventAttendanceMode') {
    return virtualLocations.length > 0 && physicalLocations.length === 0;
  }
  return physicalLocations.length > 0 && virtualLocations.length > 0;
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
  return offer
    && typeof offer === 'object'
    && typeNames(offer['@type']).includes('Offer')
    && typeof offer.price === 'number'
    && Number.isFinite(offer.price)
    && offer.price >= 0
    && isValidCurrency(offer.priceCurrency)
    && (offer.availability === undefined
      ? offer.validFrom !== undefined
      : isSupportedEventAvailability(offer.availability))
    && (offer.validFrom === undefined || isValidDateTime(offer.validFrom))
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
  const offers = Array.isArray(event.offers) ? event.offers : [event.offers];
  const images = imageUrls(event.image);
  const status = typeNames(event.eventStatus);
  const attendanceModes = typeNames(event.eventAttendanceMode);

  return isNonEmpty(event.name)
    && isValidDateTime(event.startDate)
    && isValidDateTime(event.endDate)
    && isValidEventDateRange(event.startDate, event.endDate)
    && isHttpUrl(event.url)
    && isNonEmpty(event.description)
    && event.description.trim().length >= 30
    && images.some(isHttpUrl)
    && hasCompleteEventLocation(event.location, attendanceModes)
    && hasNamedEntities(event.performer, PERFORMER_TYPES)
    && hasNamedEntities(event.organizer, ORGANIZER_TYPES)
    && hasHttpUrls(event.organizer)
    && areSupportedGoogleEventStatuses(status)
    && attendanceModes.length === 1
    && attendanceModes.every(isSupportedGoogleEventAttendanceMode)
    && isGoogleEventStatusCompatible(status, attendanceModes)
    && offers.length > 0
    && offers.every((offer) => hasCompleteOffer(offer, event))
    && (status.includes('EventRescheduled')
      ? status.length === 1
        && status[0] === 'EventRescheduled'
        && isValidPreviousStartDate(event.previousStartDate)
      : event.previousStartDate === undefined);
}
