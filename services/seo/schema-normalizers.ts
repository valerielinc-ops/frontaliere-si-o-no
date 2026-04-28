import { TYPES_ACCEPT_IN_LANGUAGE } from '../seoService';

const DEFAULT_DATASET_LICENSE = 'https://creativecommons.org/licenses/by-nc/4.0/';
const DEFAULT_APP_CATEGORY = 'FinanceApplication';
const DEFAULT_OPERATING_SYSTEM = 'Web';
const DEFAULT_OFFER = {
 '@type': 'Offer',
 price: '0',
 priceCurrency: 'CHF',
} as const;

function normalizeOffer(value: unknown): Record<string, any> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) {
  return { ...DEFAULT_OFFER };
 }

 const offer = { ...(value as Record<string, any>) };
 if (!offer['@type']) offer['@type'] = 'Offer';
 if (offer.price === undefined || offer.price === null || offer.price === '') {
  offer.price = DEFAULT_OFFER.price;
 }
 if (!offer.priceCurrency) {
  offer.priceCurrency = DEFAULT_OFFER.priceCurrency;
 }
 return offer;
}

function isSchemaType(record: Record<string, any>, expected: string): boolean {
 const typeValue = record['@type'];
 if (typeValue === expected) return true;
 return Array.isArray(typeValue) && typeValue.includes(expected);
}

function isAppSchema(record: Record<string, any>): boolean {
 return isSchemaType(record, 'WebApplication') || isSchemaType(record, 'SoftwareApplication');
}

function normalizeSchemaObject(record: Record<string, any>): Record<string, any> {
 if (isSchemaType(record, 'Dataset') && !record.license) {
  record.license = DEFAULT_DATASET_LICENSE;
 }

 if (isAppSchema(record)) {
  if (!record.applicationCategory) {
   record.applicationCategory = DEFAULT_APP_CATEGORY;
  }
  if (
   !record.operatingSystem ||
   record.operatingSystem === 'Web Browser' ||
   record.operatingSystem === 'All'
  ) {
   record.operatingSystem = DEFAULT_OPERATING_SYSTEM;
  }
  record.offers = normalizeOffer(record.offers);
  if (record.isAccessibleForFree === undefined && String(record.offers.price) === '0') {
   record.isAccessibleForFree = true;
  }
  if ('speakable' in record) {
   delete record.speakable;
  }
 }

 if (record.inLanguage !== undefined) {
  const typeValue = record['@type'];
  const primaryType = Array.isArray(typeValue) ? typeValue[0] : typeValue;
  if (typeof primaryType === 'string' && !TYPES_ACCEPT_IN_LANGUAGE.has(primaryType)) {
   delete record.inLanguage;
  }
 }

 return record;
}

export function normalizeStructuredData<T>(value: T): T {
 if (Array.isArray(value)) {
  return value.map((item) => normalizeStructuredData(item)) as T;
 }
 if (!value || typeof value !== 'object') {
  return value;
 }

 const cloned: Record<string, any> = {};
 for (const [key, nested] of Object.entries(value as Record<string, any>)) {
  cloned[key] = normalizeStructuredData(nested);
 }
 return normalizeSchemaObject(cloned) as T;
}
