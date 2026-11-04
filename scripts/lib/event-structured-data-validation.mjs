import { normalizeSchemaOrgDateTime, normalizeSchemaOrgItemAvailability } from './schema-org-values.mjs';

const EVENT_STATUSES = new Set([
  'EventCancelled',
  'EventPostponed',
  'EventRescheduled',
  'EventScheduled',
]);
const ATTENDANCE_MODES = new Set([
  'OfflineEventAttendanceMode',
  'OnlineEventAttendanceMode',
  'MixedEventAttendanceMode',
]);
function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function schemaTypeName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().split(/[\/#]/u).pop() || '';
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

  if (!isNonEmpty(schema.name)) {
    errors.push({ file: filePath, type: 'Event', field: 'name', message: 'Event missing "name"' });
  }
  if (!isValidDate(schema.startDate)) {
    errors.push({ file: filePath, type: 'Event', field: 'startDate', message: 'Event requires a valid ISO "startDate"' });
  }
  if (schema.endDate !== undefined && !isValidDate(schema.endDate)) {
    errors.push({ file: filePath, type: 'Event', field: 'endDate', message: 'Event "endDate" must be an ISO date or date-time when present' });
  }
  if (schema.description !== undefined && String(schema.description || '').trim().length < 30) {
    const length = String(schema.description || '').trim().length;
    errors.push({ file: filePath, type: 'Event', field: 'description', message: `Event description too short (${length} chars, need >= 30)` });
  }

  const location = schema.location;
  if (!location || typeof location !== 'object' || Array.isArray(location)) {
    errors.push({ file: filePath, type: 'Event', field: 'location', message: 'Event missing "location"' });
  } else {
    if (schemaTypeName(location['@type']) !== 'Place') {
      errors.push({ file: filePath, type: 'Event', field: 'location.@type', message: 'Event location must use Place' });
    }
    if (!isNonEmpty(location.name)) {
      errors.push({ file: filePath, type: 'Event', field: 'location.name', message: 'Event missing "location.name"' });
    }
    const address = location.address;
    if (!address || typeof address !== 'object' || Array.isArray(address)) {
      errors.push({ file: filePath, type: 'Event', field: 'location.address', message: 'Event missing "location.address"' });
    } else {
      if (schemaTypeName(address['@type']) !== 'PostalAddress') {
        errors.push({ file: filePath, type: 'Event', field: 'location.address.@type', message: 'Event location.address must use PostalAddress' });
      }
      if (![address.streetAddress, address.addressLocality, address.postalCode].some(isNonEmpty)) {
        errors.push({ file: filePath, type: 'Event', field: 'location.address', message: 'Event location.address needs a street, locality, or postal code' });
      }
    }
  }

  if (schema.eventStatus !== undefined && !EVENT_STATUSES.has(schemaTypeName(schema.eventStatus))) {
    errors.push({ file: filePath, type: 'Event', field: 'eventStatus', message: 'Event "eventStatus" is not a supported status' });
  }
  if (schema.eventAttendanceMode !== undefined && !ATTENDANCE_MODES.has(schemaTypeName(schema.eventAttendanceMode))) {
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
