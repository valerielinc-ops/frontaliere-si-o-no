#!/usr/bin/env node
/**
 * Deloitte Switzerland job parser — Avature ATS (portal "CHCareers", id 23).
 *
 * Source: https://apply.deloitte.ch/CHCareers/SearchJobs/
 *
 * Deloitte is one of the Big Four consulting/audit firms, headquartered in
 * Zürich (Pfingstweidstrasse 11, 8005 Zürich ZH — confirmed via Deloitte's
 * own official office-locator page at
 * https://www.deloitte.com/ch/en/offices/switzerland-offices/zurich.html)
 * with additional Swiss offices in Basel, Bern, Geneva, Lausanne and Lugano.
 *
 * ATS discovery: the career site is powered by Avature (portal meta tags
 * `avature.portal.id=23`, `avature.portal.name="CH External Careers"`,
 * CDN `templates-static-assets.avacdn.net`). No Avature client exists yet in
 * `./ats-clients/` — this parser scrapes the server-rendered HTML directly
 * (regex-based, no cheerio/jsdom, consistent with the rest of the codebase).
 *
 * The RSS feed at `/CHCareers/SearchJobs/feed/` was evaluated first but
 * rejected: it is hard-capped at 20 items (query-param overrides for
 * page/size/limit/count/rows/max/pageSize all no-op) and carries no
 * location data. The real, complete source is the paginated HTML listing
 * (`?jobRecordsPerPage=6&jobOffset=N`), which exposes an authoritative
 * "X of NN results" total and was verified to return all NN postings with
 * no gaps/duplicates across every offset page.
 *
 * Each listing row links to a JobDetail page whose numeric trailing URL
 * segment (e.g. `/JobDetail/.../23953`) is the canonical job id — it is
 * self-consistent with the detail page's own "Req #" field, unlike the
 * RSS feed's unrelated internal item number. The detail page also carries
 * a structured `article__content__view__field` label/value block (City,
 * Business line, Experience level, Working time percentage, Date
 * published, Req #) plus the full HTML job description; the schema.org
 * JobPosting JSON-LD embedded on the same page only carries `title` +
 * `datePosted` (no address), so location must come from the label/value
 * block, not the JSON-LD.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllDeloitteJobs()  — Fetch and parse all jobs
 *   - isDeloitteJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - DELOITTE_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const DELOITTE_KEY = 'deloitte';
export const DELOITTE_COMPANY_NAME = 'Deloitte';
export const DELOITTE_COMPANY_DOMAIN = 'deloitte.ch';

const LISTING_BASE = 'https://apply.deloitte.ch/CHCareers/SearchJobs/';
const CAREER_URL = LISTING_BASE;
const PAGE_SIZE = 6;
const MAX_PAGES = 40; // safety cap (~240 jobs); the portal currently lists ~71

// The Avature portal serves a normal page to a real browser UA; no anti-bot
// challenge was observed, but a browser UA is used defensively (same
// precaution taken by the Emil Frey rexx parser for its ATS).
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── HQ fallback (Pfingstweidstrasse 11, 8005 Zürich, ZH) ────── */
/* Confirmed via Deloitte's own official Zürich office page — not a guess. */

const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8005',
  streetAddress: 'Pfingstweidstrasse 11',
  region: 'ZH',
};

const SECTOR = 'Consulenza, revisione e servizi professionali (Big Four)';

const MONTH_ABBR = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß').replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è')
    .replace(/&agrave;/g, 'à').replace(/&ccedil;/g, 'ç')
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    });
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Deloitte.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isDeloitteJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === DELOITTE_KEY ||
    key.startsWith('deloitte') ||
    company.includes('deloitte') ||
    url.includes('deloitte.ch') ||
    url.includes('apply.deloitte.ch/chcareers')
  );
}

/**
 * Validate that a URL belongs to Deloitte's domain (the Avature ATS host
 * apply.deloitte.ch is a subdomain of deloitte.ch, so it is already trusted
 * by the .endsWith() check).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'deloitte.ch' || host.endsWith('.deloitte.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

// Deloitte's own official Swiss business lines (from the detail page's
// "Business line" field and the boilerplate footer paragraph) map onto the
// shared Italian-label taxonomy used by sibling parsers.
function detectCategory(title = '', businessLine = '') {
  const bl = normalize(businessLine);
  if (/audit|assurance/.test(bl)) return 'Finanza';
  if (/tax|legal/.test(bl)) return 'Legale';
  if (/strategy|risk|transaction/.test(bl)) return 'Consulenza';
  if (/technology|transformation/.test(bl)) return 'IT';
  if (/internal client services/.test(bl)) return 'Amministrazione';

  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|develop|cloud|cyber|security|data|sap\b|it\b|architect)/.test(t)) return 'IT';
  if (/\b(tax|steu|fiscal|imposte|legal|giurid|recht|compliance)/.test(t)) return 'Legale';
  if (/\b(audit|revisione|prüfung|wirtschaftsprüf|assurance)/.test(t)) return 'Finanza';
  if (/\b(consult|conseil|advisory|beratung|strateg)/.test(t)) return 'Consulenza';
  if (/\b(admin|segret|contab|buchhalt|office)/.test(t)) return 'Amministrazione';
  if (/\b(hr\b|human|risorse|personal|recruit|talent)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|brand)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|treasury)/.test(t)) return 'Finanza';

  return 'Consulenza';
}

function detectExperienceLevel(title = '', experienceLevelRaw = '') {
  const raw = normalize(experienceLevelRaw);
  if (/entry|graduate|junior/.test(raw)) return 'junior';
  if (/intern|apprentice|trainee/.test(raw)) return 'intern';

  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|partner)/.test(t)) return 'senior';
  return 'mid';
}

// Deloitte doesn't label part-time/full-time directly — it publishes a
// "Working time percentage" range (e.g. "80% - 100%"); a max below 100%
// signals a part-time role.
function detectEmploymentType(pctText = '') {
  const nums = (String(pctText || '').match(/\d+/g) || []).map(Number);
  if (nums.length === 0) return 'FULL_TIME';
  const max = Math.max(...nums);
  return max < 100 ? 'PART_TIME' : 'FULL_TIME';
}

function parseDeloitteDate(raw = '') {
  const m = String(raw || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return '';
  const mon = MONTH_ABBR[m[2].toLowerCase()];
  if (!mon) return '';
  return `${m[3]}-${mon}-${m[1].padStart(2, '0')}`;
}

/* ── Address Resolution ───────────────────────────────────────
 * Pick the best city / postal code / street / region from Deloitte's
 * (possibly multi-office, comma-separated) "City" field, falling back to
 * the documented HQ address (Zürich) when the field is empty or doesn't
 * map to a recognized Swiss canton. A job is never dropped just because
 * its office string is unmapped — it always falls back to HQ.
 *
 * Deloitte routinely posts one role across several offices at once (e.g.
 * "Basel, Geneva, Zurich") — postalCode/streetAddress must ONLY be filled
 * from HQ when the RESOLVED canton is actually the HQ canton (ZH), never
 * unconditionally, or a Basel/Geneva/Bern/Lausanne/Lugano job would get
 * mislabeled with the Zürich street address.
 */
function resolveAddress(cityRaw = '') {
  const raw = normalizeSpace(cityRaw);
  if (!raw) {
    return {
      city: HQ.city,
      canton: HQ.canton,
      postalCode: HQ.postalCode,
      streetAddress: HQ.streetAddress,
      region: HQ.region,
    };
  }

  const canton = inferSwissTargetCanton(raw);
  if (!canton) {
    return {
      city: HQ.city,
      canton: HQ.canton,
      postalCode: HQ.postalCode,
      streetAddress: HQ.streetAddress,
      region: HQ.region,
    };
  }

  // Prefer the individual office segment that itself maps to the resolved
  // canton (keeps the displayed city consistent with the canton, even
  // though the field is frequently a multi-office rollup).
  const segments = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const matchingSegment = segments.find((seg) => inferSwissTargetCanton(seg) === canton);
  const city = matchingSegment || segments[0] || HQ.city;

  return {
    city,
    canton,
    postalCode: canton === HQ.canton ? HQ.postalCode : '',
    streetAddress: canton === HQ.canton ? HQ.streetAddress : '',
    region: canton,
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Parse one `<article class="article article--result">` listing block into
 * a stub. Returns null if no JobDetail URL/title is found.
 */
function parseListingArticle(block) {
  const urlMatch = block.match(
    /href="(https:\/\/apply\.deloitte\.ch\/CHCareers\/JobDetail\/[^"]+)"/i,
  );
  if (!urlMatch) return null;
  const url = urlMatch[1];

  const titleMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  const title = titleMatch ? decodeHtmlEntities(stripHtml(titleMatch[1])).trim() : '';
  if (!title) return null;

  const idMatch = url.match(/\/(\d+)\/?$/);
  return {
    title,
    url,
    jobReqId: idMatch ? idMatch[1] : '',
  };
}

/**
 * Extract a labelled `article__content__view__field` value from a Deloitte
 * detail page (e.g. label "City" → value "Basel, Geneva, Zurich").
 */
function extractField(html, labelText) {
  const escaped = labelText
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const re = new RegExp(
    `field__label">\\s*${escaped}\\s*<\\/div>[\\s\\S]*?field__value">([\\s\\S]*?)<\\/div>`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeHtmlEntities(stripHtml(m[1])).trim() : '';
}

/**
 * Extract the raw "Job description" section HTML from a Deloitte detail
 * page. Unlike the metadata fields above, this field has no preceding
 * `field__label` div, so it's located via the "Job description" heading
 * and bounded by the enclosing `</article>`.
 */
function extractJobDescriptionHtml(html) {
  const headerIdx = html.search(/Job description\s*<\/h3>/i);
  if (headerIdx === -1) return '';
  const afterHeader = html.slice(headerIdx);
  const articleEndIdx = afterHeader.search(/<\/article>/i);
  const chunk = articleEndIdx === -1 ? afterHeader : afterHeader.slice(0, articleEndIdx);
  const valueMatch = chunk.match(/field__value">([\s\S]*)$/i);
  return valueMatch ? valueMatch[1] : '';
}

/**
 * Extract the schema.org JobPosting JSON-LD block (title + datePosted only
 * on this ATS — no address) from a detail page.
 */
function extractJsonLd(html) {
  const scripts = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (!scripts) return null;
  for (const script of scripts) {
    const inner = script.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim();
    let data;
    try {
      data = JSON.parse(inner);
    } catch {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const c of candidates) {
      if (c && c['@type'] === 'JobPosting') return c;
    }
  }
  return null;
}

/**
 * Fetch one detail page and pull out the structured fields + description.
 * Returns null (never throws) if the fetch fails — the caller falls back
 * to listing-only stub data.
 */
async function fetchJobDetail(url) {
  let html;
  try {
    html = await fetchHtml(url, { headers: { 'User-Agent': BROWSER_UA } });
  } catch (err) {
    console.warn(`   ⚠️ detail fetch failed (${url}): ${err && err.message ? err.message : err}`);
    return null;
  }

  const ld = extractJsonLd(html);
  return {
    businessLine: extractField(html, 'Business line'),
    city: extractField(html, 'City'),
    experienceLevelRaw: extractField(html, 'Experience level'),
    workingPct: extractField(html, 'Working time percentage'),
    datePublishedRaw: extractField(html, 'Date published'),
    descriptionHtml: extractJobDescriptionHtml(html),
    datePosted: (ld && ld.datePosted) || '',
  };
}

/**
 * Fetch all server-rendered listing rows across every page. The Avature
 * portal paginates via plain GET SearchJobs/?jobRecordsPerPage=6&jobOffset=N
 * — no JS/AJAX needed. Each stub is then enriched from its detail page.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${LISTING_BASE}`);

  const byUrl = new Map();
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const pageUrl = `${LISTING_BASE}?jobRecordsPerPage=${PAGE_SIZE}&jobOffset=${offset}`;
    let html;
    try {
      html = await fetchHtml(pageUrl, { headers: { 'User-Agent': BROWSER_UA } });
    } catch (err) {
      console.warn(`   ⚠️ listing page fetch failed (${pageUrl}): ${err && err.message ? err.message : err}`);
      break;
    }

    const legendMatch = html.match(/list-controls__text__legend"[^>]*>([\s\S]{0,200}?)<\/div>/i);
    if (legendMatch) {
      const totalMatch = legendMatch[1].match(/of\s+(\d+)/i);
      if (totalMatch) total = Number(totalMatch[1]);
    }

    const blocks = html.match(/<article class="article article--result">[\s\S]*?<\/article>/gi) || [];
    let added = 0;
    for (const block of blocks) {
      const stub = parseListingArticle(block);
      if (!stub || byUrl.has(stub.url)) continue;
      byUrl.set(stub.url, stub);
      added++;
    }

    console.log(`   📄 page offset=${offset}: +${added} (collected ${byUrl.size}${total ? `/${total}` : ''})`);

    if (blocks.length === 0 || added === 0) break;
    if (total && byUrl.size >= total) break;
  }

  const stubs = [...byUrl.values()];
  console.log(`   🔗 ${stubs.length} job detail pages to enrich`);

  const listings = [];
  for (const stub of stubs) {
    const detail = await fetchJobDetail(stub.url);
    listings.push({ ...stub, detail });
    await new Promise((r) => setTimeout(r, 200));
  }
  return listings;
}

/**
 * Fetch all Deloitte jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllDeloitteJobs() {
  console.log(`🔍 Fetching ${DELOITTE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (Avature portal "CHCareers")\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const detail = listing.detail || {};
    const { city, canton, postalCode, streetAddress, region } = resolveAddress(detail.city);
    const location = normalizeSpace(city || HQ.city);

    const descriptionText = normalizeSpace(stripHtml(detail.descriptionHtml || ''));
    const description = descriptionText
      || `${title} presso Deloitte Svizzera, sede a ${location}. Deloitte è una delle Big Four della consulenza, revisione contabile e servizi professionali a livello globale. Candidati su apply.deloitte.ch.`;

    const publicUrl = listing.url || CAREER_URL;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} deloitte ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(detail.workingPct || '');
    const postedDate =
      (detail.datePosted && String(detail.datePosted).slice(0, 10)) ||
      parseDeloitteDate(detail.datePublishedRaw) ||
      new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${DELOITTE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: DELOITTE_COMPANY_NAME,
      companyKey: DELOITTE_KEY,
      companyDomain: DELOITTE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Deloitte Dedicated Parser (Avature)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, detail.businessLine),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title, detail.experienceLevelRaw),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      hiringOrganizationName: DELOITTE_COMPANY_NAME,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${DELOITTE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
