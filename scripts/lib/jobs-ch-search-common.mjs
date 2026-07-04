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
 * @returns {Promise<object[]>} raw `documents[]` entries
 */
export async function fetchJobsChCompanyListings({ companyIds, rows = 100 }) {
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    throw new Error('fetchJobsChCompanyListings: companyIds required');
  }

  const documents = [];
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
    documents.push(...pageDocs);
    numPages = Number(data?.numPages) || 1;
    page += 1;
  } while (page <= numPages);

  return documents;
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
