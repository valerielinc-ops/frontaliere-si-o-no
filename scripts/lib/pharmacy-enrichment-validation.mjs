/**
 * Dependency-free validation for the pharmacy enrichment registry and snapshot.
 *
 * The border-data validator is also imported by the scheduled health monitor,
 * which runs without `npm ci`. Keep this module limited to pure validation so
 * that the monitor does not pull the optional HTML parser into its closure.
 */

export const SOURCE_TYPES = new Set([
  'official',
  'association',
  'pharmacy',
  'verified_partner',
  'directory',
  'google_business_profile',
  'facebook',
]);
export const SOURCE_KINDS = new Set(['html', 'pdf']);
export const FIELDS = new Set(['address', 'phone', 'website', 'openingHours', 'services', 'contactEmail']);

export function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
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
    if (!SOURCE_KINDS.has(source?.kind || 'html')) errors.push(`${source?.id || '<unknown>'}: invalid source kind`);
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
