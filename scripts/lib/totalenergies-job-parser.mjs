#!/usr/bin/env node
/**
 * TotalEnergies Switzerland job parser — Avature ATS (portal "Careers", id 4).
 *
 * Source: https://jobs.totalenergies.com/en_US/careers/SearchJobs
 *
 * TotalEnergies is a French multinational energy/oil-and-gas company. The
 * company table entry that triggered this crawler ("Mex (VD)") refers to
 * TotalEnergies Marketing Switzerland, the aviation-fuel/lubricants
 * marketing entity headquartered in Mex VD — but that entity currently has
 * ZERO open postings on the global ATS. The Swiss jobs that DO exist on the
 * portal all belong to the Geneva-based trading arm (TOTSA TotalEnergies
 * Trading SA / TotalEnergies Gas & Power Ltd), operating out of the World
 * Trade Center Geneva ("GENEVE-WTC1" workplace code). This parser scopes
 * to whatever Switzerland-tagged jobs the ATS actually publishes — it does
 * not fabricate Mex VD postings that don't exist.
 *
 * ATS discovery: the careers site is powered by Avature (portal meta tags
 * `avature.portal.id=4`, `avature.portal.name="Careers"`, CDN
 * `templates-static-assets.avacdn.net`). No shared Avature client exists in
 * `./` (see deloitte-job-parser.mjs's own docblock) — this parser
 * hand-rolls the same regex-based HTML scrape pattern, consistent with the
 * rest of the codebase (no cheerio/jsdom).
 *
 * The global tenant lists jobs across 130+ countries with no reliable
 * country facet reachable via plain GET (the Country select field, id 3834,
 * is populated client-side via a select2/AJAX widget — a bare
 * `?3834=[Switzerland]` querystring override was tested and silently
 * ignored, returning the unfiltered global default page). The free-text
 * keyword search `?search=Switzerland&listFilterMode=1&jobRecordsPerPage=50`
 * was found to return a small, accurate candidate set (13 rows) that nearly
 * matches the true country facet — cross-checked against every row's own
 * structured `Country` detail-page field. One false positive was found this
 * way (a Madrid-based VIE role that only text-matched because it was
 * paired with a Swiss sibling posting) and is defensively dropped by
 * `isSwissLocation()` below, mirroring the same post-filter discipline used
 * by the IKEA/Deloitte parsers for their own broad initial fetches.
 *
 * Each listing row links to a JobDetail page whose numeric trailing URL
 * segment (e.g. `/JobDetail/.../82058`) is the canonical job id. The detail
 * page carries a structured `<dt class="…field__label">`/`<dd
 * class="…field__value">` block (Country, City, Workplace location,
 * Employer company, Domain, Type of contract, Experience) plus several
 * `<h3>`-headed rich-text sections (Context & Environment, Activities,
 * Candidate Profile, Additional Information …). No schema.org JobPosting
 * JSON-LD is embedded on this tenant's detail pages (unlike Deloitte's) —
 * all structured fields must come from the label/value block.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllTotalEnergiesJobs()  — Fetch and parse all Swiss-scoped jobs
 *   - isTotalEnergiesJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()            — Validate URLs belong to this company
 *   - TOTALENERGIES_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const TOTALENERGIES_KEY = 'totalenergies';
export const TOTALENERGIES_COMPANY_NAME = 'TotalEnergies';
export const TOTALENERGIES_COMPANY_DOMAIN = 'totalenergies.com';

const LISTING_BASE = 'https://jobs.totalenergies.com/en_US/careers/SearchJobs/';
const CAREER_URL = LISTING_BASE;
// Free-text keyword scope (see docblock) — the only reliable quota-free way
// to narrow this 130+-country tenant to Switzerland-relevant postings.
const SEARCH_QUERY = 'Switzerland';
const PAGE_SIZE = 50;
const MAX_PAGES = 10; // safety cap (~500 jobs); the current CH-scoped set is ~13

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── HQ fallback (Route de l'Aéroport 10, 1215 Genève 15, GE) ────
 * The Geneva World Trade Center office (workplace code "GENEVE-WTC1") is
 * where every currently-open Swiss posting on this ATS is based — this is
 * the trading-arm office (TOTSA TotalEnergies Trading SA / TotalEnergies
 * Gas & Power Ltd), confirmed via moneyhouse.ch company registry lookup.
 * It is NOT the Mex VD marketing-entity address named in the source
 * company table (that entity has zero open postings right now).
 */
const HQ = {
  city: 'Genève',
  canton: 'GE',
  postalCode: '1215',
  streetAddress: "Route de l'Aéroport 10",
  region: 'GE',
};

const SECTOR = 'Energia (multinazionale, trading & shipping)';

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
 * Check if a job belongs to TotalEnergies.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isTotalEnergiesJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === TOTALENERGIES_KEY ||
    key.startsWith('totalenergies') ||
    company.includes('totalenergies') ||
    company.includes('total energies') ||
    url.includes('totalenergies.com') ||
    url.includes('jobs.totalenergies.com')
  );
}

/**
 * Validate that a URL belongs to TotalEnergies' domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'totalenergies.com' || host.endsWith('.totalenergies.com');
  } catch {
    return false;
  }
}

/**
 * Defensive per-row Switzerland scope check (Non-Negotiable-adjacent
 * safeguard: this crawler is CH-scoped only, never global). The keyword
 * search returns a small candidate set that is 12/13 accurate; this
 * re-verifies against the detail page's own structured `Country` field
 * before a job is ever emitted, catching the one confirmed false positive
 * (a Madrid-based VIE role that only text-matched on a sibling's title).
 */
function isSwissLocation(countryRaw = '') {
  return /switzerland|suisse|schweiz|svizzera/i.test(normalize(countryRaw));
}

/* ── Category Detection ────────────────────────────────────── */

// TotalEnergies' own "Domain" business-line field (from the detail page)
// maps onto the shared Italian-label taxonomy used by sibling parsers,
// same pattern as Deloitte's businessLine-driven detectCategory().
function detectCategory(title = '', domain = '') {
  const d = normalize(domain);
  if (/finance/.test(d)) return 'Finanza';
  if (/information systems|digital/.test(d)) return 'IT';
  if (/sales|marketing/.test(d)) return 'Vendite';
  if (/strategy|economics|business/.test(d)) return 'Consulenza';
  if (/operations|hse|technical/.test(d)) return 'Ingegneria';
  if (/human resources|hr\b/.test(d)) return 'Risorse Umane';
  if (/legal/.test(d)) return 'Legale';
  if (/procurement|supply/.test(d)) return 'Acquisti';

  const t = normalize(title);
  if (/\b(develop|engineer|data|it\b|system|digital|software)/.test(t)) return 'IT';
  if (/\b(tax|legal|compliance)/.test(t)) return 'Legale';
  if (/\b(trad|shipping|dispatch|operations|logistic)/.test(t)) return 'Ingegneria';
  if (/\b(analyst|finance|credit|treasury)/.test(t)) return 'Finanza';
  if (/\b(procurement|purchas)/.test(t)) return 'Acquisti';
  if (/\b(sales|commercial|market)/.test(t)) return 'Vendite';
  if (/\b(hr\b|human|recruit|talent)/.test(t)) return 'Risorse Umane';

  return 'Altro';
}

function detectExperienceLevel(title = '', experienceRaw = '') {
  const raw = normalize(experienceRaw);
  if (/intern|apprentice|vie\b/.test(raw)) return 'intern';
  if (/entry|graduate|junior|less than/.test(raw)) return 'junior';
  if (/minimum\s*(\d+)/.test(raw)) {
    const years = Number(raw.match(/minimum\s*(\d+)/)?.[1] || 0);
    if (years >= 6) return 'senior';
    if (years >= 2) return 'mid';
    return 'junior';
  }

  const t = normalize(title);
  if (/\b(intern|internship|vie\b|stagiaire|apprentice)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|manager|director)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(contractRaw = '') {
  const raw = normalize(contractRaw);
  if (/intern|apprentice/.test(raw)) return 'INTERN';
  if (/vie\b/.test(raw)) return 'TEMPORARY';
  if (/fixed[- ]?term/.test(raw)) return 'TEMPORARY';
  return 'FULL_TIME';
}

function detectContractLabel(employmentType) {
  if (employmentType === 'INTERN') return 'internship';
  if (employmentType === 'TEMPORARY') return 'temporary';
  return 'full-time';
}

// The listing card's "list-item-jobCreationDate" field is DD-MM-YYYY.
function parseTotalEnergiesDate(raw = '') {
  const m = String(raw || '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/* ── Address Resolution ───────────────────────────────────────
 * Every currently-open Swiss posting on this ATS resolves to Geneva (the
 * "GENEVE-WTC1" workplace code), so the canton-gated HQ fallback mirrors
 * Deloitte's pattern: postalCode/streetAddress are only filled in when the
 * resolved city genuinely IS Geneva, never unconditionally and never on
 * canton alone (guards against a future non-Geneva GE-canton job — e.g.
 * Nyon or Meyrin — silently inheriting the WTC street address).
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

  const isHqCity = /gen[eè]ve|geneva|genf|ginevra/i.test(raw);
  return {
    city: isHqCity ? HQ.city : raw,
    canton,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
    region: canton,
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Split the listing HTML into one chunk per `<div class="article
 * article--result" id="article--N">` result row. This tenant's listing
 * markup uses plain nested `<div>`s (no self-closing `<article>` tag like
 * Deloitte's), so a naive "match N closing divs" regex is unreliable —
 * instead this finds every result-row opening-tag offset and slices from
 * one offset to the next (or to a generous tail bound for the last row).
 */
function splitResultBlocks(html) {
  const openRe = /<div class="article article--result"[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = openRe.exec(html)) !== null) starts.push(m.index);
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : start + 6000;
    return html.slice(start, end);
  });
}

/**
 * Parse one `<div class="article article--result">` listing block into a
 * stub. Returns null if no JobDetail URL/title is found.
 */
function parseListingArticle(block) {
  const urlMatch = block.match(
    /href="(https:\/\/jobs\.totalenergies\.com\/[a-z]{2}_[A-Z]{2}\/careers\/JobDetail\/[^"]+)"/i,
  );
  if (!urlMatch) return null;
  const url = urlMatch[1];

  const titleMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  const title = titleMatch ? decodeHtmlEntities(stripHtml(titleMatch[1])).trim() : '';
  if (!title) return null;

  const countryMatch = block.match(/list-item-jobCountry">([\s\S]*?)<\/li>/i);
  const dateMatch = block.match(/list-item-jobCreationDate">([\s\S]*?)<\/li>/i);
  const contractMatch = block.match(/list-item-employmentType">([\s\S]*?)<\/li>/i);
  const employerMatch = block.match(/list-item-jobEmployerCompany">([\s\S]*?)<\/li>/i);

  const idMatch = url.match(/\/(\d+)\/?$/);
  return {
    title,
    url,
    jobReqId: idMatch ? idMatch[1] : '',
    listCountry: countryMatch ? decodeHtmlEntities(stripHtml(countryMatch[1])).trim() : '',
    listDateRaw: dateMatch ? decodeHtmlEntities(stripHtml(dateMatch[1])).trim() : '',
    listContract: contractMatch ? decodeHtmlEntities(stripHtml(contractMatch[1])).trim() : '',
    listEmployer: employerMatch ? decodeHtmlEntities(stripHtml(employerMatch[1])).trim() : '',
  };
}

/**
 * Extract a labelled `<dt class="…field__label">`/`<dd
 * class="…field__value">` value pair from a TotalEnergies detail page (e.g.
 * label "Country" → value "Switzerland"). Unlike Deloitte's single-`<div>`
 * label/value markup, this tenant uses `<dt>`/`<dd>` definition-list pairs.
 */
function extractField(html, labelText) {
  const escaped = labelText
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const re = new RegExp(
    `field__label"\\s*>\\s*${escaped}\\s*<\\/dt>\\s*<dd[^>]*field__value[^>]*>([\\s\\S]*?)<\\/dd>`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeHtmlEntities(stripHtml(m[1])).trim() : '';
}

/**
 * Extract every `<h3 …><strong>Section Title</strong></h3>`-headed rich-text
 * description section (Context & Environment, Activities, Candidate
 * Profile, Additional Information, …) and concatenate them in document
 * order. There is no single "Job description" field on this ATS — the
 * description is split across several labelled sections.
 */
function extractJobDescriptionHtml(html) {
  const sectionRe =
    /<h3[^>]*class="[^"]*title--04[^"]*"[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<\/h3>[\s\S]*?field__value">([\s\S]*?)<\/dd>/gi;
  const parts = [];
  let match;
  while ((match = sectionRe.exec(html)) !== null) {
    const heading = decodeHtmlEntities(stripHtml(match[1])).trim();
    const bodyText = decodeHtmlEntities(stripHtml(match[2])).trim();
    if (!bodyText) continue;
    parts.push(heading ? `${heading}: ${bodyText}` : bodyText);
  }
  return parts.join('\n\n');
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

  return {
    country: extractField(html, 'Country'),
    city: extractField(html, 'City'),
    workplace: extractField(html, 'Workplace location'),
    employer: extractField(html, 'Employer company'),
    domain: extractField(html, 'Domain'),
    contract: extractField(html, 'Type of contract'),
    experienceRaw: extractField(html, 'Experience'),
    description: extractJobDescriptionHtml(html),
  };
}

/**
 * Fetch all server-rendered listing rows scoped to Switzerland via the
 * free-text keyword search (see docblock for why: the Country facet
 * requires JS/AJAX and cannot be set via plain GET). Paginates via
 * jobOffset in case the CH-scoped set ever exceeds one page; each stub is
 * then enriched from its detail page and defensively re-verified against
 * the structured Country field.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${LISTING_BASE}?search=${SEARCH_QUERY}`);

  const byUrl = new Map();
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const pageUrl = `${LISTING_BASE}?search=${SEARCH_QUERY}&listFilterMode=1&jobRecordsPerPage=${PAGE_SIZE}&jobOffset=${offset}`;
    let html;
    try {
      html = await fetchHtml(pageUrl, { headers: { 'User-Agent': BROWSER_UA } });
    } catch (err) {
      console.warn(`   ⚠️ listing page fetch failed (${pageUrl}): ${err && err.message ? err.message : err}`);
      break;
    }

    const legendMatch = html.match(/list-controls__text__legend"[^>]*>([\s\S]{0,200}?)<\/div>/i);
    if (legendMatch) {
      const totalMatch = legendMatch[1].match(/(\d+)\s*results?/i);
      if (totalMatch) total = Number(totalMatch[1]);
    }

    const blocks = splitResultBlocks(html);
    let added = 0;
    for (const block of blocks) {
      const stub = parseListingArticle(block);
      if (!stub || byUrl.has(stub.url)) continue;

      // Defensive first pass at the listing level (Non-Negotiable-adjacent
      // CH-scope guard) — the detail-page Country field re-check below is
      // authoritative, this just avoids enriching obviously-foreign rows.
      if (stub.listCountry && !isSwissLocation(stub.listCountry)) continue;

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

    // Authoritative CH-scope re-check against the detail page's own
    // structured Country field — catches the confirmed false positive
    // (a Madrid VIE role that only text-matched the keyword search).
    if (detail && detail.country && !isSwissLocation(detail.country)) {
      console.log(`   ⏭️  skipping non-Swiss job (Country="${detail.country}"): ${stub.title}`);
      continue;
    }

    listings.push({ ...stub, detail });
    await new Promise((r) => setTimeout(r, 200));
  }
  return listings;
}

/**
 * Fetch all TotalEnergies jobs scoped to Switzerland.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllTotalEnergiesJobs() {
  console.log(`🔍 Fetching ${TOTALENERGIES_COMPANY_NAME} jobs (Switzerland-scoped)`);
  console.log(`   Source: ${CAREER_URL} (Avature portal "Careers")\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Switzerland-scoped job listings returned.');
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

    const descriptionText = normalizeSpace(detail.description || '');
    const description = descriptionText.split(/\s+/).length >= 50
      ? descriptionText
      : `${title} presso TotalEnergies a ${location}, Svizzera. TotalEnergies è una multinazionale energetica francese con attività di trading, shipping e gas & power a livello globale; questa posizione opera dall'ufficio di ${location} (World Trade Center). Candidati direttamente su jobs.totalenergies.com. ${descriptionText}`.trim();

    const publicUrl = listing.url || CAREER_URL;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} totalenergies ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(detail.contract || listing.listContract || '');
    const postedDate =
      parseTotalEnergiesDate(listing.listDateRaw) ||
      new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${TOTALENERGIES_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TOTALENERGIES_COMPANY_NAME,
      companyKey: TOTALENERGIES_KEY,
      companyDomain: TOTALENERGIES_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'TotalEnergies Dedicated Parser (Avature)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, detail.domain),
      contract: detectContractLabel(employmentType),
      employmentType,
      experienceLevel: detectExperienceLevel(title, detail.experienceRaw),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      hiringOrganizationName: detail.employer || listing.listEmployer || TOTALENERGIES_COMPANY_NAME,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${TOTALENERGIES_COMPANY_NAME} jobs discovered (Switzerland-scoped): ${jobs.length}`);
  return jobs;
}
