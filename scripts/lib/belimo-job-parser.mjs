#!/usr/bin/env node
/**
 * Belimo job parser — bespoke in-house "job-listing" widget (NOT an ATS).
 *
 * Source: https://www.belimo.com/ch/de_CH/job-listing (Swiss career page).
 *
 * Belimo is a Swiss manufacturer of damper and valve actuators for HVAC /
 * building automation, headquartered in Hinwil ZH (Brunnenbachstrasse 1,
 * 8340 Hinwil — verified via the site's own footer text, and cross-checked
 * against the opencorpdata.com LEI record; NOT 8620, which is Wetzikon's
 * postal code, a different nearby ZH town).
 *
 * ATS discovery: a Nov-2025 Wayback Machine snapshot of jobs.belimo.com
 * shows the site used to run SAP SuccessFactors Recruiting Marketing
 * (career4.successfactors.com/career?company=C0000206975T1). The LIVE site
 * has since migrated off SF entirely — grepping the current rendered HTML
 * for "successfactors|smartrecruiters|workday|personio|greenhouse|taleo"
 * returns zero matches. The job list is now a plain-HTML widget embedded
 * directly in www.belimo.com (traces of the old SF integration remain only
 * as a stale in-page comment: "fallback to successFactorsData.defaultLanguage").
 * There is no JSON API or iframe — genuinely bespoke HTML scraping is
 * required, hence no `./ats-clients/*` shared client is used here.
 *
 * The widget is Akamai-WAF-gated (HTTP 403 to datacenter/CI egress IPs on
 * every path tried, incl. `/careers`, `/job-listing`, and the legacy
 * `jobs.belimo.com` which itself 301s to the 403'd `/job-listing`). The
 * shared `fetchHtml()` from crawler-template.mjs already auto-rescues via
 * the Jina Reader proxy on exactly this WAF status class
 * (`WAF_IP_BLOCK_STATUS` incl. 403), so no custom Jina wiring is needed here.
 *
 * Listing DOM (paginated, `?page=N`; page 1 must be fetched WITHOUT the
 * query param — an explicit `?page=1` renders an empty list, a widget quirk):
 *   <div class="joblist__item">
 *     <h3><a href="/us/en_US/jobs/{id}">{title}</a></h3>
 *     <p><span>{city}, {country}</span> | {jobType}</p>
 *   </div>
 * Max page number is read off `data-page="N"` pagination buttons.
 *
 * Detail DOM (no JSON-LD; plain structured `<dl>`):
 *   <h1 class="jobdetails__title">{title}</h1>
 *   <section class="jobdetails__content">{description html}</section>
 *   <dl><dt>Location</dt><dd>{Country}, {City}</dd>
 *       <dt>Category</dt><dd>...</dd> <dt>Department</dt><dd>...</dd>
 *       <dt>Job type</dt><dd>...</dd> <dt>Job flexibility</dt><dd>...</dd>
 *       <dt>Recruiter</dt><dd>...</dd></dl>
 *
 * Description language follows the original posting's source language
 * (mixed DE/EN across postings), not the `/us/en_US/` URL locale prefix —
 * that locale segment is only used here because its pagination proved
 * reliable across all pages during investigation (some `/ch/de_CH/...`
 * page/locale combinations intermittently rendered an empty list via Jina,
 * a rendering-timing flake rather than genuinely missing data).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBelimoJobs()   — Fetch and parse all Swiss jobs
 *   - isBelimoJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BELIMO_KEY = 'belimo';
export const BELIMO_COMPANY_NAME = 'Belimo';
export const BELIMO_COMPANY_DOMAIN = 'belimo.com';

// Documented "source" career page (Swiss locale); pagination is fetched
// against the /us/en_US/ prefix, which proved empirically reliable across
// all pages — see header note above.
const CAREER_URL = 'https://www.belimo.com/ch/de_CH/job-listing';
const LISTING_URL = 'https://www.belimo.com/us/en_US/job-listing';

/* ── HQ fallback (Brunnenbachstrasse 1, 8340 Hinwil, ZH) ─────── */

const HQ = {
  city: 'Hinwil',
  canton: 'ZH',
  postalCode: '8340',
  streetAddress: 'Brunnenbachstrasse 1',
  region: 'Zürich',
};

const SECTOR = 'Industria / Automazione edifici';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Belimo.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBelimoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BELIMO_KEY ||
    key.startsWith('belimo') ||
    company.includes('belimo') ||
    url.includes('belimo.com')
  );
}

/**
 * Validate that a URL belongs to Belimo's own domain (no 3rd-party ATS
 * host — the widget lives directly on www.belimo.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'belimo.com' || host.endsWith('.belimo.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

const CATEGORY_MAP = {
  'production/manufacturing': 'Produzione',
  production: 'Produzione',
  manufacturing: 'Produzione',
  engineering: 'Ingegneria',
  'research and development': 'Ricerca e Sviluppo',
  'r&d': 'Ricerca e Sviluppo',
  sales: 'Commerciale',
  'sales & marketing': 'Commerciale',
  marketing: 'Marketing',
  finance: 'Finanza',
  'human resources': 'Risorse Umane',
  hr: 'Risorse Umane',
  it: 'IT',
  'information technology': 'IT',
  logistics: 'Logistica',
  'supply chain': 'Logistica',
  quality: 'Qualità',
  administration: 'Amministrazione',
  legal: 'Legale',
};

function detectCategory(rawCategory = '', title = '') {
  const mapped = CATEGORY_MAP[normalize(rawCategory)];
  if (mapped) return mapped;

  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|architect)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|meccatron|mechatron|instandhalt)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|montage|fertigung|assembly)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|working student)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Belimo's "Job type" field is Permanent/Temporary (contract duration, not
 * hours) — part-time signal instead comes from a "(NN-100%)" / "(NN%)"
 * workload suffix commonly appended to Swiss job titles.
 */
function detectEmploymentType(jobTypeLabel = '', title = '') {
  const pctMatch = title.match(/\((\d{1,3})\s*(?:-\s*(\d{1,3})\s*)?%\)/);
  if (pctMatch) {
    const nums = [pctMatch[1], pctMatch[2]].filter(Boolean).map(Number);
    if (nums.length && Math.max(...nums) < 100) return 'PART_TIME';
  }
  const t = normalize(jobTypeLabel);
  if (/temporary|befristet|temporaneo/.test(t)) return 'TEMPORARY';
  if (/intern|praktik|stage/.test(t)) return 'INTERN';
  if (/permanent|unbefristet|fest/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

const ITEM_RX = /<div class="joblist__item">\s*<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>\s*<\/h3>\s*<p>\s*<span>([^<]*)<\/span>\s*\|\s*([^<]*)<\/p>\s*<\/div>/g;

function parseListingItems(html = '') {
  const items = [];
  const rx = new RegExp(ITEM_RX.source, 'g');
  let m;
  while ((m = rx.exec(html))) {
    const [, href, title, locationText, employmentLabel] = m;
    items.push({
      href: (href || '').trim(),
      title: normalizeSpace(title || ''),
      locationText: normalizeSpace(locationText || ''),
      employmentLabel: normalizeSpace(employmentLabel || ''),
    });
  }
  return items;
}

function parseMaxPage(html = '') {
  const pages = [...html.matchAll(/data-page="(\d+)"/g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : 1;
}

/**
 * Fetch a single listing page. Page 1 MUST be the bare URL (an explicit
 * `?page=1` renders empty — a widget quirk). Pages 2+ occasionally render
 * an empty `joblist__list` when Jina's headless render snapshots before the
 * client-side widget finishes hydrating — retry a couple of times before
 * accepting the page is genuinely out of range.
 */
async function fetchListingPage(pageNum, timeoutMs) {
  const url = pageNum <= 1 ? LISTING_URL : `${LISTING_URL}?page=${pageNum}`;
  const attempts = pageNum <= 1 ? 1 : 3;
  let html = '';
  let items = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    html = await fetchHtml(url, { timeoutMs });
    items = parseListingItems(html);
    if (items.length > 0) break;
  }
  return { html, items };
}

/**
 * Fetch every listing page, filter to Swiss postings, then fetch each
 * Swiss posting's detail page for the full description + metadata.
 * Returns an array of raw listing objects.
 */
async function fetchJobListings() {
  console.log('   Fetching Belimo job-listing widget (paginated, Switzerland-only filter)');
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const { html: page1Html, items: page1Items } = await fetchListingPage(1, timeoutMs);
  const maxPage = parseMaxPage(page1Html);
  console.log(`   Pages detected: ${maxPage}`);

  const allItems = [...page1Items];
  for (let page = 2; page <= maxPage; page += 1) {
    const { items } = await fetchListingPage(page, timeoutMs);
    allItems.push(...items);
  }

  const seenHrefs = new Set();
  const swissItems = [];
  for (const item of allItems) {
    if (!item.href || seenHrefs.has(item.href)) continue;
    if (!/switzerland|schweiz|suisse|svizzera/i.test(item.locationText)) continue;
    seenHrefs.add(item.href);
    swissItems.push(item);
  }
  console.log(`   Swiss listings: ${swissItems.length} / ${allItems.length} total`);

  const listings = [];
  for (const item of swissItems) {
    const detailUrl = new URL(item.href, LISTING_URL).toString();
    try {
      const detailHtml = await fetchHtml(detailUrl, { timeoutMs });
      const titleMatch = detailHtml.match(/<h1 class="jobdetails__title">([^<]*)<\/h1>/);
      const secMatch = detailHtml.match(/<section class="jobdetails__content">([\s\S]*?)<\/section>/);
      const dlMatch = detailHtml.match(/<dl>([\s\S]*?)<\/dl>/);

      const meta = {};
      if (dlMatch) {
        for (const [, k, v] of dlMatch[1].matchAll(/<dt>([^<]*)<\/dt>\s*<dd>([^<]*)<\/dd>/g)) {
          meta[normalizeSpace(k).toLowerCase()] = normalizeSpace(v);
        }
      }

      listings.push({
        title: normalizeSpace((titleMatch && titleMatch[1]) || item.title),
        href: item.href,
        url: detailUrl,
        descriptionHtml: (secMatch && secMatch[1]) || '',
        locationText: item.locationText,
        employmentLabel: item.employmentLabel,
        meta,
      });
    } catch (err) {
      console.warn(`⚠️ Detail fetch failed for ${detailUrl}: ${err?.message || err}`);
    }
  }

  return listings;
}

/**
 * Pick the best city / postal code / street / region for a Belimo posting,
 * falling back to the documented HQ address (Hinwil ZH) only when the
 * resolved city TEXT matches Hinwil — never on canton equality (all Swiss
 * Belimo postings currently observed are in Hinwil, but this must not
 * silently paper over a future non-Hinwil ZH posting).
 */
function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
  const postalCode = (rawLoc.postalCode || '').trim();
  const streetAddress = (rawLoc.address || '').trim();
  const region = (rawLoc.region || '').trim();

  return {
    city: city || HQ.city,
    postalCode: postalCode || (!city || /hinwil/i.test(city) ? HQ.postalCode : ''),
    streetAddress: streetAddress || (!city || /hinwil/i.test(city) ? HQ.streetAddress : ''),
    region,
  };
}

/**
 * Fetch all Belimo jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBelimoJobs() {
  console.log(`🔍 Fetching ${BELIMO_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const cityRaw = normalizeSpace((listing.locationText || '').split(',')[0] || '');
    const { city, postalCode, streetAddress, region } = resolveAddress({
      city: cityRaw,
      fullLocation: listing.locationText,
    });
    const location = normalizeSpace(listing.locationText || city || HQ.city);
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(city) || HQ.canton;

    const descriptionHtml = listing.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const description = descriptionText || `${title} presso ${BELIMO_COMPANY_NAME} a ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} belimo ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobTypeLabel = listing.meta?.['job type'] || listing.employmentLabel || '';
    const employmentType = detectEmploymentType(jobTypeLabel, title);
    const postedDate = new Date().toISOString().split('T')[0];
    const jobReqId = (listing.href || '').split('/').filter(Boolean).pop() || null;

    const job = {
      // ── Required fields ──
      id: `${BELIMO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BELIMO_COMPANY_NAME,
      companyKey: BELIMO_KEY,
      companyDomain: BELIMO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Belimo Dedicated Parser (custom job-listing widget)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(listing.meta?.category || '', title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${BELIMO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
