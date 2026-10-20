#!/usr/bin/env node
/**
 * Shared jobs.ch public search/listing client.
 *
 * jobs.ch (and jobup.ch) are both operated by JobCloud AG. Company career
 * pages on jobs.ch use an undocumented but public, unauthenticated REST API
 * to list a company's own postings:
 *
 *   https://job-search-api.jobs.ch/search
 *     ?companyIds={id}[&companyIds={id2}...]
 *     &page={n}&rows={n}
 *     &publishedOn=SEARCH&publishedOn=SEARCH_COMPANY_PROFILE
 *
 * Discovered live via Playwright network interception on a company profile
 * page (clicking "Show more"). Returns clean JSON:
 *   { documents: [...], totalHits, numPages, currentPage, rows }
 *
 * Each `documents[]` entry carries an accurate `locations[]` array
 * (cantonCode, city, street, zipCode) — more reliable than the per-job
 * detail page's JSON-LD address block (see below).
 *
 * Per-job detail pages expose a schema.org/JobPosting JSON-LD block with
 * full description/employmentType/hiringOrganization/datePosted, at:
 *   https://www.jobs.ch/en/vacancies/detail/{uuid}/
 *
 * The `/en/` locale prefix reliably resolves (200) regardless of the
 * posting's actual authored language (confirmed for German- and
 * Italian-language postings) — content is served in the original posting
 * language, the prefix only affects jobs.ch chrome/UI, not detail JSON-LD.
 *
 * Quirk: the JSON-LD `jobLocation.address.addressRegion` field holds the
 * CITY name (not the canton), and `addressLocality` is typically absent.
 * Prefer the listing API's `locations[0]` for city/canton/postal/street;
 * use JSON-LD primarily for title/description/hiringOrganization/
 * employmentType/datePosted.
 */
import { fetchJson, fetchHtml } from './crawler-template.mjs';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';

const SEARCH_API = 'https://job-search-api.jobs.ch/search';

/**
 * Build the jobs.ch detail page URL for a given job id.
 * @param {string} id
 * @param {string} [locale]
 * @returns {string}
 */
export function jobsChDetailUrl(id, locale = 'en') {
  return `https://www.jobs.ch/${locale}/vacancies/detail/${id}/`;
}

/**
 * Fetch all active listings for one or more jobs.ch company profile ids.
 * Paginates through `numPages` automatically.
 *
 * @param {object} opts
 * @param {string[]} opts.companyIds
 * @param {number} [opts.rows]
 * @returns {Promise<object[]>} raw `documents[]` entries, carrying a
 *   non-enumerable `searchEvidence` with what the API itself declared on the
 *   first page (`totalHits`, `numPages`, raw values, never coerced) — the input
 *   of `jobsChAuthoritativeEmptyOrNull`.
 */
export async function fetchJobsChCompanyListings({ companyIds, rows = 100 }) {
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    throw new Error('fetchJobsChCompanyListings: companyIds required');
  }

  const documents = [];
  const evidence = {
    companyIds: [...companyIds],
    pagesFetched: 0,
    declaredTotalHits: undefined,
    declaredNumPages: undefined,
  };
  // The API is 1-indexed: page=0 is rejected with HTTP 422
  // ("Number must be greater than or equal to 1", confirmed live).
  let page = 1;
  let numPages = 1;

  do {
    const params = new URLSearchParams();
    for (const id of companyIds) params.append('companyIds', id);
    params.append('page', String(page));
    params.append('rows', String(rows));
    params.append('publishedOn', 'SEARCH');
    params.append('publishedOn', 'SEARCH_COMPANY_PROFILE');

    const url = `${SEARCH_API}?${params.toString()}`;
    const data = await fetchJson(url, { label: 'jobs.ch search API' });

    const pageDocs = Array.isArray(data?.documents) ? data.documents : [];
    if (evidence.pagesFetched === 0) {
      evidence.declaredTotalHits = data?.totalHits;
      evidence.declaredNumPages = data?.numPages;
      evidence.firstPageHadDocumentsArray = Array.isArray(data?.documents);
    }
    evidence.pagesFetched += 1;
    documents.push(...pageDocs);
    numPages = Number(data?.numPages) || 1;
    page += 1;
  } while (page <= numPages);

  Object.defineProperty(documents, 'searchEvidence', { value: evidence, enumerable: false });
  return documents;
}

/**
 * Turn an empty jobs.ch company search into a source-proven zero, or into
 * nothing at all (issue #11653, city-pop).
 *
 * The search API answers every company query with its own count. A company
 * with no open postings returns `{documents: [], totalHits: 0, numPages: 0}`
 * (measured live 2026-10-05 for City Pop). That declared zero is the proof:
 * the crawler did reach the source and the source said "nothing". Without it,
 * `[]` is ambiguous — the same value comes out of a company with no postings
 * and out of a response whose shape we no longer understand — and the health
 * monitor files `[crawler-health] … broken` for a healthy employer.
 *
 * The proof is granted only when ALL of these hold for the same run:
 *   - the API was actually read (`searchEvidence` present, one page fetched);
 *   - `totalHits` is the number 0 and `numPages` is the number 0 (raw values:
 *     a missing or renamed field is NOT a zero);
 *   - the first page carried a `documents` array and no document came back.
 * Anything else (e.g. `totalHits > 0` with no documents, or listings that the
 * parser later filters out) returns null: the caller returns a bare `[]`, the
 * pipeline keeps the previous slice and the monitor keeps complaining.
 *
 * @param {object[]|null|undefined} listings result of `fetchJobsChCompanyListings`
 * @param {string} label company label, for the log line
 * @returns {object[]|null} a stamped empty batch to return AS IS, or null
 */
export function jobsChAuthoritativeEmptyOrNull(listings, label) {
  const evidence = Reflect.get(listings || [], 'searchEvidence');
  const proven = Array.isArray(listings)
    && listings.length === 0
    && evidence
    && evidence.pagesFetched >= 1
    && evidence.firstPageHadDocumentsArray === true
    && evidence.declaredTotalHits === 0
    && evidence.declaredNumPages === 0;
  if (!proven) {
    console.warn(
      `  ⚠️ ${label}: jobs.ch search did not declare an empty company`
      + ` (rows=${Array.isArray(listings) ? listings.length : 'n/a'},`
      + ` totalHits=${JSON.stringify(evidence?.declaredTotalHits)},`
      + ` numPages=${JSON.stringify(evidence?.declaredNumPages)}). Keeping existing jobs.`,
    );
    return null;
  }
  const ids = evidence.companyIds.join(',');
  console.log(`  🧩 Source-proven zero: jobs.ch search API declares totalHits=0 for ${label}`);
  return markAuthoritativeEmptySnapshot(
    [],
    `jobs.ch search API declares totalHits=0, numPages=0 for companyIds=${ids}`,
  );
}

/**
 * Fetch a single job's detail page and extract its schema.org/JobPosting
 * JSON-LD block. Returns null if the page or the LD block can't be found.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {string} [opts.locale]
 * @returns {Promise<{ld: object|null, html: string}>}
 */
export async function fetchJobsChJobPostingLd(id, { locale = 'en' } = {}) {
  const url = jobsChDetailUrl(id, locale);
  const html = await fetchHtml(url, { label: 'jobs.ch detail page' });
  const ld = extractJobPostingLd(html);
  return { ld, html, url };
}
