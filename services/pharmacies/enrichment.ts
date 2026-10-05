import {
  pharmacyGoogleMapsUrl,
  safePharmacyUrl,
  type Pharmacy,
  type PharmacyEnrichmentRecord,
  type PharmacyExternalSource,
  type PharmacyFieldSource,
} from './types';

/** Higher-trust sources are allowed to replace a lower-trust optional value. */
export function pharmacySourceRank(sourceType: string | undefined): number {
  switch (sourceType) {
    case 'official': return 60;
    case 'association': return 50;
    case 'pharmacy': return 45;
    case 'verified_partner': return 40;
    case 'google_business_profile': return 30;
    case 'facebook': return 25;
    case 'directory': return 10;
    default: return 0;
  }
}

function hasValue(field: string, value: unknown): boolean {
  if (field === 'openingHours' || field === 'services') return Array.isArray(value) && value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

function sourceForField(pharmacy: Pharmacy, field: string): PharmacyFieldSource | undefined {
  return pharmacy.fieldSources?.[field as keyof NonNullable<Pharmacy['fieldSources']>];
}

function canReplace(pharmacy: Pharmacy, field: string, incoming: PharmacyFieldSource): boolean {
  if (!hasValue(field, pharmacy[field as keyof Pharmacy])) return true;
  const current = sourceForField(pharmacy, field);
  // A value with no field-level provenance belongs to the official catalogue
  // itself and must not be silently replaced by a secondary provider.
  if (!current) return false;
  return pharmacySourceRank(incoming.sourceType) > pharmacySourceRank(current.sourceType);
}

function validExternalSource(source: PharmacyExternalSource): boolean {
  const hasGooglePlaceId = source.sourceType === 'google_business_profile'
    && Boolean(pharmacyGoogleMapsUrl(source.placeId));
  return Boolean(
    safePharmacyUrl(source.url)
      && source.label.trim()
      && Number.isFinite(Date.parse(source.checkedAt))
      && Array.isArray(source.fields)
      && (source.fields.length > 0 || hasGooglePlaceId),
  );
}

/**
 * Merge a separately fetched optional-facts snapshot into an official record.
 * The merge is deterministic and provenance-aware: a directory cannot replace
 * a ministry/municipality value, while an official page can replace an older
 * ODbL directory value for the same field.
 */
export function mergePharmacyEnrichment(
  pharmacy: Pharmacy,
  enrichment: PharmacyEnrichmentRecord | undefined,
): Pharmacy {
  if (!enrichment || typeof enrichment !== 'object') return pharmacy;
  const merged: Pharmacy = {
    ...pharmacy,
    ...(pharmacy.fieldSources ? { fieldSources: { ...pharmacy.fieldSources } } : {}),
    ...(pharmacy.dataAvailability ? { dataAvailability: { ...pharmacy.dataAvailability } } : {}),
    ...(pharmacy.externalSources ? { externalSources: [...pharmacy.externalSources] } : {}),
  };

  const fields = ['phone', 'website', 'openingHours', 'services', 'contactEmail'] as const;
  for (const field of fields) {
    const incomingValue = enrichment[field];
    const incomingSource = enrichment.fieldSources?.[field];
    if (!hasValue(field, incomingValue) || !incomingSource || !validExternalSource({
      url: incomingSource.url,
      label: incomingSource.sourceType,
      sourceType: incomingSource.sourceType,
      checkedAt: incomingSource.checkedAt,
      fields: [field],
    })) continue;
    if (!canReplace(merged, field, incomingSource)) continue;
    if (field === 'website') {
      const website = safePharmacyUrl(incomingValue);
      if (!website) continue;
      merged.website = website;
    } else if (field === 'openingHours' || field === 'services') {
      merged[field] = [...(incomingValue as string[])] as never;
    } else {
      merged[field] = String(incomingValue).trim() as never;
    }
    merged.fieldSources ||= {};
    merged.fieldSources[field] = incomingSource;
    merged.dataAvailability ||= {};
    merged.dataAvailability[field] = 'verified';
  }

  if (pharmacyGoogleMapsUrl(enrichment.googlePlaceId)) {
    merged.googlePlaceId = enrichment.googlePlaceId;
  }

  const sources = (enrichment.externalSources || []).filter(validExternalSource);
  if (sources.length > 0) {
    const byKey = new Map<string, PharmacyExternalSource>();
    for (const source of merged.externalSources || []) byKey.set(`${source.sourceType}|${source.url}`, source);
    for (const source of sources) byKey.set(`${source.sourceType}|${source.url}`, source);
    merged.externalSources = [...byKey.values()].sort((left, right) => left.label.localeCompare(right.label, 'it'));
    const googleSource = sources.find((source) => source.sourceType === 'google_business_profile' && pharmacyGoogleMapsUrl(source.placeId));
    if (googleSource?.placeId) merged.googlePlaceId = googleSource.placeId;
  }

  return merged;
}
