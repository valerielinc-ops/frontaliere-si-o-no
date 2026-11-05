import { normalizeSchemaOrgDateTime, normalizeSchemaOrgItemAvailability } from './schema-org-values.mjs';
import {
  areSupportedGoogleEventStatuses,
  isGoogleEventStatusCompatible,
  isSupportedGoogleEventAttendanceMode,
  isValidEventDateRange,
} from '../../packages/articles/engine/shared/google-event-values.mjs';
const ISO_4217_CURRENCIES = new Set(
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('currency')
    : [],
);
function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function schemaTypeName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().split(/[\/#]/u).pop() || '';
}

function schemaTypeNames(value) {
  const types = Array.isArray(value) ? value : [value];
  if (types.some((type) => typeof type !== 'string')) return [];
  return types.map(schemaTypeName);
}

function schemaTypeMatches(value, expected) {
  const types = Array.isArray(value) ? value : [value];
  if (types.some((type) => typeof type !== 'string')) return false;
  return types.some((type) => schemaTypeName(type) === expected);
}

function isValidCurrency(value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/u.test(value)) return false;
  return value !== 'XXX' && ISO_4217_CURRENCIES.has(value);
}

function isValidDate(value) {
  return normalizeSchemaOrgDateTime(value) !== undefined;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateEventLocation(schema, filePath, errors) {
  const requestedModes = schema.eventAttendanceMode === undefined
    ? ['OfflineEventAttendanceMode']
    : schemaTypeNames(schema.eventAttendanceMode);
  const requestedMode = requestedModes.length === 1 ? requestedModes[0] : '';
  const attendanceMode = isSupportedGoogleEventAttendanceMode(requestedMode)
    ? requestedMode
    : 'OfflineEventAttendanceMode';
  const locations = Array.isArray(schema.location) ? schema.location : [schema.location];
  if (!schema.location || locations.length === 0) {
    errors.push({ file: filePath, type: 'Event', field: 'location', message: 'Event missing "location"' });
    return;
  }

  let physicalCount = 0;
  let virtualCount = 0;
  locations.forEach((location, index) => {
    const field = Array.isArray(schema.location) ? `location[${index}]` : 'location';
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
      errors.push({ file: filePath, type: 'Event', field, message: `Event "${field}" must be a Place or VirtualLocation` });
      return;
    }

    const isPhysicalLocation = schemaTypeMatches(location['@type'], 'Place');
    const isVirtualLocation = schemaTypeMatches(location['@type'], 'VirtualLocation');
    if (isPhysicalLocation && !isVirtualLocation) {
      physicalCount += 1;
      if (attendanceMode === 'OnlineEventAttendanceMode') {
        errors.push({ file: filePath, type: 'Event', field: `${field}.@type`, message: 'Online Event location must use VirtualLocation' });
      }
      if (!isNonEmpty(location.name)) {
        errors.push({ file: filePath, type: 'Event', field: `${field}.name`, message: `Event missing "${field}.name"` });
      }
      const address = location.address;
      if (!address || typeof address !== 'object' || Array.isArray(address)) {
        errors.push({ file: filePath, type: 'Event', field: `${field}.address`, message: `Event missing "${field}.address"` });
      } else {
        if (!schemaTypeMatches(address['@type'], 'PostalAddress')) {
          errors.push({ file: filePath, type: 'Event', field: `${field}.address.@type`, message: `Event "${field}.address" must use PostalAddress` });
        }
        const requiredAddressFields = [
          address.streetAddress,
          address.addressLocality,
          address.addressRegion,
          address.postalCode,
          address.addressCountry,
        ];
        if (!requiredAddressFields.every(isNonEmpty)) {
          errors.push({ file: filePath, type: 'Event', field: `${field}.address`, message: `Event "${field}.address" needs a complete postal address` });
        }
      }
    } else if (isVirtualLocation && !isPhysicalLocation) {
      virtualCount += 1;
      if (attendanceMode === 'OfflineEventAttendanceMode') {
        errors.push({ file: filePath, type: 'Event', field: `${field}.@type`, message: 'Offline Event location must use Place' });
      }
      if (!isHttpUrl(location.url)) {
        errors.push({ file: filePath, type: 'Event', field: `${field}.url`, message: `Event "${field}.url" must be an absolute HTTP(S) URL` });
      }
    } else {
      errors.push({ file: filePath, type: 'Event', field: `${field}.@type`, message: `Event "${field}" must use Place or VirtualLocation` });
    }
  });

  if (attendanceMode !== 'OnlineEventAttendanceMode' && physicalCount === 0) {
    errors.push({ file: filePath, type: 'Event', field: 'location', message: 'Event attendance mode requires a physical Place' });
  }
  if (attendanceMode !== 'OfflineEventAttendanceMode' && virtualCount === 0) {
    errors.push({ file: filePath, type: 'Event', field: 'location', message: 'Event attendance mode requires a VirtualLocation' });
  }
}

function imageUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return typeof value.url === 'string' ? value.url : typeof value.contentUrl === 'string' ? value.contentUrl : '';
}

function validateNamedEntities(value, field, filePath, errors) {
  if (value === undefined || value === null) return;
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.length || entries.some((entry) => !entry || typeof entry !== 'object' || !isNonEmpty(entry.name))) {
    errors.push({ file: filePath, type: 'Event', field, message: `Event "${field}" must include a named Person or Organization when present` });
  }
}

function validateOffer(offer, index, schema, filePath, errors) {
  const field = `offers${index === 0 ? '' : `[${index}]`}`;
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    errors.push({ file: filePath, type: 'Event', field, message: `Event "${field}" must be an object` });
    return;
  }
  const type = schemaTypeName(offer['@type']);
  if (!['Offer', 'AggregateOffer'].includes(type)) {
    errors.push({ file: filePath, type: 'Event', field: `${field}.@type`, message: `Event "${field}" must use Offer or AggregateOffer` });
  }
  const amountField = type === 'AggregateOffer' ? 'lowPrice' : 'price';
  const amount = offer[amountField];
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    errors.push({ file: filePath, type: 'Event', field: `${field}.${amountField}`, message: `Event "${field}.${amountField}" must be a non-negative finite number` });
  } else if (amount === 0 && schema.isAccessibleForFree !== true) {
    errors.push({ file: filePath, type: 'Event', field: `${field}.${amountField}`, message: `Event "${field}.${amountField}=0" requires isAccessibleForFree=true` });
  }
  if (!isValidCurrency(offer.priceCurrency)) {
    errors.push({ file: filePath, type: 'Event', field: `${field}.priceCurrency`, message: `Event "${field}.priceCurrency" must be a valid ISO 4217 code` });
  }
  if (type === 'AggregateOffer' && offer.highPrice !== undefined
    && (typeof offer.highPrice !== 'number' || !Number.isFinite(offer.highPrice) || offer.highPrice < amount)) {
    errors.push({ file: filePath, type: 'Event', field: `${field}.highPrice`, message: `Event "${field}.highPrice" must be finite and not below lowPrice` });
  }
  if (offer.availability !== undefined) {
    if (!normalizeSchemaOrgItemAvailability(offer.availability)) {
      errors.push({ file: filePath, type: 'Event', field: `${field}.availability`, message: `Event "${field}.availability" is not a supported ticket state` });
    }
  }
  if (offer.validFrom !== undefined && !isValidDate(offer.validFrom)) {
    errors.push({ file: filePath, type: 'Event', field: `${field}.validFrom`, message: `Event "${field}.validFrom" must be an ISO date or date-time` });
  }
  if (offer.url !== undefined && !isHttpUrl(offer.url)) {
    errors.push({ file: filePath, type: 'Event', field: `${field}.url`, message: `Event "${field}.url" must be an absolute HTTP(S) URL` });
  }
}

/** Validate Google's required Event properties and the integrity of optional claims. */
export function validateEventStructuredData(schema, filePath) {
  const errors = [];
  if (schema?.['@type'] !== 'Event') return errors;
  const eventStatuses = schemaTypeNames(schema.eventStatus);
  const attendanceModes = schemaTypeNames(schema.eventAttendanceMode);

  if (!isNonEmpty(schema.name)) {
    errors.push({ file: filePath, type: 'Event', field: 'name', message: 'Event missing "name"' });
  }
  if (!isValidDate(schema.startDate)) {
    errors.push({ file: filePath, type: 'Event', field: 'startDate', message: 'Event requires a valid ISO "startDate"' });
  }
  if (schema.endDate !== undefined && !isValidDate(schema.endDate)) {
    errors.push({ file: filePath, type: 'Event', field: 'endDate', message: 'Event "endDate" must be an ISO date or date-time when present' });
  }
  if (schema.endDate !== undefined && isValidDate(schema.startDate) && isValidDate(schema.endDate)
    && !isValidEventDateRange(schema.startDate, schema.endDate)) {
    errors.push({ file: filePath, type: 'Event', field: 'endDate', message: 'Event "endDate" must not be before "startDate"' });
  }
  if (schema.description !== undefined && String(schema.description || '').trim().length < 30) {
    const length = String(schema.description || '').trim().length;
    errors.push({ file: filePath, type: 'Event', field: 'description', message: `Event description too short (${length} chars, need >= 30)` });
  }

  validateEventLocation(schema, filePath, errors);

  if (schema.eventStatus !== undefined && !areSupportedGoogleEventStatuses(eventStatuses)) {
    errors.push({ file: filePath, type: 'Event', field: 'eventStatus', message: 'Event "eventStatus" is not a supported status' });
  }
  if (!isGoogleEventStatusCompatible(eventStatuses, attendanceModes)) {
    errors.push({ file: filePath, type: 'Event', field: 'eventAttendanceMode', message: 'EventMovedOnline requires OnlineEventAttendanceMode' });
  }
  if (schema.eventAttendanceMode !== undefined
    && (attendanceModes.length !== 1 || !isSupportedGoogleEventAttendanceMode(attendanceModes[0]))) {
    errors.push({ file: filePath, type: 'Event', field: 'eventAttendanceMode', message: 'Event "eventAttendanceMode" is not supported' });
  }
  if (schema.image !== undefined) {
    const images = Array.isArray(schema.image) ? schema.image : [schema.image];
    if (!images.length || images.some((image) => !isHttpUrl(imageUrl(image)))) {
      errors.push({ file: filePath, type: 'Event', field: 'image', message: 'Event image must contain an absolute HTTP(S) URL when present' });
    }
  }
  validateNamedEntities(schema.organizer, 'organizer', filePath, errors);
  validateNamedEntities(schema.performer, 'performer', filePath, errors);

  if (schema.offers !== undefined && schema.offers !== null) {
    const offers = Array.isArray(schema.offers) ? schema.offers : [schema.offers];
    if (!offers.length) errors.push({ file: filePath, type: 'Event', field: 'offers', message: 'Event "offers" cannot be an empty array' });
    offers.forEach((offer, index) => validateOffer(offer, index, schema, filePath, errors));
  }
  if (schema.isAccessibleForFree === true) {
    const offers = Array.isArray(schema.offers) ? schema.offers : [schema.offers];
    if (!offers.some((offer) => offer && typeof offer === 'object' && (offer.price === 0 || offer.lowPrice === 0))) {
      errors.push({ file: filePath, type: 'Event', field: 'isAccessibleForFree', message: 'isAccessibleForFree=true requires a zero-price offer' });
    }
  }
  return errors;
}
