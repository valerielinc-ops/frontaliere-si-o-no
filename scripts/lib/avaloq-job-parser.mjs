import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import {
  inferSwissTargetCanton,
  inferAnyCanton,
  isTargetSwissLocation,
} from './target-swiss-locations.mjs';
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import {
  fetchSmartRecruitersJobs,
  SmartRecruitersApiError,
} from './ats-clients/smartrecruiters-client.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

function htmlToMarkdown(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|h2|h3|h4)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, '\'')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function textWindow(source = '', startLabel = '', endLabels = []) {
  const text = String(source || '');
  const start = text.indexOf(startLabel);
  if (start === -1) return '';
  const afterStart = text.slice(start + startLabel.length);
  let end = afterStart.length;
  for (const label of endLabels) {
    const idx = afterStart.indexOf(label);
    if (idx !== -1 && idx < end) end = idx;
  }
  return normalizeSpace(afterStart.slice(0, end));
}

export function parseAvaloqListingLinks(html = '') {
  // Strategy 1: traditional <a href="/careers/job-openings/ID"> links
  const hrefLinks = [...html.matchAll(/href="(\/(?:de\/)?careers\/job-openings\/[^"]+)"/g)]
    .map((match) => `https://www.avaloq.com${String(match[1] || '').trim()}`)
    .filter((url) => /\/careers\/job-openings\/\d{6,}/.test(url));
  if (hrefLinks.length > 0) return hrefLinks;

  // Strategy 2: SmartRecruiters posting IDs embedded in page (escaped JSON)
  const srIds = [...new Set(
    [...html.matchAll(/smartrecruiters\.com\\?\/v1\\?\/companies\\?\/Avaloq1\\?\/postings\\?\/(7\d{14,17})/g)]
      .map((m) => m[1])
  )];
  if (srIds.length > 0) {
    return srIds.map((id) => `https://www.avaloq.com/careers/job-openings/${id}`);
  }

  return [];
}

const SR_TENANT = 'Avaloq1';

function normalizeCountry(value) {
  if (value && typeof value === 'object') {
    return normalizeSpace(value.code || value.iso || value.name || value.label || '');
  }
  return normalizeSpace(value);
}

function hasRecognizedSourceLocation(posting = {}) {
  const location = posting.location || {};
  const city = normalizeSpace(location.city || '');
  const fullLocation = normalizeSpace(location.fullLocation || '');
  const region = normalizeSpace(location.region || '');
  const country = normalizeCountry(location.country);
  const locationText = [fullLocation, city, region, country].filter(Boolean).join(' ');
  if (!city && !fullLocation) return false;
  // An explicit non-Swiss country code/name is a complete classification even
  // when the vendor does not provide a municipality in our Swiss inventory.
  if (country && !/^(?:ch|che|switzerland|schweiz|suisse|svizzera)$/i.test(country)) return true;
  // Prefer the repository's existing foreign-location classifier so a Swiss
  // city name paired with a foreign country is not misclassified as Swiss.
  if (isLocationExplicitlyForeign(locationText)) return true;
  // A Swiss city/canton is classified only when the location resolver can
  // identify the canton. A bare "Switzerland" or an unknown city is not enough
  // to prove that a target-canton vacancy was not hidden by the filter.
  return Boolean(inferAnyCanton(locationText));
}

/**
 * Fetch all Avaloq job postings from the SmartRecruiters public API via the
 * shared `fetchSmartRecruitersJobs` client.
 *
 * Pipeline (mirrors the legacy in-tree implementation byte-for-byte):
 *   1. Paginated walk of `/v1/companies/Avaloq1/postings` (listing only).
 *   2. Classify every source posting's location before applying the supplied
 *      `locationFilter`; a filtered zero is publishable only after this whole
 *      source walk is proven complete.
 *   3. For each source posting, fetch the full posting via `/v1/postings/{id}`
 *      so `jobAd.sections` is populated (`fetchDetail: true`).
 *   4. Build the local Avaloq detail shape via `buildDetailFromPosting`,
 *      which owns Avaloq's description policy (markdown sections with
 *      "## Qualifiche" / "## Informazioni aggiuntive" headers — different
 *      from the shared client's plain HTML concatenation, hence done locally).
 *
 * @param {number} [timeoutMs=20000] Per-request timeout.
 * @param {(city: string) => boolean} [locationFilter] Filter on `location.city`.
 * @returns {Promise<Array<{
 *   title: string,
 *   description: string,
 *   canonicalUrl: string,
 *   applyUrl: string,
 *   location: string,
 *   postalCode: string,
 *   workArrangement: string,
 *   releasedDate: string,
 * }>>}
 */
export async function fetchAvaloqJobsFromApi(timeoutMs = 20000, locationFilter = () => true) {
  const details = [];
  let sourcePostingCount = 0;
  let classifiedPostingCount = 0;
  let sourceRead = {
    terminationProven: false,
    totalFound: null,
    recordsSeen: 0,
  };
  try {
    const iter = fetchSmartRecruitersJobs(SR_TENANT, {
      // Read the complete source before filtering. Applying the city predicate
      // in the shared client would make a zero indistinguishable from a source
      // read that returned no matching rows.
      filter: () => true,
      // Detail fetch is required: the listing endpoint omits `jobAd.sections`.
      fetchDetail: true,
      detailConcurrency: 5,
      // Page-walk timing: legacy implementation had no inter-page delay.
      // Preserve byte-identical fetch behaviour for the listing walk.
      minDelayMs: 0,
      detailDelayMs: 0,
      timeoutMs,
      onComplete: (outcome) => {
        sourceRead = outcome;
      },
    });

    for await (const normalized of iter) {
      const posting = normalized.rawPosting;
      sourcePostingCount += 1;
      if (!posting || typeof posting !== 'object' || !String(posting.id || '').trim()) {
        throw new Error(`SmartRecruiters returned a degraded Avaloq posting at source row ${sourcePostingCount}`);
      }
      if (!hasRecognizedSourceLocation(posting)) {
        throw new Error(`SmartRecruiters returned an unrecognised Avaloq location at source row ${sourcePostingCount}`);
      }
      classifiedPostingCount += 1;
      details.push(buildDetailFromPosting(posting));
    }
  } catch (err) {
    if (err instanceof SmartRecruitersApiError) {
      // Preserve the legacy "throw on hard failure" contract — caller
      // (update-avaloq-jobs.mjs) propagates and exits non-zero.
      throw new Error(`SmartRecruiters API HTTP ${err.statusCode ?? 'n/a'}: ${err.message}`);
    }
    throw err;
  }
  const targetDetails = details.filter((detail) => locationFilter(
    Reflect.get(detail, 'avaloqSourceLocation') || detail.location,
  ));
  Object.defineProperties(targetDetails, {
    avaloqSourceSnapshot: { value: 'authoritative-api-snapshot', enumerable: false },
    avaloqSourceReadComplete: {
      value: sourceRead.terminationProven === true
        && (!Number.isFinite(sourceRead.totalFound) || sourceRead.recordsSeen >= sourceRead.totalFound),
      enumerable: false,
    },
    avaloqSourceTerminationProven: { value: sourceRead.terminationProven === true, enumerable: false },
    avaloqSourceTotalFound: { value: sourceRead.totalFound, enumerable: false },
    avaloqSourceRecordsSeen: { value: sourceRead.recordsSeen, enumerable: false },
    avaloqSourcePostingCount: { value: sourcePostingCount, enumerable: false },
    avaloqClassifiedPostingCount: { value: classifiedPostingCount, enumerable: false },
  });
  return targetDetails;
}

/**
 * Verify the single source-evidence predicate used before publishing an
 * Avaloq filtered result, including a legitimate zero target result.
 *
 * @param {object[]|undefined|null} details
 * @returns {true}
 */
export function assertCompleteAvaloqSnapshot(details) {
  const sourcePostingCount = Array.isArray(details)
    ? Number(Reflect.get(details, 'avaloqSourcePostingCount'))
    : Number.NaN;
  const classifiedPostingCount = Array.isArray(details)
    ? Number(Reflect.get(details, 'avaloqClassifiedPostingCount'))
    : Number.NaN;
  const totalFound = Array.isArray(details)
    ? Reflect.get(details, 'avaloqSourceTotalFound')
    : null;
  const sourceRecordsSeen = Array.isArray(details)
    ? Number(Reflect.get(details, 'avaloqSourceRecordsSeen'))
    : Number.NaN;
  const sourceReadComplete = Array.isArray(details)
    && Reflect.get(details, 'avaloqSourceReadComplete') === true;
  const sourceSnapshot = Array.isArray(details)
    && Reflect.get(details, 'avaloqSourceSnapshot') === 'authoritative-api-snapshot';
  if (
    !sourceSnapshot
    || !sourceReadComplete
    || Reflect.get(details, 'avaloqSourceTerminationProven') !== true
    || !Number.isInteger(sourcePostingCount)
    || sourcePostingCount !== classifiedPostingCount
    || sourcePostingCount !== sourceRecordsSeen
    || (Number.isFinite(totalFound) && sourcePostingCount < totalFound)
  ) {
    throw new Error(
      'Avaloq result is not an authoritative source snapshot: '
      + 'the complete source read and location classification are not proven',
    );
  }
  return true;
}

function buildDetailFromPosting(posting) {
  const loc = posting.location || {};
  const city = normalizeSpace(loc.city || '');
  const sourceLocation = normalizeSpace(
    [loc.fullLocation, city, normalizeSpace(loc.region || ''), normalizeCountry(loc.country)]
      .filter(Boolean)
      .join(', '),
  );
  const sections = [];
  const jobDesc = (posting.jobAd?.sections?.jobDescription?.text || '').trim();
  const qualif = (posting.jobAd?.sections?.qualifications?.text || '').trim();
  const addInfo = (posting.jobAd?.sections?.additionalInformation?.text || '').trim();
  if (jobDesc) sections.push(htmlToMarkdown(jobDesc));
  if (qualif) sections.push(`## Qualifiche\n\n${htmlToMarkdown(qualif)}`);
  if (addInfo) sections.push(`## Informazioni aggiuntive\n\n${htmlToMarkdown(addInfo)}`);
  const description = sections.join('\n\n').trim() || normalizeSpace(posting.name || '');
  const detail = {
    title: normalizeSpace(posting.name || ''),
    description,
    canonicalUrl: `https://www.avaloq.com/careers/job-openings/${posting.id}`,
    applyUrl: posting.applyUrl || `https://jobs.smartrecruiters.com/Avaloq1/${posting.id}`,
    location: city,
    postalCode: normalizeSpace(loc.postalCode || ''),
    workArrangement: posting.typeOfEmployment?.label || '',
    releasedDate: posting.releasedDate || '',
  };
  Object.defineProperty(detail, 'avaloqSourceLocation', {
    value: sourceLocation,
    enumerable: false,
  });
  return detail;
}

export function parseAvaloqJobDetail(html = '', url = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const title =
    normalizeSpace(document.querySelector('h1')?.textContent || '') ||
    normalizeSpace(document.querySelector('title')?.textContent || '');

  const text = document.body.textContent.replace(/\s+/g, ' ');
  const locationBlock = textWindow(text, 'Location', ['Work arrangement', 'Apply']);
  const workArrangement = textWindow(text, 'Work arrangement', ['Apply']);
  const role = textWindow(text, 'A bit about the role', ['Your key tasks', 'A bit about you', 'Additional information']);
  const tasks = textWindow(text, 'Your key tasks', ['A bit about you', 'Additional information']);
  const profile = textWindow(text, 'A bit about you', ['It would be a real bonus if you have', 'Additional information']);
  const bonus = textWindow(text, 'It would be a real bonus if you have', ['Additional information']);
  const extra = textWindow(text, 'Additional information', ['Apply', 'See jobs']);

  const locationLines = locationBlock
    .split(/\s{2,}|(?<=Switzerland)\s+/)
    .map((line) => normalizeSpace(line))
    .filter(Boolean);
  const joinedLocation = normalizeSpace(locationLines.join(', '));
  const cityMatch = joinedLocation.match(/\b(\d{4})\s+([A-Za-zÀ-ÿ' -]+),?\s*Switzerland\b/i)
    || joinedLocation.match(/\b([A-Za-zÀ-ÿ' -]+),?\s*Switzerland\b/i);
  const city = normalizeSpace(cityMatch?.[2] || cityMatch?.[1] || '');
  const postalCode = normalizeSpace(joinedLocation.match(/\b(\d{4})\b/)?.[1] || '');
  const applyUrl =
    document.querySelector('a[href*="jobs.smartrecruiters.com"]')?.href
    || '';

  const sections = [];
  if (role) sections.push(`## Il ruolo\n\n${role}`);
  if (tasks) sections.push(`## Le tue responsabilita\n\n${tasks}`);
  if (profile) sections.push(`## Il tuo profilo\n\n${profile}`);
  if (bonus) sections.push(`## Plus graditi\n\n${bonus}`);
  if (extra) sections.push(`## Informazioni aggiuntive\n\n${extra}`);

  return {
    title,
    canonicalUrl: url || document.querySelector('link[rel="canonical"]')?.href || '',
    applyUrl,
    location: city,
    postalCode,
    workArrangement,
    description: sections.join('\n\n').trim(),
  };
}

export function isAvaloqTargetLocation(raw = '') {
  return !isLocationExplicitlyForeign(raw)
    && isTargetSwissLocation(raw, { includeGrigioni: true });
}

export function inferAvaloqCanton(raw = '') {
  // No Ticino default — Avaloq is Zürich-based and hires nationally; leave blank
  // when unresolved so the downstream hardening derives the canton.
  return inferAnyCanton(raw) || '';
}

export function buildAvaloqLocalizedContent(detail = {}, companyName = 'Avaloq') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Bioggio';
  const description = String(detail.description || '').trim();
  return {
    titleByLocale: { it: title },
    descriptionByLocale: { it: description },
    slugByLocale: { it: slugify(`${title} ${companyName} ${location}`) },
  };
}
