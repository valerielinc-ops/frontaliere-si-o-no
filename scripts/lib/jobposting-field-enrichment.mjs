import {
  CANTON_CAPITAL_ADDRESSES,
  COMPANY_HQ_ADDRESSES,
  CITY_FALLBACK_ADDRESSES,
  localityMatchesHq,
} from '../../build-plugins/shared/companyHqAddresses.mjs';
import {
  isPlaceholderStreetAddress,
  isSourceStreetAddress,
  resolveSourceDeadline,
} from './jobposting-field-provenance.mjs';

const DAY_MS = 86_400_000;
function sameRegion(left, right) {
  return String(left ?? '').trim().toUpperCase() === String(right ?? '').trim().toUpperCase();
}

function addressCandidateMatches(candidate, locality, region, postalCode) {
  const streetAddress = String(candidate?.streetAddress ?? '').trim();
  if (!streetAddress || isPlaceholderStreetAddress(streetAddress)) return false;
  if (!candidate?.addressLocality || !localityMatchesHq(locality, candidate)) return false;
  if (!sameRegion(candidate.addressRegion, region)) return false;
  const candidatePostal = String(candidate.postalCode ?? '').trim();
  return !(postalCode && candidatePostal && postalCode !== candidatePostal);
}

function companyHq(job) {
  const key = String(job?.companySlug || job?.companyKey || '').trim().toLowerCase();
  return key ? COMPANY_HQ_ADDRESSES[key] : null;
}

function withoutCityCentreLabel(value) {
  return String(value ?? '').trim().replace(
    /\s+(?:city\s+cent(?:re|er)|stadtzentrum|zentrum|centre[-\s]ville|centro)$/i,
    '',
  ).trim();
}

function normalizedAddress(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isGeneratedCityAddress(value, locality, region) {
  const key = normalizedAddress(value);
  if (!key) return false;
  const cityKey = normalizedAddress(locality);
  const cityFallback = Object.values(CITY_FALLBACK_ADDRESSES).find((candidate) => (
    normalizedAddress(candidate.addressLocality) === cityKey
    && sameRegion(candidate.addressRegion, region)
  ));
  const capital = CANTON_CAPITAL_ADDRESSES[String(region ?? '').trim().toUpperCase()];
  return [cityFallback, capital?.addressLocality && normalizedAddress(capital.addressLocality) === cityKey ? capital : null]
    .some((candidate) => candidate && normalizedAddress(candidate.streetAddress) === key);
}

/**
 * Resolve an address without manufacturing a street or civic number. When no
 * street-level evidence exists, preserve the best already-known location and
 * mark it `to-enrich`; the mandatory schema field remains covered while the
 * report keeps this lower-quality case visible.
 * @param {unknown} job
 * @param {{ addressLocality?: string, addressRegion?: string, postalCode?: string }} [context]
 */
export function resolveJobPostingStreetAddress(job, {
  addressLocality,
  addressRegion,
  postalCode = '',
} = {}) {
  const raw = String(job?.streetAddress || job?.address || '').trim();
  const previousSource = String(job?.streetAddressSource ?? '');
  const explicitListingSource = previousSource === 'listing-source';
  const hq = companyHq(job);
  const staleCompanyTier = [
    'curated-company-city',
    'zefix-registry',
    'known-company-address',
    'canton-capital-table',
    'municipality-table',
    'previous-fallback',
  ].includes(previousSource);
  if (isSourceStreetAddress(raw, addressLocality)
      && (explicitListingSource || (!staleCompanyTier && previousSource !== 'to-enrich'))) {
    return { streetAddress: raw, streetAddressSource: 'listing-source' };
  }

  if (hq && addressCandidateMatches(hq, addressLocality, addressRegion, postalCode)) {
    return { streetAddress: hq.streetAddress.trim(), streetAddressSource: 'curated-company-city', address: hq };
  }

  const registered = job?.companyRegisteredAddress;
  if (registered?.source === 'zefix-lindas'
      && addressCandidateMatches(registered, addressLocality, addressRegion, postalCode)) {
    return {
      streetAddress: registered.streetAddress.trim(),
      streetAddressSource: 'zefix-registry',
      address: registered,
    };
  }

  const known = job?.companyKnownAddress;
  if (known && addressCandidateMatches(known, addressLocality, addressRegion, postalCode)) {
    return {
      streetAddress: known.streetAddress.trim(),
      streetAddressSource: 'known-company-address',
      address: known,
    };
  }

  if (raw && !isPlaceholderStreetAddress(raw)
      && previousSource === 'to-enrich'
      && !isGeneratedCityAddress(raw, addressLocality, addressRegion)
      && !/[·•|;]/.test(raw)) {
    return { streetAddress: raw, streetAddressSource: previousSource };
  }

  // Explicit legacy company/city tiers are not listing evidence. Resolve them
  // again from current same-city sources before retaining any weak value.
  const rawIsStaleTier = staleCompanyTier
    || (previousSource === 'to-enrich' && isGeneratedCityAddress(raw, addressLocality, addressRegion));

  // A locality is honest evidence of where the job is, although it is not a
  // street. Keeping it under an explicit low-quality source is preferable to
  // dropping the field or inventing a municipal address.
  const bestLocality = [addressLocality, job?.addressLocality, job?.city, job?.location]
    .map((value) => String(value ?? '').trim())
    .map(withoutCityCentreLabel)
    .find((value) => value && !isPlaceholderStreetAddress(value) && !/[·•|;]/.test(value));
  const bestExisting = raw && !rawIsStaleTier && !isPlaceholderStreetAddress(raw) && !/[·•|;]/.test(raw)
    ? raw
    : '';
  return {
    streetAddress: bestExisting || bestLocality || '',
    streetAddressSource: 'to-enrich',
  };
}

function parseDate(value, now) {
  if (!value) return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime()) || date.getTime() > now.getTime()) return null;
  return date;
}

function latestActiveObservation(job, now) {
  const candidates = [job?.lastObservedAt, job?.lastSeenAt, job?.crawledAt, job?.scrapedAt, job?.updatedAt]
    .map((value) => parseDate(value, now))
    .filter(Boolean)
    .sort((left, right) => right.getTime() - left.getTime());
  if (candidates.length) return candidates[0];
  return parseDate(job?.firstSeenAt, now);
}

function postingAgeDays(job, observedAt) {
  const posted = parseDate(job?.datePosted || job?.postedDate || job?.firstSeenAt, observedAt);
  if (!posted) return 0;
  return Math.max(0, Math.floor((observedAt.getTime() - posted.getTime()) / DAY_MS));
}

function listingTypeCapDays(job) {
  const type = Array.isArray(job?.employmentType)
    ? job.employmentType.join(' ')
    : `${job?.employmentType || ''} ${job?.contract || ''} ${job?.contractType || ''}`;
  if (/temporary|intern|per[-\s]?diem|temporar|interinal|stage|tirocin/i.test(type)) return 45;
  if (/contractor|contract|freelance|mandat|progetto/i.test(type)) return 60;
  return 90;
}

/**
 * Active listing deadline. Plausible source deadlines win; otherwise an
 * observation-based window shrinks with listing age and is extended only when
 * the crawler writes a newer real observation. There is no build-clock floor.
 */
export function resolveActiveJobPostingDeadline(job, now = new Date()) {
  const clock = Number.isFinite(now?.getTime()) ? now : new Date();
  if (job?.validThroughSource === 'archive-evidence') {
    const archived = job.validThrough ? new Date(String(job.validThrough)) : null;
    if (archived && Number.isFinite(archived.getTime())) {
      return { validThrough: archived.toISOString(), validThroughSource: 'archive-evidence' };
    }
  }

  const storedSource = job?.validThroughSource === 'last-observed-window'
    || job?.validThroughSource === 'job-type-cap';
  const explicit = storedSource ? null : resolveSourceDeadline(job?.validThrough, clock);
  const sourceDate = job?.validThrough ? new Date(String(job.validThrough)) : null;
  const dateOnly = typeof job?.validThrough === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(job.validThrough.trim());
  const todayStart = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate());
  const sourceDeadlineStillOpen = sourceDate && Number.isFinite(sourceDate.getTime())
    && (dateOnly ? sourceDate.getTime() >= todayStart : sourceDate.getTime() > clock.getTime());
  if (explicit && sourceDeadlineStillOpen) {
    return { validThrough: explicit, validThroughSource: 'source' };
  }

  const observedAt = latestActiveObservation(job, clock);
  if (observedAt) {
    const capDays = listingTypeCapDays(job);
    const ageDays = postingAgeDays(job, observedAt);
    const windowDays = Math.max(30, capDays - ageDays);
    return {
      validThrough: new Date(observedAt.getTime() + windowDays * DAY_MS).toISOString(),
      validThroughSource: 'last-observed-window',
    };
  }

  // Retain a prior deadline with its provenance when this snapshot has no
  // observation timestamp to improve it. This does not renew it on a build.
  if (storedSource && job?.validThrough) {
    const retained = new Date(String(job.validThrough));
    if (Number.isFinite(retained.getTime())) {
      return {
        validThrough: retained.toISOString(),
        validThroughSource: job.validThroughSource,
      };
    }
  }

  const publicationDate = parseDate(job?.datePosted || job?.postedDate || job?.firstSeenAt, clock);
  if (publicationDate) {
    const capDays = listingTypeCapDays(job);
    return {
      validThrough: new Date(publicationDate.getTime() + capDays * DAY_MS).toISOString(),
      validThroughSource: 'job-type-cap',
    };
  }

  return { validThrough: null, validThroughSource: 'job-type-cap' };
}
