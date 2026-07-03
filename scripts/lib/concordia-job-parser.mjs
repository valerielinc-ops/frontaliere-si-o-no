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
 * subset. `addressRegion` on the detail page is the canton name spelled in
 * whichever locale the individual posting is authored in (German most
 * common, French/Italian seen on some listings) — mapped via
 * `CANTON_NAME_TO_CODE` with a fuzzy `inferAnyCanton(city)` fallback.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { fetchHtml } from './hospital-custom-html-helpers.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { extractJobPostingLd, jobPostingDescriptionText, jobPostingAddress } from './jsonld-jobposting.mjs';

export const CONCORDIA_KEY = 'concordia';
export const CONCORDIA_COMPANY_NAME = 'Concordia';
export const CONCORDIA_COMPANY_DOMAIN = 'concordia.ch';

const BOARD_HOST = 'jobs.concordia.ch';
const LISTING_URL = `https://${BOARD_HOST}/`;
const CAREER_URL = 'https://www.concordia.ch/de/ueber-uns/jobs/offene-stellen.html';
const PAGE_SIZE = 100;
const POLITE_DELAY_MS = 200;

// HQ fallback — Tribschenstrasse, Luzern (observed on multiple live listings).
const DEFAULT_CANTON = 'LU';
const DEFAULT_CITY = 'Luzern';
const DEFAULT_POSTAL = '6005';

// `addressRegion` on the detail page is the Swiss canton name, spelled in
// whichever locale the individual job posting happens to be authored in
// (German/French/Italian all observed live). Direct name → code lookup is
// more reliable than fuzzy city matching for this field.
const CANTON_NAME_TO_CODE = {
  aargau: 'AG', argovie: 'AG', argovia: 'AG',
  'appenzell ausserrhoden': 'AR', 'appenzell rhodes-extérieures': 'AR',
  'appenzell innerrhoden': 'AI', 'appenzell rhodes-intérieures': 'AI',
  'basel-landschaft': 'BL', 'bâle-campagne': 'BL',
  'basel-stadt': 'BS', 'bâle-ville': 'BS', basel: 'BS', bâle: 'BS',
  bern: 'BE', berne: 'BE', berna: 'BE',
  freiburg: 'FR', fribourg: 'FR',
  genf: 'GE', genève: 'GE', geneva: 'GE', ginevra: 'GE',
  glarus: 'GL', glaris: 'GL',
  graubünden: 'GR', grigioni: 'GR', grisons: 'GR', grischun: 'GR',
  jura: 'JU',
  luzern: 'LU', lucerne: 'LU', lucerna: 'LU',
  neuenburg: 'NE', neuchâtel: 'NE',
  nidwalden: 'NW', nidwald: 'NW',
  obwalden: 'OW', obwald: 'OW',
  schaffhausen: 'SH', schaffhouse: 'SH',
  schwyz: 'SZ',
  solothurn: 'SO', soleure: 'SO',
  'st. gallen': 'SG', 'st gallen': 'SG', 'saint-gall': 'SG', 'san gallo': 'SG',
  tessin: 'TI', ticino: 'TI',
  thurgau: 'TG', thurgovie: 'TG',
  uri: 'UR',
  waadt: 'VD', vaud: 'VD',
  wallis: 'VS', valais: 'VS', vallese: 'VS',
  zug: 'ZG', zoug: 'ZG',
  zürich: 'ZH', zurich: 'ZH', zurigo: 'ZH',
};

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function resolveCanton(addressRegion = '', addressLocality = '') {
  const region = normalizeSpace(addressRegion).toLowerCase();
  if (region && CANTON_NAME_TO_CODE[region]) return CANTON_NAME_TO_CODE[region];
  const fromCity = inferAnyCanton(addressLocality) || inferAnyCanton(addressRegion);
  return fromCity || DEFAULT_CANTON;
}

/** Insurance/national-employer-scoped role category detector. */
export function detectCategory(title = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/\b(lernende|lehrstelle|apprenti|stagiaire|praktik|stage)/.test(t)) return 'Formazione';
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
  if (/\b(lernende|lehrstelle|apprenti|stagiaire|praktik|stage|intern)/.test(t)) return 'intern';
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

/** Fetch every listing page (offset-paginated) and return the union of detail URLs. */
async function fetchAllDetailUrls() {
  const seen = new Set();
  const out = [];
  let offset = 0;
  // Defensive cap — current live total is ~59; 2000 covers large future growth
  // without risking an infinite loop if the board ever stops honoring `offset`.
  const HARD_CAP = 2000;
  while (offset < HARD_CAP) {
    const pageUrl = `${LISTING_URL}?offset=${offset}&limit=${PAGE_SIZE}&lang=de`;
    let html;
    try {
      html = await fetchHtml(pageUrl);
    } catch (err) {
      console.warn(`  ⚠️  Concordia listing fetch failed at offset=${offset}: ${err?.message || err}.`);
      break;
    }
    const urls = parseConcordiaListing(html);
    let added = 0;
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      added += 1;
    }
    if (urls.length === 0 || added === 0) break;
    if (urls.length < PAGE_SIZE) break; // last page
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
  }
  return out;
}

export async function fetchAllConcordiaJobs() {
  console.log(`🏢 Fetching ${CONCORDIA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Prospective careercenter 1000725, HTML+JSON-LD)\n`);

  let detailUrls;
  try {
    detailUrls = await fetchAllDetailUrls();
  } catch (err) {
    console.warn(`⚠️ Concordia listing fetch failed: ${err?.message || err}`);
    return [];
  }
  console.log(`  ✓ ${detailUrls.length} jobs from board listing`);
  if (!detailUrls.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const url of detailUrls) {
    let ld;
    try {
      const detailHtml = await fetchHtml(url);
      ld = extractJobPostingLd(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ detail fetch failed: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    if (!ld || !ld.title) continue;

    const title = normalizeSpace(ld.title);
    const description = jobPostingDescriptionText(ld.description || '');
    if (!description || description.split(/\s+/).length < 20) continue;

    const addr = jobPostingAddress(ld);
    const location = addr.addressLocality || DEFAULT_CITY;
    const canton = resolveCanton(addr.addressRegion, location);
    const postalCode = addr.postalCode || DEFAULT_POSTAL;
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
      streetAddress: addr.streetAddress || '',
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

  console.log(`\n📋 Total ${CONCORDIA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

// Re-export CAREER_URL for the workflow runner banner.
export { CAREER_URL };
