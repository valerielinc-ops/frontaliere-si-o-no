#!/usr/bin/env node
/**
 * Patek Philippe job parser — Fetcher and job builder.
 *
 * Source: https://careers.patek.com/search/ (SAP SuccessFactors "jobs2web"
 * server-rendered career site — same family as the Rolex parser, but on
 * Patek Philippe's own branded host `careers.patek.com`, discovered from the
 * "Se connecter" link on https://www.patek.com/en/careers pointing at
 * `career55.sapsf.eu/career?career_company=patekphili`).
 *
 * The listing is a single, unpaginated <table id="searchresults"> of
 * <tr class="data-row"> rows (recon: "Résultats 1 – 14 sur 14" — small,
 * genuinely CH-only manufacture roles, no pagination needed in practice but
 * a page-size safety loop is kept in case volume grows). Each row links to a
 * `/job/<slug>/<jobId>/` detail page carrying schema.org/JobPosting
 * MICRODATA (itemprop, not JSON-LD) — same shape as Rolex's carrieres-rolex.com.
 *
 * Patek Philippe manufactures exclusively in Switzerland (Genève /
 * Plan-les-Ouates HQ + Vallée de Joux + Saint-Imier + La Chaux-de-Fonds
 * sites), so the tenant is CH-only — no country filter required (recon
 * confirms all listing rows show "<City>, CH").
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllPatekPhilippeJobs()  — Fetch and parse all jobs
 *   - isPatekPhilippeJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()            — Validate URLs belong to this company
 *   - slugify() / stripHtml()      — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml, normalizeDescriptionBullets } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  isSuccessFactorsWidgetText,
  sanitizeSuccessFactorsField,
  stripSuccessFactorsMoreLocations,
} from './successfactors-jobs2web-widget-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PATEK_PHILIPPE_KEY = 'patek-philippe';
export const PATEK_PHILIPPE_COMPANY_NAME = 'Patek Philippe';
export const PATEK_PHILIPPE_COMPANY_DOMAIN = 'patek.com';

const CAREER_URL = 'https://careers.patek.com/search/';
const ATS_ORIGIN = 'https://careers.patek.com';
const ATS_HOST = 'careers.patek.com';
const PAGE_SIZE = 25; // recon: all 14 postings fit on one page; kept as a growth safety cap.
const MAX_PAGES = 20;

// HQ fallback (Chemin du Pont-du-Centenaire 141, 1228 Plan-les-Ouates, GE)
// — confirmed via patek.com's own legal-notices page (terms-and-conditions
// imprint), also registered in scripts/lib/crawler-location-config.mjs.
const HQ = {
  city: 'Plan-les-Ouates',
  canton: 'GE',
  postalCode: '1228',
  streetAddress: 'Chemin du Pont-du-Centenaire 141',
  region: 'GE',
};

const SECTOR = 'Luxury / Watchmaking (Manufacturing)';

const CRAWLER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Patek Philippe.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isPatekPhilippeJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === PATEK_PHILIPPE_KEY ||
    key.startsWith('patek-philippe') ||
    company.includes('patek philippe') ||
    company.includes('patek-philippe') ||
    url.includes('patek.com') ||
    url.includes('careers.patek.com')
  );
}

/**
 * Validate that a URL belongs to Patek Philippe's domain OR the ATS host
 * that actually serves the postings (careers.patek.com + underlying
 * SuccessFactors infrastructure).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'patek.com' || host.endsWith('.patek.com')) return true;
    if (host === ATS_HOST) return true;
    if (host.endsWith('.successfactors.eu') || host.endsWith('.successfactors.com')) return true;
    if (host.endsWith('.sapsf.eu') || host.endsWith('.sapsf.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(serti|sertisseu|bijoutier|habillement|m[ée]tiers d'art|gemmolog)/.test(t)) return 'Artigianato / Orologeria';
  if (/\b(microm[ée]canic|horlog|mouvement|assembleu|remonteu)/.test(t)) return 'Tecnica';
  if (/\b(ingegner|engineer|ing[ée]nieur|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(admin|segret|contab|buchhalt|account|comptab)/.test(t)) return 'Amministrazione';
  if (/\b(vente|vendita|sales|verkauf|commerce|conseiller)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|process)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|informati)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|rh\b)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|praktik|apprenti|apprendist)/.test(t)) return 'INTERN';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  // Listing "colFacility" column carries the contract type: CDI (permanent) /
  // CDD (fixed-term).
  if (/\bcdd\b/.test(t)) return 'TEMPORARY';
  if (/\bcdi\b/.test(t)) return 'FULL_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── HTML helpers ─────────────────────────────────────────────── */

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&amp;apos;/gi, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
}

function textOf(html = '') {
  return normalizeSpace(decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')));
}

/** Pull a microdata value (works for both <meta content="…"> and inline text). */
function microdata(html, prop) {
  const meta = html.match(
    new RegExp(`<meta[^>]*itemprop="${prop}"[^>]*content="([^"]*)"`, 'i'),
  );
  if (meta) return decodeEntities(meta[1]).trim();
  const inline = html.match(
    new RegExp(`itemprop="${prop}"[^>]*>([\\s\\S]*?)<`, 'i'),
  );
  return inline ? textOf(inline[1]) : '';
}

/**
 * Parse a SuccessFactors "datePosted" microdata value in the observed
 * `Fri Jul 03 00:00:00 UTC 2026` (JS-Date-parseable) form. Falls back to
 * `null` on anything unrecognized so the caller can default to "today".
 */
function parsePostedDate(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Parse one career-site listing page into raw listing rows.
 * Each <tr class="data-row"> carries:
 *   - a.jobTitle-link[href=/job/<slug>/<jobId>/]  → title + url + jobReqId
 *   - td.colLocation span.jobLocation             → "<City>, CH" (location)
 *   - td.colDepartment span.jobDepartment          → département (category hint)
 *   - td.colFacility span.jobFacility               → contrat (CDI/CDD/Stage)
 */
function parseListingPage(html, pageUrl) {
  const out = [];
  const seen = new Set();
  let origin = ATS_ORIGIN;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    /* keep default */
  }
  const rowRe = /<tr class="data-row">([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const row = rm[1];
    const link = row.match(/<a[^>]+href="(\/job\/[^"]+\/(\d+)\/?)"[^>]*class="jobTitle-link"/i)
      || row.match(/<a[^>]+class="jobTitle-link"[^>]*href="(\/job\/[^"]+\/(\d+)\/?)"/i);
    if (!link) continue;
    const jobReqId = link[2];
    if (seen.has(jobReqId)) continue;
    seen.add(jobReqId);

    const href = decodeEntities(link[1]);
    const url = href.startsWith('http') ? href : `${origin}${href}`;

    const titleM = row.match(/class="jobTitle-link"[^>]*>([\s\S]*?)<\/a>/i)
      || row.match(/<a[^>]+class="jobTitle-link"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleM ? textOf(titleM[1]) : '';
    if (!title || title.length < 3) continue;
    // A row whose anchor text is the j2w page chrome (cookie-consent widget,
    // keyword-search box, job-alert box) is not a posting — discard it rather
    // than clean it, which would leave an annuncio without a name.
    if (isSuccessFactorsWidgetText(title)) continue;

    const locationCell = row.match(/class="colLocation[^"]*"[\s\S]*?<\/td>/i);
    const locationM = locationCell
      ? locationCell[0].match(/class="jobLocation"[^>]*>([\s\S]*?)<\/span>/i)
      : null;
    const department = (row.match(/class="jobDepartment[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    const facility = (row.match(/class="jobFacility[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];

    out.push({
      title,
      url,
      jobReqId,
      // `</span>`-bounded match also swallows the nested `<small>+N
      // more&hellip;</small>` of multi-location rows — keep the visible office.
      location: locationM ? stripSuccessFactorsMoreLocations(textOf(locationM[1])) : '',
      department: department ? textOf(department) : '',
      contract: facility ? textOf(facility) : '',
    });
  }
  return out;
}

/** Best-effort detail-page enrichment: JobPosting microdata. */
async function enrichFromDetail(listing, timeoutMs) {
  try {
    const html = await fetchHtml(listing.url, {
      headers: { 'User-Agent': CRAWLER_UA, Accept: 'text/html,application/xhtml+xml' },
      timeoutMs,
    });
    // Note: the SF "streetAddress" microdata field here actually carries
    // "<City>, CH" (locality text), not a literal street — same quirk as
    // the Rolex jobs2web tenant. We treat it purely as a locality signal.
    const localityRaw = microdata(html, 'streetAddress');
    const locality = localityRaw.replace(/,\s*CH\s*$/i, '').trim();
    const hiringOrgName = microdata(html, 'hiringOrganization');
    const datePosted = microdata(html, 'datePosted');
    let descriptionHtml = '';
    const descAnchor = html.search(/itemprop="description"/i);
    if (descAnchor !== -1) {
      const slice = html.slice(descAnchor);
      const open = slice.indexOf('>');
      if (open !== -1) {
        const body = slice.slice(open + 1);
        const end = body.search(/<\/span>\s*<\/div>\s*<\/div>|class="[^"]*apply|jobApply|<footer/i);
        descriptionHtml = end !== -1 ? body.slice(0, end) : body.slice(0, 40000);
      }
    }
    return {
      locality,
      hiringOrgName: hiringOrgName || '',
      postedDate: datePosted ? parsePostedDate(datePosted) : null,
      descriptionHtml,
    };
  } catch (err) {
    console.warn(`   ⚠️ detail fetch failed (${listing.jobReqId}): ${err?.message || err}`);
    return null;
  }
}

/**
 * Fetch every listing page and return raw rows. Switzerland filter: NONE
 * required — Patek Philippe manufactures exclusively in Switzerland, recon
 * confirms every listed row is "<City>, CH".
 */
async function fetchJobListings() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const out = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const startrow = page * PAGE_SIZE;
    const pageUrl = startrow === 0
      ? CAREER_URL
      : `${CAREER_URL}?startrow=${startrow}`;
    let html;
    try {
      html = await fetchHtml(pageUrl, {
        headers: { 'User-Agent': CRAWLER_UA, Accept: 'text/html,application/xhtml+xml' },
        timeoutMs,
      });
    } catch (err) {
      console.error(`❌ Listing fetch failed (startrow=${startrow}): ${err?.message || err}`);
      break;
    }
    const rows = parseListingPage(html, pageUrl);
    if (rows.length === 0) {
      console.warn(`   ⚠️ Patek Philippe: page ${page} (startrow=${startrow}) parsed 0 rows — treating as end of pagination.`);
      break;
    }

    let added = 0;
    for (const row of rows) {
      if (seen.has(row.jobReqId)) continue;
      seen.add(row.jobReqId);
      out.push(row);
      added++;
    }
    if (added === 0 || rows.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  return out;
}

/**
 * Fetch all Patek Philippe jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllPatekPhilippeJobs() {
  console.log(`🔍 Fetching ${PATEK_PHILIPPE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url || CAREER_URL;

    // Enrich from the detail page (schema.org/JobPosting microdata):
    // datePosted, locality, hiringOrganization, full description body.
    const detail = await enrichFromDetail(listing, timeoutMs);

    const city = (detail && detail.locality) || listing.location.replace(/,\s*CH\s*$/i, '').trim() || HQ.city;
    const canton = inferSwissTargetCanton(city) || HQ.canton;

    // City-gated (NOT canton-gated) HQ fallback: only stamp the exact HQ
    // street/postal on a listing whose resolved city text actually is the
    // HQ city (Plan-les-Ouates) — never on canton equality, which would
    // incorrectly apply the manufacture street address to every job in GE
    // (e.g. Genève-based sales roles, a different city in the same canton).
    const isHqCity = !city || /plan-les-ouates/i.test(city);
    const streetAddress = isHqCity ? HQ.streetAddress : undefined;
    const postalCode = isHqCity ? HQ.postalCode : undefined;

    const descriptionHtml = (detail && detail.descriptionHtml) || '';
    // Detail page can surface widget chrome as the "description" body too —
    // sanitize before the length check so a widget-only block falls through
    // to the brand blurb instead of shipping as content.
    const descriptionText = sanitizeSuccessFactorsField(stripHtml(descriptionHtml));
    const description = descriptionText && descriptionText.length >= 40
      ? normalizeDescriptionBullets(descriptionText)
      : `${title} — ${PATEK_PHILIPPE_COMPANY_NAME}, ${city} (${canton}).`;

    const postedDate = (detail && detail.postedDate)
      || new Date().toISOString().split('T')[0];

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} patek philippe ${city}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const hiringOrgName = (detail && detail.hiringOrgName) || `${PATEK_PHILIPPE_COMPANY_NAME} SA`;

    const job = {
      // ── Required fields ──
      id: `${PATEK_PHILIPPE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PATEK_PHILIPPE_COMPANY_NAME,
      companyKey: PATEK_PHILIPPE_KEY,
      companyDomain: PATEK_PHILIPPE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Patek Philippe Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      hiringOrganization: hiringOrgName,
      addressLocality: city,
      postalCode,
      streetAddress,
      // Region = canton label (not the city name) — friendly HQ label for
      // Genève, plain canton code otherwise (same pattern as rolex-job-parser).
      addressRegion: canton === 'GE' ? 'Genève' : canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(`${title} ${listing.department || ''}`),
      employmentType: detectEmploymentType(`${listing.contract || ''} ${title}`),
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting / politeness
  }

  console.log(`\n📋 Total ${PATEK_PHILIPPE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { slugify, stripHtml };
