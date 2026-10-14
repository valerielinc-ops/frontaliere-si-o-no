/**
 * Source-backed country gate for Recruitee locations.
 *
 * Recruitee exposes the location country separately from the employer's HQ.
 * Dedicated Swiss feeds must use that location evidence: an employer being
 * registered in Switzerland is not evidence that a remote worldwide offer is
 * a Swiss posting.
 */
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { isSwissLocationText } from './target-swiss-locations.mjs';

const SWISS_COUNTRY_CODES = new Set(['ch', 'che']);
const SWISS_COUNTRY_NAMES = new Set([
  'schweiz',
  'switzerland',
  'suisse',
  'svizzera',
]);
export const RECRUITEE_COUNTRY_SNAPSHOT_PROPERTY = 'recruiteeCountrySnapshot';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function locationText(location) {
  return [
    location?.name,
    location?.city,
    location?.state,
    location?.country,
    location?.country_code,
    location?.countryCode,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Return true only for a concrete Recruitee location with Swiss evidence.
 * Missing/ambiguous country data is deliberately rejected.
 */
export function isSwissRecruiteeLocation(location = {}) {
  const city = String(location?.city || '').trim();
  if (!city) return false;

  const text = locationText(location);
  if (!text || isLocationExplicitlyForeign(text)) return false;

  const countryCode = normalize(location?.country_code || location?.countryCode);
  if (countryCode) return SWISS_COUNTRY_CODES.has(countryCode);

  const country = normalize(location?.country);
  if (country) return SWISS_COUNTRY_NAMES.has(country);

  // A country-less source row is accepted only when its own location text is
  // a known Swiss locality/canton; an unresolved remote row stays quarantined.
  return isSwissLocationText(text);
}

/**
 * Select the first Swiss location from a Recruitee offer.
 * Returning the source object preserves its city/state/postal evidence for the
 * caller; foreign-only and unresolved offers return null.
 */
export function findSwissRecruiteeLocation(locations) {
  return (Array.isArray(locations) ? locations : []).find(isSwissRecruiteeLocation) || null;
}

export function hasOnlyExplicitlyForeignRecruiteeLocations(locations) {
  return Array.isArray(locations)
    && locations.length > 0
    && locations.every((location) => {
      const text = locationText(location);
      return Boolean(text) && isLocationExplicitlyForeign(text);
    });
}

function recruiteeDetailPath(rawUrl) {
  try {
    const segments = new URL(String(rawUrl || '')).pathname.split('/').filter(Boolean);
    return segments.length === 2 && segments[0] === 'o' ? '/o/' + segments[1] : '';
  } catch {
    return '';
  }
}

export function attachRecruiteeCountrySnapshot(jobs, {
  complete = false,
  offerCount = 0,
  acceptedOfferCount = 0,
  rejectedOfferCount = 0,
  unclassifiedOfferCount = 0,
  rejectedDetailUrls = [],
  unclassifiedDetailUrls = [],
  acceptedDetailUrls = [],
} = {}) {
  const acceptedPaths = new Set(acceptedDetailUrls.map(recruiteeDetailPath).filter(Boolean));
  const rejectedDetailPaths = [...new Set(
    rejectedDetailUrls.map(recruiteeDetailPath).filter(Boolean),
  )];
  const unclassifiedDetailPaths = [...new Set(
    unclassifiedDetailUrls.map(recruiteeDetailPath).filter(Boolean),
  )];
  const quarantinedDetailPaths = rejectedDetailPaths
    .filter((detailPath) => !acceptedPaths.has(detailPath));

  Object.defineProperty(jobs, RECRUITEE_COUNTRY_SNAPSHOT_PROPERTY, {
    enumerable: false,
    value: Object.freeze({
      complete: complete === true,
      offerCount,
      acceptedOfferCount,
      rejectedOfferCount,
      unclassifiedOfferCount,
      rejectedDetailPaths: Object.freeze(rejectedDetailPaths),
      unclassifiedDetailPaths: Object.freeze(unclassifiedDetailPaths),
      quarantinedDetailPaths: Object.freeze(quarantinedDetailPaths),
    }),
  });
  return jobs;
}

export function filterStoredRecruiteeJobs(jobs, snapshot, companyKey) {
  if (!Array.isArray(jobs) || snapshot?.complete !== true) return jobs;
  const quarantinedPaths = new Set(snapshot.quarantinedDetailPaths || snapshot.rejectedDetailPaths || []);
  if (quarantinedPaths.size === 0) return jobs;

  return jobs.filter((job) => (
    String(job?.companyKey || '') !== companyKey
    || !quarantinedPaths.has(recruiteeDetailPath(job?.url))
  ));
}

export function validateRecruiteeSwissEmptySnapshot(jobs, partialVerdict) {
  const snapshot = jobs?.[RECRUITEE_COUNTRY_SNAPSHOT_PROPERTY];
  if (
    !Array.isArray(jobs)
    || snapshot?.complete !== true
    || snapshot.unclassifiedOfferCount !== 0
    || snapshot.rejectedOfferCount <= 0
    || snapshot.offerCount !== snapshot.acceptedOfferCount + snapshot.rejectedOfferCount
  ) {
    return partialVerdict;
  }
  return jobs.length === 0 && snapshot.acceptedOfferCount === 0;
}

export function createRecruiteeCountryRefreshHooks(fetchJobs, companyKey, partialVerdict) {
  let sourceCountrySnapshot = null;

  return {
    fetchJobs: async () => {
      sourceCountrySnapshot = null;
      const jobs = await fetchJobs();
      sourceCountrySnapshot = jobs?.[RECRUITEE_COUNTRY_SNAPSHOT_PROPERTY] || null;
      return jobs;
    },
    prepareExistingJobs: (jobs) => filterStoredRecruiteeJobs(
      jobs,
      sourceCountrySnapshot,
      companyKey,
    ),
    validateAuthoritativeSnapshot: (jobs) => validateRecruiteeSwissEmptySnapshot(
      jobs,
      partialVerdict,
    ),
  };
}
