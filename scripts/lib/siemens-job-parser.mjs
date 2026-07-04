#!/usr/bin/env node
/**
 * Siemens (core industrial group, "Siemens AG") Switzerland job parser —
 * Avature ATS (portal "Siemens Careers Marketplace Global").
 *
 * Source: https://jobs.siemens.com/en_US/externaljobs/SearchJobs/
 *
 * NOTE ON ENTITY SCOPE — this parser is deliberately SEPARATE from
 * `scripts/lib/siemens-healthineers-job-parser.mjs`. Siemens Healthineers
 * was spun off from Siemens AG in 2018, has its own stock ticker (SHL), own
 * board, own careers site (careers.siemens-healthineers.com) and is a
 * legally/financially independent entity — not a subsidiary crawled twice.
 * They are two different employers. However both entities' postings are
 * served from the SAME shared Avature portal (`jobs.siemens.com`), so this
 * parser explicitly excludes any listing whose "Organization"/"Company"
 * field mentions Healthineers (see isHealthineersJob() below) to avoid
 * duplicating jobs already owned by the dedicated Healthineers crawler.
 *
 * ATS discovery: `templates-static-assets.avacdn.net` CDN + Avature meta
 * tags (`avature.portal.name="Siemens Careers Marketplace Global"`). No
 * Avature client exists in `./ats-clients/` (same as Deloitte/Emil Frey) —
 * parser scrapes server-rendered HTML directly (regex-based).
 *
 * Country filter discovery: the portal's search is a JS-driven "wizard"
 * form with dynamic Avature field IDs — plain query params (`?country=`,
 * `?location=`, etc.) are silently ignored server-side global unfiltered
 * results returned instead. real filtered listing URL was captured via
 * Playwright network trace of form submission, resolving field
 * `42386` (Country) to option id `812129` (Switzerland). resulting URL
 * is stable, session-less, plain curl-able:
 *   https://jobs.siemens.com/en_US/externaljobs/SearchJobs/
 *     ?42386=[812129]&42386_format=17546&listFilterMode=1
 *     &folderRecordsPerPage=6&folderOffset=N
 * Pagination via `folderOffset` (NOT `jobOffset` like Deloitte), fixed
 * page size 6 (attempts to raise `folderRecordsPerPage` had no effect).
 *
 * LOCATION HANDLING (deliberately conservative, no fabrication):
 * detail page carries EITHER a specific "Location(s)" field (list of
 * "City - Region - Country" entries) OR, for pan-European remote-eligible
 * roles, a "Any Siemens location in" field listing eligible COUNTRIES
 * (not cities). only "Location(s)" jobs whose entries include
 * an explicit "- Switzerland" segment are included — a job only eligible
 * "somewhere in Switzerland among 18 other countries" carries no real
 * Swiss city/address signal accepting would mean fabricating
 * a specific location for role that isn't actually anchored here. Jobs
 * with neither field (2 observed cases, req 493269/493275 — a Siemens
 * K.K. Japan-entity posting whose body text happens mention
 * "Any Siemens location in the world", a false-positive full-text search
 * match unrelated real Country filter field) are also skipped.
 *
 * SALARY: Siemens job descriptions embed boilerplate "Pay Transparency"
 * CHF salary text, but format inconsistent across postings (e.g.
 * "CHF 171.000" vs "CHF 171.00" the same figure — confirmed via hex
 * dump a genuine source-side inconsistency, not scraping/encoding bug).
 * parser deliberately does NOT attempt parse it; `salaryMin`/`salaryMax`
 * left unset so the central safe-default pipeline
 * (`hardenJobsWithStructuredSalary` → `estimateSwissSalary`) fills in
 * canton-aware estimates, consistent with how Deloitte/IKEA/Baloise
 * parsers already behave.
 *
 * Exports:
 * - fetchAllSiemensJobs() — main entry point
 * - isSiemensJob() — Match jobs belonging Siemens (excl. Healthineers)
 * - isTrustedDomain() — Validate URLs belong Siemens' domain
 * - SIEMENS_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* Constants ─────────────────────────────────────────────── */

export const SIEMENS_KEY = 'siemens';
export const SIEMENS_COMPANY_NAME = 'Siemens';
export const SIEMENS_COMPANY_DOMAIN = 'siemens.com';

const LISTING_HOST = 'https://jobs.siemens.com';
const LISTING_BASE = `${LISTING_HOST}/en_US/externaljobs/SearchJobs/`;
const CAREER_URL = LISTING_BASE;
const COUNTRY_FIELD_ID = '42386';
const SWITZERLAND_OPTION_ID = '812129';
const FORMAT_TOKEN = '17546';
const PAGE_SIZE = 6;
const MAX_PAGES = 20; // safety cap (~120 jobs); portal currently lists ~70 CH matches

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── HQ fallback (Siemens Schweiz AG, Freilagerstrasse 40, 8047 Zürich) ──
 * Confirmed via Zefix (Swiss commercial registry, EHRAID 368195,
 * UID CHE-103.109.444) — legal seat Zürich. */

const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8047',
  streetAddress: 'Freilagerstrasse 40',
  region: 'ZH',
};

const SECTOR = 'Industria e tecnologia (automazione, energia, infrastrutture digitali)';

/* ── Text helpers ─────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').toLowerCase().trim();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß').replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è')
    .replace(/&agrave;/g, 'à').replace(/&ccedil;/g, 'ç')
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    });
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * true if job's Organization/Company field (or job.company text) mentions
 * Siemens Healthineers — the shared portal serves both entities, and the
 * dedicated `siemens-healthineers-job-parser.mjs` already owns those jobs.
 */
function isHealthineersText(text = '') {
  return /healthineers/i.test(String(text || ''));
}

/**
 * Check if job belongs Siemens (core industrial group), NOT Healthineers.
 * Used by template filter company's jobs global dataset.
 */
export function isSiemensJob(job) {
  if (!job) return false;
  const company = normalize(job.company || '');
  if (isHealthineersText(company)) return false;

  const key = normalize(job.companyKey || job.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const url = normalize(job.url || '');
  if (isHealthineersText(url)) return false;

  return (
    key === SIEMENS_KEY ||
    (key.startsWith('siemens') && !key.startsWith('siemens-healthineers')) ||
    (company.includes('siemens') && !isHealthineersText(company)) ||
    url.includes('jobs.siemens.com')
  );
}

/**
 * Validate URL belongs Siemens' domain (jobs.siemens.com subdomain of
 * siemens.com, so `.endsWith('.siemens.com')` already covers it — and
 * does NOT accidentally match siemens-healthineers.com, a distinct host).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'siemens.com' || host.endsWith('.siemens.com');
  } catch {
    return false;
  }
}

/* ── Category / Experience / Employment detection ──────────── */

// Siemens "Field of work" values → existing Italian category taxonomy.
function detectCategory(title = '', fieldOfWork = '') {
  const fow = normalize(fieldOfWork);
  const t = normalize(title);

  if (/engineering|research.*development|product management/.test(fow)) return 'Ingegneria';
  if (/information technology/.test(fow)) return 'IT';
  if (/manufacturing/.test(fow)) return 'Produzione';
  if (/sales/.test(fow)) return 'Commerciale';
  if (/marketing/.test(fow)) return 'Marketing';
  if (/finance/.test(fow)) return 'Finanza';
  if (/people.*organization/.test(fow)) return 'Risorse Umane';
  if (/customer services|internal services|project management|general management/.test(fow)) return 'Amministrazione';

  if (/\b(ingegner|engineer|technic|développ|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(software|it |informatic|developer|cloud|data)/.test(t)) return 'IT';
  if (/\b(vendit|sales|commercial|account)/.test(t)) return 'Commerciale';
  return 'Altro';
}

function detectExperienceLevel(experienceLevelRaw = '') {
  const raw = normalize(experienceLevelRaw);
  if (/student/.test(raw)) return 'intern';
  if (/early professional/.test(raw)) return 'junior';
  if (/mid-level/.test(raw)) return 'mid';
  if (/experienced professional/.test(raw)) return 'senior';
  return 'mid';
}

// Siemens "Job type" values observed: "Full-time", "Full-time/Part-time"
// (combined string meaning either possible — no explicit % signal, so
// treated as full-time by default rather than fabricating a part-time
// percentage). Only an exact "Part-time" (alone) maps to PART_TIME.
function detectEmploymentType(jobTypeRaw = '') {
  const raw = normalize(jobTypeRaw);
  if (raw === 'part-time') return 'PART_TIME';
  return 'FULL_TIME';
}

// "Posted since" format: "29-Jun-2026" → "2026-06-29"
const MONTH_ABBR = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
function parsePostedDate(raw = '') {
  const m = String(raw || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return '';
  const mon = MONTH_ABBR[m[2].toLowerCase()];
  if (!mon) return '';
  return `${m[3]}-${mon}-${m[1].padStart(2, '0')}`;
}

/* ── Address Resolution ─────────────────────────────────────
 * Given a single "City - Region - Country" Location(s) entry already
 * confirmed to end with "Switzerland", resolve city/canton/postal/street.
 * HQ street/postal fallback ONLY applied when the resolved canton is
 * Zürich (canton-gated, never unconditional — see Deloitte's identical
 * pattern / the yapeal-job-parser.mjs regression this guards against). */
function resolveAddress(locationEntry = '') {
  const parts = locationEntry.split('-').map((s) => s.trim()).filter(Boolean);
  // "City - Region - Switzerland" (3 segments) or "City - Switzerland" (2)
  const city = parts[0] || HQ.city;
  const canton = inferSwissTargetCanton(locationEntry) || inferSwissTargetCanton(city);

  if (!canton) {
    return { city, canton: HQ.canton, postalCode: '', streetAddress: '', region: HQ.region };
  }

  const isHqCity = /z[üu]rich/i.test(city);
  return {
    city,
    canton,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
    region: canton,
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Parse one `<article class="article article--result N">` listing block
 * into a stub. Returns null if no JobDetail URL/title found.
 */
function parseListingArticle(block) {
  const urlMatch = block.match(
    /href="(https:\/\/jobs\.siemens\.com\/en_US\/externaljobs\/JobDetail\/[^"]+)"/i,
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
 * Extract a labelled `article__content__view__field` simple-text value
 * from a Siemens detail page (e.g. label "Company" → value "Siemens
 * Schweiz AG"). NOT used for "Location(s)" (nested <ul><li> markup — see
 * extractLocationField() below).
 */
function extractField(html, labelText) {
  const escaped = labelText
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const re = new RegExp(
    `field__label"\\s*>\\s*${escaped}\\s*<\\/div>[\\s\\S]*?field__value">([\\s\\S]*?)<\\/div>`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeHtmlEntities(stripHtml(m[1])).trim() : '';
}

/**
 * Extract the "Location(s)" field's <li> entries, but ONLY if the field
 * label is literally "Location(s)" (specific city/region/country tuples).
 * Returns null if the field is absent, OR if it's the "Any Siemens
 * location in" variant (country-eligibility list — no specific city
 * signal, deliberately not resolved into a fabricated Swiss location).
 */
function extractLocationEntries(html) {
  // Anchor directly on the "Location(s)" label text (the "tf_locations"
  // field carries EITHER this label or the "Any Siemens location in"
  // variant — only the former has real city-level signal). Anchoring on
  // the literal label text (rather than "the first field__label on the
  // page") avoids the value being bounded across unrelated fields.
  const labelMatch = html.match(/field__label"\s*>\s*(Location\(s\)|Any Siemens location in)\s*<\/div>/i);
  if (!labelMatch) return null;
  if (!/^location\(s\)$/i.test(labelMatch[1].trim())) return null;

  const rest = html.slice(labelMatch.index + labelMatch[0].length);
  const ulMatch = rest.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
  if (!ulMatch) return null;

  const items = [...ulMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => normalizeSpace(decodeHtmlEntities(stripHtml(m[1]))))
    .filter(Boolean);
  return items.length ? items : null;
}

/**
 * Extract the job description HTML from the `id="section1__content"`
 * block (distinct from `section0__content` structured fields and the
 * typically-empty `section2__content`).
 */
function extractDescriptionHtml(html) {
  const idx = html.indexOf('id="section1__content"');
  if (idx === -1) return '';
  // Slice past the END of the opening tag (its own closing `>`), not just
  // the attribute — otherwise the orphaned `id="section1__content" >`
  // fragment (no leading `<`, so stripHtml's `/<[^>]+>/g` can't match it)
  // leaks verbatim into the extracted description text.
  const tagEndIdx = html.indexOf('>', idx);
  if (tagEndIdx === -1) return '';
  const rest = html.slice(tagEndIdx + 1);
  const articleEndIdx = rest.search(/<\/article>/i);
  return articleEndIdx === -1 ? rest : rest.slice(0, articleEndIdx);
}

/**
 * Fetch one detail page pull out structured fields + description.
 * Returns null (never throws) if fetch fails — caller skips the job.
 */
async function fetchJobDetail(url) {
  let html;
  try {
    html = await fetchHtml(url, { headers: { 'User-Agent': BROWSER_UA } });
  } catch (err) {
    console.warn(`  ⚠️ detail fetch failed (${url}): ${err && err.message ? err.message : err}`);
    return null;
  }

  return {
    jobId: extractField(html, 'Job ID'),
    postedSinceRaw: extractField(html, 'Posted since'),
    organization: extractField(html, 'Organization'),
    fieldOfWork: extractField(html, 'Field of work'),
    company: extractField(html, 'Company'),
    experienceLevelRaw: extractField(html, 'Experience level'),
    jobTypeRaw: extractField(html, 'Job type'),
    locationEntries: extractLocationEntries(html),
    descriptionHtml: extractDescriptionHtml(html),
  };
}

/**
 * Fetch all listing stubs across every paginated results page.
 */
async function fetchAllListingStubs() {
  const byUrl = new Map();
  let total = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const pageUrl =
      `${LISTING_BASE}?${COUNTRY_FIELD_ID}=%5B${SWITZERLAND_OPTION_ID}%5D` +
      `&${COUNTRY_FIELD_ID}_format=${FORMAT_TOKEN}&listFilterMode=1` +
      `&folderRecordsPerPage=${PAGE_SIZE}&folderOffset=${offset}`;
    let html;
    try {
      html = await fetchHtml(pageUrl, { headers: { 'User-Agent': BROWSER_UA } });
    } catch (err) {
      console.warn(`  ⚠️ listing page fetch failed (${pageUrl}): ${err && err.message ? err.message : err}`);
      break;
    }

    const legendMatch = html.match(/list-controls__text__legend[^>]*>([\s\S]{0,200}?)<\/div>/i);
    if (legendMatch) {
      const totalMatch = legendMatch[1].match(/of\s+(\d+)/i);
      if (totalMatch) total = Number(totalMatch[1]);
    }

    const blocks = html.match(/<article class="article article--result[^"]*"[\s\S]*?<\/article>/gi) || [];
    let added = 0;
    for (const block of blocks) {
      const stub = parseListingArticle(block);
      if (!stub || byUrl.has(stub.url)) continue;
      byUrl.set(stub.url, stub);
      added++;
    }

    console.log(`  📄 page offset=${offset}: +${added} (collected ${byUrl.size}${total ? `/${total}` : ''})`);

    if (blocks.length === 0 || added === 0) break;
    if (total && byUrl.size >= total) break;
  }

  return [...byUrl.values()];
}

/**
 * Fetch all Siemens (core, non-Healthineers) Switzerland jobs.
 * Returns an array of parsed job objects ready for the standard pipeline.
 */
export async function fetchAllSiemensJobs() {
  console.log('  🌐 Siemens (Avature, jobs.siemens.com) — fetching Switzerland-filtered listing…');
  const stubs = await fetchAllListingStubs();
  console.log(`  🔗 ${stubs.length} job detail pages to enrich`);

  const jobs = [];
  let skippedHealthineers = 0;
  let skippedNoLocation = 0;

  for (const stub of stubs) {
    const detail = await fetchJobDetail(stub.url);
    await new Promise((r) => setTimeout(r, 200));
    if (!detail) continue;

    if (isHealthineersText(detail.organization) || isHealthineersText(detail.company)) {
      skippedHealthineers++;
      continue;
    }

    // Only include jobs with a specific "Location(s)" field whose entries
    // include an explicit "- Switzerland" segment. Country-eligibility-only
    // fields ("Any Siemens location in") or missing-location jobs (false
    // positive full-text search matches) are skipped — no fabrication.
    const swissEntries = (detail.locationEntries || []).filter((entry) =>
      /switzerland\s*$/i.test(entry),
    );
    if (!swissEntries.length) {
      skippedNoLocation++;
      continue;
    }

    const primaryEntry = swissEntries[0];
    const { city, canton, postalCode, streetAddress, region } = resolveAddress(primaryEntry);
    const location = normalizeSpace(city || HQ.city);

    const descriptionText = normalizeSpace(stripHtml(detail.descriptionHtml || ''));
    const description =
      descriptionText ||
      `${stub.title} presso Siemens Svizzera, sede a ${location}. Siemens è un gruppo industriale e tecnologico globale attivo in automazione, energia e infrastrutture digitali. Candidati su jobs.siemens.com.`;

    const publicUrl = stub.url || CAREER_URL;
    const sourceLang = detectLang(descriptionText || stub.title, 'en');
    const jobSlug = slugify(`${stub.title} siemens ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(detail.jobTypeRaw || '');
    const postedDate =
      parsePostedDate(detail.postedSinceRaw) || new Date().toISOString().split('T')[0];
    const companyLabel = normalizeSpace(detail.company) || SIEMENS_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `${SIEMENS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SIEMENS_COMPANY_NAME,
      companyKey: SIEMENS_KEY,
      companyDomain: SIEMENS_COMPANY_DOMAIN,
      title: stub.title,
      titleByLocale: { [sourceLang]: stub.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Siemens Dedicated Parser (Avature)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(stub.title, detail.fieldOfWork),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(detail.experienceLevelRaw),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: detail.jobId || stub.jobReqId || null,
      hiringOrganizationName: companyLabel,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(
    `  ✅ ${jobs.length} Siemens CH jobs parsed (skipped ${skippedHealthineers} Healthineers, ${skippedNoLocation} no-specific-Swiss-location)`,
  );
  return jobs;
}
