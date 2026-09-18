#!/usr/bin/env node
/**
 * Concordia (CONCORDIA Schweizerische Kranken- und Unfallversicherung AG) job
 * parser — jobs.concordia.ch board.
 *
 * Live source: https://jobs.concordia.ch/  — a Prospective.ch (Aequivital AG)
 * "careercenter" tenant (id 1000725) served directly on the corporate
 * subdomain, server-rendered HTML with GET-based pagination:
 *
 *   https://jobs.concordia.ch/?offset={N}&limit={L}&lang=de
 *
 * Unlike the `medium`-scoped Prospective tenants covered by
 * `prospective-ch-job-parser-common.mjs`, this tenant's JSON listing API
 * (`ohws.prospective.ch/public/v1/medium/1000725/jobs`) returns HTTP 400 —
 * verified live 2026-07-03. There is no working JSON endpoint for this
 * tenant, so the shared Prospective factory does not apply here; this parser
 * scrapes the rendered listing HTML instead, same as `spital-zofingen-job-parser.mjs`.
 *
 * Listing cards link to
 *   https://jobs.concordia.ch/offene-stellen/{slug}/{uuid}
 * detail pages, each carrying a clean schema.org/JobPosting JSON-LD block
 * (title, description, jobLocation w/ postalCode + streetAddress +
 * addressRegion, employmentType, datePosted, hiringOrganization.name =
 * "Concordia"). Reuses the shared `jsonld-jobposting.mjs` extractor — same
 * pattern as Spital Zofingen.
 *
 * Concordia is a NATIONAL Swiss health/accident insurer (cassa malati),
 * headquartered in Lucerne, with agencies across all 26 cantons — jobs are
 * NOT limited to a single canton, so canton inference must cover the whole
 * country (`inferAnyCanton`), not just the border-canton `TARGET_CANTONS`
 * subset. `addressRegion` and the locality are resolved with the shared
 * all-canton inference helper, regardless of the vacancy's source language.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { fetchHtml } from './hospital-custom-html-helpers.mjs';
import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';
import { extractJobPostingLd, jobPostingDescriptionText, jobPostingAddress } from './jsonld-jobposting.mjs';
import { resolveFallbackAddress } from '../../build-plugins/shared/companyHqAddresses.ts';

export const CONCORDIA_KEY = 'concordia';
export const CONCORDIA_COMPANY_NAME = 'Concordia';
export const CONCORDIA_COMPANY_DOMAIN = 'concordia.ch';

const BOARD_HOST = 'jobs.concordia.ch';
const LISTING_URL = `https://${BOARD_HOST}/`;
const CAREER_URL = 'https://www.concordia.ch/de/ueber-uns/jobs/offene-stellen.html';
const PAGE_SIZE = 100;
// The declared source total is the normal stop condition. This finite ceiling
// is only a runaway guard when the board omits or misreports its total; it is
// deliberately far above the current national board size and fails loudly.
const MAX_PAGES = 1000;
const POLITE_DELAY_MS = 200;

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function resolveCanton(addressRegion = '', addressLocality = '') {
  return inferAnyCanton(addressRegion) || inferAnyCanton(addressLocality) || '';
}

export function resolveConcordiaAddress(address = {}, location = '', canton = '') {
  const fallbackAddress = resolveFallbackAddress(CONCORDIA_KEY, location, canton);
  const sourcePostalCode = normalizeSpace(address?.postalCode || '');
  return {
    postalCode: /^\d{4}$/.test(sourcePostalCode)
      ? sourcePostalCode
      : fallbackAddress.postalCode,
    streetAddress: normalizeSpace(address?.streetAddress || '') || fallbackAddress.streetAddress,
  };
}

/** Insurance/national-employer-scoped role category detector. */
export function detectCategory(title = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/\b(lernende|lehrstelle|apprenti|stagiaire|praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ]))/.test(t)) return 'Formazione';
  if (/\b(it|informatik|software|develop|engineer|architect)/.test(t)) return 'IT';
  if (/\b(agenturleiter|verkauf|vertrieb|sales|kund|client|underwriting)/.test(t)) return 'Commerciale';
  if (/\b(recht|jurist|legal|compliance)/.test(t)) return 'Legale';
  if (/\b(finanz|finance|actuair|aktuar|controll|buchhalt)/.test(t)) return 'Finanza';
  if (/\b(hr|human|personal|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|marketing)/.test(t)) return 'Marketing';
  if (/\b(admin|sekret|sachbearbeiter|dialogmarketing|assistent)/.test(t)) return 'Amministrazione';
  return 'Assicurazioni';
}

export function detectExperienceLevel(title = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/\b(lernende|lehrstelle|apprenti|stagiaire|praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ]))/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|leiter|leitend|head|director|chef|verantwort)/.test(t)) return 'senior';
  return 'mid';
}

export function isConcordiaJob(job) {
  if (!job) return false;
  const key = normalizeSpace(job?.companyKey || '').toLowerCase();
  const company = normalizeSpace(job?.company || '').toLowerCase();
  const url = normalizeSpace(job?.url || '').toLowerCase();
  return key === CONCORDIA_KEY
    || company === 'concordia'
    || url.includes(BOARD_HOST);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === BOARD_HOST
      || host === CONCORDIA_COMPANY_DOMAIN
      || host.endsWith(`.${CONCORDIA_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

/** Extract unique detail URLs from a listing page. */
export function parseConcordiaListing(html) {
  const seen = new Set();
  const out = [];
  const rx = /href="((?:https?:\/\/jobs\.concordia\.ch)?\/offene-stellen\/[^"/]+\/[^"/]+\/?)"/gi;
  let m;
  while ((m = rx.exec(html))) {
    const raw = m[1];
    const url = raw.startsWith('http') ? raw : `https://${BOARD_HOST}${raw}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Read the total declared by the source board, when its listing page exposes it. */
export function parseConcordiaListingTotal(html = '') {
  const normalizedHtml = String(html || '')
    .replace(/&(nbsp|#160|#xA0|thinsp|#8239|#x202F);/gi, ' ');
  const match = normalizedHtml.match(
    /<([a-z][\w:-]*)\b[^>]*\bclass=["'][^"']*\btotal-jobs\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
  );
  if (!match) return null;
  const text = match[2].replace(/<[^>]+>/g, ' ');
  const numberMatch = text.match(/[\d][\d\s.,'’\u00a0]*/);
  if (!numberMatch) return null;
  const total = Number(numberMatch[0].replace(/[^\d]/g, ''));
  return Number.isInteger(total) ? total : null;
}

/** Fetch every listing page (offset-paginated) and return the union of detail URLs. */
export async function fetchConcordiaListingUrls({
  fetchPage = fetchHtml,
  maxPages = MAX_PAGES,
  delayMs = POLITE_DELAY_MS,
} = {}) {
  const seen = new Set();
  const out = [];
  let offset = 0;
  let expectedTotal = null;
  let pagesRead = 0;
  const pageLimit = Number.isInteger(maxPages) && maxPages > 0 ? maxPages : MAX_PAGES;
  while (true) {
    const pageUrl = `${LISTING_URL}?offset=${offset}&limit=${PAGE_SIZE}&lang=de`;
    const html = await fetchPage(pageUrl);
    pagesRead += 1;
    const declaredTotal = parseConcordiaListingTotal(html);
    if (declaredTotal !== null) {
      if (expectedTotal !== null && declaredTotal !== expectedTotal) {
        throw new Error(
          `Concordia listing total changed during pagination: ${expectedTotal} → ${declaredTotal} at offset=${offset}`,
        );
      }
      expectedTotal = declaredTotal;
    }
    const urls = parseConcordiaListing(html);
    let added = 0;
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      added += 1;
    }
    if (expectedTotal !== null && out.length > expectedTotal) {
      throw new Error(
        `Concordia listing pagination exceeded declared total: source=${expectedTotal}, read=${out.length}`,
      );
    }
    if (urls.length === 0) {
      if (expectedTotal !== null && out.length < expectedTotal) {
        throw new Error(
          `Concordia listing pagination incomplete: source declares ${expectedTotal} jobs, read ${out.length}`,
        );
      }
      break;
    }
    if (added === 0) {
      throw new Error(
        `Concordia listing pagination did not advance at offset=${offset}; source repeated a page and read ${out.length} unique URLs`,
      );
    }
    if (expectedTotal !== null && out.length >= expectedTotal) break;
    if (urls.length < PAGE_SIZE) {
      if (expectedTotal !== null && out.length < expectedTotal) {
        throw new Error(
          `Concordia listing pagination incomplete: source declares ${expectedTotal} jobs, read ${out.length}`,
        );
      }
      break;
    }
    if (pagesRead >= pageLimit) {
      throw new Error(
        `Concordia listing pagination exhausted safety bound (${pageLimit} pages) without reaching the source total/end marker`,
      );
    }
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (expectedTotal !== null) {
    console.log(`  ✓ board declares ${expectedTotal} jobs; read ${out.length} listing URLs`);
  } else {
    console.log(`  ✓ board has no declared total; read ${out.length} listing URLs until pagination end`);
  }
  return out;
}

export async function fetchAllConcordiaJobs({
  fetchPage = fetchHtml,
  maxPages = MAX_PAGES,
  delayMs = POLITE_DELAY_MS,
} = {}) {
  console.log(`🏢 Fetching ${CONCORDIA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Prospective careercenter 1000725, HTML+JSON-LD)\n`);

  const detailUrls = await fetchConcordiaListingUrls({ fetchPage, maxPages, delayMs });
  console.log(`  ✓ ${detailUrls.length} jobs from board listing`);
  if (!detailUrls.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailFetchFailures = 0;
  let missingPostingData = 0;
  let shortDescriptions = 0;
  let unresolvedLocations = 0;
  for (const url of detailUrls) {
    let ld;
    try {
      const detailHtml = await fetchPage(url);
      ld = extractJobPostingLd(detailHtml);
    } catch (err) {
      detailFetchFailures += 1;
      console.warn(`  ⚠️ detail fetch failed: ${err?.message || err}`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    await new Promise((r) => setTimeout(r, delayMs));
    if (!ld || !ld.title) {
      missingPostingData += 1;
      continue;
    }

    const title = normalizeSpace(ld.title);
    const description = jobPostingDescriptionText(ld.description || '');
    if (!description || description.split(/\s+/).length < 20) {
      shortDescriptions += 1;
      continue;
    }

    const addr = jobPostingAddress(ld);
    const location = normalizeSpace(addr.addressLocality || '');
    const canton = resolveCanton(addr.addressRegion, location);
    if (!location || !isTargetSwissLocation(location, { includeBorderProximity: false }) || !canton) {
      unresolvedLocations += 1;
      continue;
    }
    const { postalCode, streetAddress } = resolveConcordiaAddress(addr, location, canton);
    const employmentType = /PART_TIME/i.test(ld.employmentType) ? 'PART_TIME'
      : /FULL_TIME/i.test(ld.employmentType) ? 'FULL_TIME' : 'OTHER';
    const postedDate = /^\d{4}-\d{2}-\d{2}/.test(String(ld.datePosted || ''))
      ? String(ld.datePosted).slice(0, 10) : todayIso;

    const hiringOrgName = normalizeSpace(ld?.hiringOrganization?.name || '') || CONCORDIA_COMPANY_NAME;
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${CONCORDIA_KEY} ${location}`);
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${CONCORDIA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: hiringOrgName,
      companyKey: CONCORDIA_KEY,
      companyDomain: CONCORDIA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton,
      url,
      source: `${CONCORDIA_COMPANY_NAME} Dedicated Parser (jobs.concordia.ch JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      streetAddress,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Assicurazioni',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`  ✓ detail pages: ${detailUrls.length}, fetched failures: ${detailFetchFailures}, missing JobPosting: ${missingPostingData}, short descriptions: ${shortDescriptions}, unresolved locations: ${unresolvedLocations}`);
  if (detailFetchFailures > 0 || missingPostingData > 0) {
    throw new Error(
      `Concordia detail extraction incomplete: ${detailFetchFailures + missingPostingData}/${detailUrls.length} detail page(s) failed or lacked JobPosting `
      + `(fetch failures=${detailFetchFailures}, missing JobPosting=${missingPostingData}); refusing to publish a partial dataset`,
    );
  }
  if (detailUrls.length > 0 && jobs.length === 0) {
    throw new Error(
      `Concordia source returned ${detailUrls.length} listing URLs but 0 valid Swiss JobPosting records `
      + `(fetch failures=${detailFetchFailures}, missing data=${missingPostingData}, short descriptions=${shortDescriptions}, unresolved locations=${unresolvedLocations})`,
    );
  }
  console.log(`\n📋 Total ${CONCORDIA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

// Re-export CAREER_URL for the workflow runner banner.
export { CAREER_URL };
