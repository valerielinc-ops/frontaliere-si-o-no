#!/usr/bin/env node
/**
 * Rolex job parser — Fetcher and job builder.
 *
 * Source: https://www.carrieres-rolex.com/Rolex/go/Toutes-nos-offres-Rolex/2901501/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRolexJobs()  — Fetch and parse all jobs
 *   - isRolexJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { parseSuccessFactorsPostedDate } from './ats-clients/successfactors-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ROLEX_KEY = 'rolex';
export const ROLEX_COMPANY_NAME = 'Rolex';
export const ROLEX_COMPANY_DOMAIN = 'rolex.com';

/**
 * Rolex recruits on SAP SuccessFactors RMK (jobs2web) at carrieres-rolex.com
 * — a server-rendered HTML career site (NOT the SF OData/CXS JSON API). The
 * listing is a paginated <table> of <tr class="data-row"> rows; each row links
 * to a /Rolex/job/<slug>/<jobId>/ detail page carrying schema.org/JobPosting
 * MICRODATA (itemprop, not JSON-LD). Pagination is a PATH SEGMENT after the
 * listing id: /2901501/{startrow}/ with startrow in {0,25,50,...} (25/page).
 *
 * The tenant is CH-only (the only Site facets are Genève / Bienne / Fribourg),
 * so no Switzerland filter is required. Tudor (sister brand) shares this tenant.
 */
const CAREER_BASE = 'https://www.carrieres-rolex.com/Rolex/go/Toutes-nos-offres-Rolex/2901501';
const CAREER_URL = `${CAREER_BASE}/`;
const ATS_ORIGIN = 'https://www.carrieres-rolex.com';
const PAGE_SIZE = 25;
const MAX_PAGES = 20; // safety cap (151 jobs ≈ 7 pages)

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
 * Check if a job belongs to Rolex.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRolexJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ROLEX_KEY ||
    key.startsWith('rolex') ||
    company.includes('rolex') ||
    url.includes('rolex.com')
  );
}

/**
 * Validate that a URL belongs to Rolex's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      // Primary brand domain (+ subdomains) — keep for the unit test.
      host === 'rolex.com' ||
      host.endsWith('.rolex.com') ||
      // Real ATS posting host (SuccessFactors RMK / jobs2web career site).
      host === 'carrieres-rolex.com' ||
      host.endsWith('.carrieres-rolex.com') ||
      // SuccessFactors profile/apply entry (career5.successfactors.eu).
      host.endsWith('.successfactors.eu') ||
      host.endsWith('.successfactors.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(stage|stagiair|intern|praktik|apprenti|apprendist)/.test(t)) return 'INTERN';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  // Rolex listing "CONTRAT" column: CDI (permanent) / CDD (fixed-term) ⇒ full-time.
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
 * Parse one career-site listing page into raw listing rows.
 * Each <tr class="data-row"> carries:
 *   - a.jobTitle-link[href=/Rolex/job/<slug>/<jobId>/]  → title + url + jobReqId
 *   - span.jobDepartment                                → domaine d'activité (category hint)
 *   - span.jobFacility                                  → Site (city, all CH)
 *   - span.jobShifttype                                 → contrat (CDI/CDD/Stage/Apprentissage)
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
    const link = row.match(/<a[^>]+href="(\/Rolex\/job\/[^"]+\/(\d+)\/?)"[^>]*class="jobTitle-link"/i)
      || row.match(/<a[^>]+class="jobTitle-link"[^>]*href="(\/Rolex\/job\/[^"]+\/(\d+)\/?)"/i);
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

    const department = (row.match(/class="jobDepartment[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    const facility = (row.match(/class="jobFacility[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    const shifttype = (row.match(/class="jobShifttype[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];

    out.push({
      title,
      url,
      jobReqId,
      location: facility ? textOf(facility) : '',
      department: department ? textOf(department) : '',
      contract: shifttype ? textOf(shifttype) : '',
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
    const locality = microdata(html, 'addressLocality');
    const country = microdata(html, 'addressCountry');
    const datePosted = microdata(html, 'datePosted');
    let descriptionHtml = '';
    const descAnchor = html.search(/itemprop="description"/i);
    if (descAnchor !== -1) {
      const slice = html.slice(descAnchor);
      const open = slice.indexOf('>');
      if (open !== -1) {
        // Description block sits in a span/div after the itemprop tag; grab a
        // generous window up to the apply/footer region.
        const body = slice.slice(open + 1);
        const end = body.search(/<\/section>|class="[^"]*apply|jobApply|<footer/i);
        descriptionHtml = end !== -1 ? body.slice(0, end) : body.slice(0, 40000);
      }
    }
    return {
      locality: locality || '',
      country: country || '',
      postedDate: datePosted ? parseSuccessFactorsPostedDate(datePosted) : null,
      descriptionHtml,
    };
  } catch (err) {
    console.warn(`   ⚠️ detail fetch failed (${listing.jobReqId}): ${err?.message || err}`);
    return null;
  }
}

/**
 * Fetch every listing page (path-segment pagination) and return raw rows.
 * Switzerland filter: NONE required — the tenant is 100% CH (recon).
 */
async function fetchJobListings() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const out = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const startrow = page * PAGE_SIZE;
    const pageUrl = startrow === 0 ? CAREER_URL : `${CAREER_BASE}/${startrow}/`;
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
      // Fetch succeeded but parsed to zero rows — could be genuine EOF or a
      // challenge/error page rendered with a 200 status. Warn so a sustained
      // pattern is visible, since we can't tell the two apart here.
      console.warn(`   ⚠️ Rolex: page ${page} (startrow=${startrow}) parsed 0 rows — treating as end of pagination.`);
      break;
    }

    let added = 0;
    for (const row of rows) {
      if (seen.has(row.jobReqId)) continue;
      seen.add(row.jobReqId);
      out.push(row);
      added++;
    }
    // Last page reached (no new rows, or a short page).
    if (added === 0 || rows.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  return out;
}

/**
 * Fetch all Rolex jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllRolexJobs() {
  console.log(`🔍 Fetching Rolex jobs`);
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
    // datePosted, addressLocality, addressCountry, full description body.
    const detail = await enrichFromDetail(listing, timeoutMs);

    // Switzerland-only guard: the tenant is 100% CH, but if a detail page ever
    // reports a non-CH country, drop it (belt-and-suspenders per recon).
    if (detail && detail.country && detail.country.toUpperCase() !== 'CH') {
      console.log(`   ⏭️ skipping non-CH job: ${title} (${detail.country})`);
      continue;
    }

    const location = (detail && detail.locality) || listing.location || 'Genève';
    const canton = inferSwissTargetCanton(location) || 'GE'; // HQ fallback: Genève

    const descriptionHtml = (detail && detail.descriptionHtml) || '';
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText && descriptionText.length >= 40
      ? descriptionText
      : `${title} — ${ROLEX_COMPANY_NAME}, ${location} (${canton}).`;

    const postedDate = (detail && detail.postedDate)
      || new Date().toISOString().split('T')[0];

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} rolex ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `rolex-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ROLEX_COMPANY_NAME,
      companyKey: ROLEX_KEY,
      companyDomain: ROLEX_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Rolex Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: canton === 'GE' ? '1211' : undefined, // HQ postal (Genève)
      // Region = canton (not the city name). For non-GE jobs the old
      // `: location` branch leaked the city into addressRegion (#1720 item 3,
      // same class as decathlon). Keep the friendly 'Genève' label for the GE HQ.
      addressRegion: canton === 'GE' ? 'Genève' : canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(`${title} ${listing.department || ''}`),
      employmentType: detectEmploymentType(`${listing.contract || ''} ${title}`),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Luxury / Watchmaking (Manufacturing)',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting / politeness
  }

  console.log(`\n📋 Total Rolex jobs discovered: ${jobs.length}`);
  return jobs;
}
