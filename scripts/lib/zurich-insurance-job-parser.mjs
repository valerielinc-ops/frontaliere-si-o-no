#!/usr/bin/env node
/**
 * Zurich Insurance Group job parser — Fetcher and job builder.
 *
 * Source: https://careers.zurich.com (SuccessFactors / jobs2web SSR overlay)
 *
 * Zurich Insurance does NOT use Workday — the public-facing ATS is the
 * SuccessFactors-powered jobs2web search at `careers.zurich.com/search/`.
 * The previous Workday-based fetcher returned HTTP 422 for every request
 * because the `zurich.wd3.myworkdayjobs.com` tenant is a maintenance
 * shell with no live career site behind it.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllZurichInsuranceJobs() — Fetch and parse all jobs
 *   - isZurichInsuranceJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()             — Validate URLs belong to this company
 *   - ZURICH_INSURANCE_KEY / ZURICH_INSURANCE_COMPANY_NAME — re-exported by the runner
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ZURICH_INSURANCE_KEY = 'zurich-insurance-sede-ticino';
export const ZURICH_INSURANCE_COMPANY_NAME = 'Zurich Insurance (sede Ticino)';
export const ZURICH_INSURANCE_COMPANY_DOMAIN = 'zurich.com';

const CAREER_HOST = 'https://careers.zurich.com';
const CAREER_BASE_URL = `${CAREER_HOST}/search/`;

// SuccessFactors / jobs2web search-page rows are 25 per page. Cap the walk at
// 6 pages × 25 = 150 jobs to keep the run polite. Zurich Insurance ships
// 40-60 open CH roles at any time, so 150 is comfortably above the headroom.
const MAX_PAGES = 6;
const PAGE_SIZE = 25;
const PAGE_DELAY_MS = 1500;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Switzerland-only listings — `locationsearch=Switzerland` returns the full
 * national board (~42 roles) on one query so we don't need per-city seeds
 * that double-count Ticino jobs across canton-name variants.
 */
const SEARCH_LOCATION = 'Switzerland';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isZurichInsuranceJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ZURICH_INSURANCE_KEY ||
    key === 'zurich-insurance' ||
    key.startsWith('zurich-insurance') ||
    company.includes('zurich insurance') ||
    url.includes('careers.zurich.com')
  );
}

/**
 * Validate that a URL belongs to Zurich Insurance Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'zurich.com' ||
      host.endsWith('.zurich.com') ||
      host === 'zurichinsurance.ch' ||
      host.endsWith('.zurichinsurance.ch') ||
      host === 'careers.zurich.com' ||
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
  if (/\b(finanz|finance|financ|audit|underwrit|actuar|risk)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|young.*professional)/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|principal)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  // Many Zurich titles end with "80-100%" or "60-80%" — the second band
  // is part-time-only. Treat 100% (or "100" alone) as full-time.
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)\b/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)\b/.test(t)) return 'FULL_TIME';
  if (/\b100\s*%/.test(t)) return 'FULL_TIME';
  if (/\b(\d{1,2})\s*-\s*(\d{1,2})\s*%/.test(t)) {
    const m = t.match(/\b(\d{1,2})\s*-\s*(\d{1,2})\s*%/);
    if (m && Number(m[2]) >= 90) return 'FULL_TIME';
    return 'PART_TIME';
  }
  return 'OTHER';
}

/* ── Date parsing (search-row "Apr 27, 2026" + detail-page itemprop) ── */

const MONTH_MAP = new Map(
  [
    ['jan', 0], ['feb', 1], ['mar', 2], ['apr', 3], ['may', 4], ['jun', 5],
    ['jul', 6], ['aug', 7], ['sep', 8], ['oct', 9], ['nov', 10], ['dec', 11],
  ],
);

function parseSearchRowDate(raw = '') {
  const s = normalizeSpace(raw);
  if (!s) return null;
  // "Apr 27, 2026"
  const m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return new Date(t).toISOString().split('T')[0];
    return null;
  }
  const month = MONTH_MAP.get(m[1].toLowerCase());
  if (month === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month, day));
  return d.toISOString().split('T')[0];
}

/* ── HTML helpers (self-contained — no SF-client dependency) ────────── */

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s = '') {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

/* ── Listing parser ──────────────────────────────────────────────────── */

/**
 * Parse the SuccessFactors/jobs2web search-results page HTML.
 * Each result row has:
 *   <a class="jobTitle-link" href="/job/{cityWithDiacritics}-{slug}/{numericId}/">{title}</a>
 *   <span class="jobLocation">{City, CH}</span>
 *   <span class="jobDate">{Mon DD, YYYY}</span>
 *
 * Returns an array of partial listings — the detail page is fetched
 * separately to enrich each row with body + datePosted (microdata).
 *
 * @param {string} html
 * @returns {Array<{title:string, url:string, jobId:string, location:string, postedAt:string|null}>}
 */
export function parseSearchPage(html = '') {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const rowHtml = rm[1];
    const link = rowHtml.match(/<a[^>]+class="jobTitle-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const idMatch = link[1].match(/\/job\/[^/]+\/(\d+)\/?/);
    if (!idMatch) continue;
    const jobId = idMatch[1];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const relativeUrl = decodeEntities(link[1]).split('#')[0];
    const url = relativeUrl.startsWith('http')
      ? relativeUrl
      : `${CAREER_HOST}${relativeUrl}`;
    const title = normalizeSpace(decodeEntities(stripTags(link[2])));
    if (!title || title.length < 3) continue;

    const locMatch = rowHtml.match(/<span class="jobLocation">\s*([^<]+?)\s*</i);
    const location = locMatch ? normalizeSpace(decodeEntities(locMatch[1])) : '';

    const dateMatch = rowHtml.match(/<span class="jobDate"[^>]*>\s*([^<]+?)\s*</i);
    const postedAt = dateMatch ? parseSearchRowDate(dateMatch[1]) : null;

    out.push({ title, url, jobId, location, postedAt });
  }
  return out;
}

/**
 * Parse the microdata-rich SF detail page.
 * @param {string} html
 * @returns {{datePosted:string|null, location:string, descriptionHtml:string}}
 */
export function parseDetailPage(html = '') {
  if (!html) return { datePosted: null, location: '', descriptionHtml: '' };

  let datePosted = null;
  const dateMeta = html.match(/<meta\s+itemprop="datePosted"\s+content="([^"]+)"/i);
  if (dateMeta) {
    const t = Date.parse(dateMeta[1]);
    if (Number.isFinite(t)) datePosted = new Date(t).toISOString().split('T')[0];
  }

  let location = '';
  const addrMeta = html.match(/<meta\s+itemprop="streetAddress"\s+content="([^"]+)"/i);
  if (addrMeta) location = normalizeSpace(decodeEntities(addrMeta[1]));

  // Description body: <span class="jobdescription">…</span>. The block is
  // deeply nested, so capture to the next structural sibling boundary used
  // by the SF templates (the "applylink" / "job-actions" wrapper) rather
  // than relying on lazy </span> matching.
  let descriptionHtml = '';
  const descAnchor = html.search(/<span class="jobdescription">/i);
  if (descAnchor !== -1) {
    const slice = html.slice(descAnchor);
    const endMarker = slice.search(/<div[^>]*class="[^"]*(?:applylink|apply|job-actions|jobDetailFooter)[^"]*"|<footer\b/i);
    descriptionHtml = endMarker !== -1 ? slice.slice(0, endMarker) : slice.slice(0, 20000);
  }

  return { datePosted, location, descriptionHtml };
}

/* ── Crawler ─────────────────────────────────────────────────────────── */

async function fetchPage(url) {
  return fetchHtml(url, {
    timeoutMs: 20000,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,it-CH;q=0.7,de-CH;q=0.6,fr-CH;q=0.5',
    },
  });
}

async function fetchAllListings() {
  const out = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const startRow = page * PAGE_SIZE;
    const url = `${CAREER_BASE_URL}?createNewAlert=false&q=&locationsearch=${encodeURIComponent(SEARCH_LOCATION)}&startrow=${startRow}`;
    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.warn(`⚠️ Page ${page + 1} fetch failed: ${err?.message || err}`);
      break;
    }
    const rows = parseSearchPage(html);
    if (rows.length === 0) break;

    let added = 0;
    for (const row of rows) {
      if (seen.has(row.jobId)) continue;
      seen.add(row.jobId);
      out.push(row);
      added += 1;
    }
    if (added < rows.length && added === 0) break; // page repeated → stop
    if (rows.length < PAGE_SIZE) break;
    if (page < MAX_PAGES - 1) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  }
  return out;
}

/* ── Public fetcher ──────────────────────────────────────────────────── */

/**
 * The slice is `zurich-insurance-sede-ticino` — the SEO target is Ticino-frontalieri.
 * We fetch the Switzerland-wide listing (Zurich Insurance has no per-canton facet
 * on the SF jobs2web search), then keep only roles whose location places them
 * inside the cross-border catchment that frontalieri actually commute to.
 *
 * TI / GR (and a sliver of VS bordering Italy) is the Sede Ticino catchment.
 */
const SEDE_TICINO_LOCATION_REGEX =
  /\b(ticino|tessin|tessina|lugano|bellinzona|locarno|chiasso|mendrisio|biasca|airolo|paradiso|massagno|tenero|gordola|melide|stabio|caslano|cadempino|manno|grancia|paradiso|grigioni|graub[üu]nden|grisons|grischun|chur|coira|davos|st\.?\s*moritz|samedan|poschiavo|bormio|valais|wallis)\b/i;

function isSedeTicinoLocation(loc = '') {
  return SEDE_TICINO_LOCATION_REGEX.test(String(loc || ''));
}

/**
 * Fetch all Zurich Insurance Group jobs in the Sede Ticino catchment (TI / GR).
 *
 * Strategy: hit `locationsearch=Switzerland` to enumerate every public CH role
 * (the per-canton facet is unsupported by the SF jobs2web SSR overlay), then
 * filter rows whose canton resolves to TI/GR/VS or whose location string
 * matches a known cross-border city. This preserves the location-filter
 * contract while bypassing the broken Workday tenant.
 */
export async function fetchAllZurichInsuranceJobs() {
  console.log(`🔍 Fetching Zurich Insurance Group jobs`);
  console.log(`   Source: ${CAREER_BASE_URL}?locationsearch=${SEARCH_LOCATION}\n`);

  const listings = await fetchAllListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned from careers.zurich.com.');
    return [];
  }

  console.log(`  📋 Listings found (Switzerland-wide): ${listings.length}`);

  // Pre-filter by listing-row location before paying for detail fetches.
  const ticinoListings = listings.filter((row) => {
    if (isSedeTicinoLocation(row.location)) return true;
    const canton = inferSwissTargetCanton(row.location || '');
    return canton === 'TI' || canton === 'GR' || canton === 'VS';
  });
  console.log(`  🎯 Sede Ticino (TI/GR/VS) matches: ${ticinoListings.length}`);

  const jobs = [];
  for (const listing of ticinoListings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // Enrich with detail page (datePosted microdata + description body).
    let detailHtml = '';
    try {
      detailHtml = await fetchPage(listing.url);
    } catch (err) {
      console.warn(`  ⚠️ Skipping detail fetch for ${listing.url}: ${err?.message || err}`);
    }
    const detail = parseDetailPage(detailHtml);

    const location = detail.location || listing.location || 'Zürich';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const descriptionText = stripHtml(detail.descriptionHtml || '');
    const publicUrl = listing.url;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} zurich-insurance ${listing.jobId}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const postedDate =
      detail.datePosted ||
      listing.postedAt ||
      new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `zurich-insurance-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      slugDisambiguator: listing.jobId,
      company: 'Zurich Insurance Group',
      companyKey: ZURICH_INSURANCE_KEY,
      companyDomain: ZURICH_INSURANCE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Zurich Insurance Group`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Zurich Insurance Group` },
      location,
      canton,
      url: publicUrl,
      source: 'Zurich Insurance careers.zurich.com SuccessFactors parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Assicurazioni',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Polite rate limit between detail fetches.
  }

  console.log(`\n📋 Total Zurich Insurance Group jobs discovered: ${jobs.length}`);
  return jobs;
}
