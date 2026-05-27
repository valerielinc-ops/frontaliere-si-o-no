#!/usr/bin/env node
/**
 * Inselspital Bern job parser — Umantis ATS (tenant 2624).
 *
 * Listing page: https://recruitingapp-2624.umantis.com/Jobs/All?lang=ger
 *   - Server-rendered HTML with the same Umantis 2023 UI used by Spital Davos:
 *     <tr class="table-as-list__contentrow1|2"> rows with tableaslist_element_*
 *     children. Element IDs match across tenants (1152488 title+link,
 *     1184115 snippet, 1184128 dept, 1184117 art, 1184118 befristung,
 *     1184120 org-unit, 1152500 apply link).
 *   - Tenant 2624 difference vs 2966: most enrichment fields (snippet,
 *     art, org-unit, location) ship empty in the listing — only TITLE,
 *     DEPARTMENT (1184128, e.g. "Medizinbereich Tumor"), and BEFRISTUNG
 *     (1184118) are reliably populated.
 *   - Pagination: 10 rows/page via `?tc1152481=pN&_search_token1152481=TOKEN`
 *     URLs that the Umantis page surfaces in
 *     `data-pagination-next-href` on the bottom paging widget. The
 *     search token is stable per crawl and we discover N by walking
 *     until a page returns 0 new vacancy IDs.
 *
 * Detail page: /Vacancies/{ID}/Description/1
 *   - Returns the careercenter SPA shell (1 KB, `<div id="root">`) — the
 *     real description is rendered client-side from a JSON endpoint we
 *     don't reverse-engineer here. We use the listing title as the source
 *     of truth and fall back to a title-based stub for description, the
 *     same pattern other React-only ATS adapters use in this repo.
 *
 * Listings cover the entire Insel Gruppe (Inselspital Bern, Spital Aarberg,
 * Spital Belp, Spital Riggisberg). Default city/canton resolves to the
 * group HQ in Bern (3010); per-site refinement can be layered later from
 * the department field if/when needed.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllInselspitalJobs()  — Fetch and parse all jobs across pages
 *   - isInselspitalJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to Insel/Umantis
 *   - INSELSPITAL_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const INSELSPITAL_KEY = 'inselspital';
export const INSELSPITAL_COMPANY_NAME = 'Inselspital Bern';
export const INSELSPITAL_COMPANY_DOMAIN = 'insel.ch';

const BASE_URL = 'https://recruitingapp-2624.umantis.com';
const LISTING_URL = `${BASE_URL}/Jobs/All?lang=ger`;
const PUBLIC_CAREER_URL = 'https://jobs.inselgruppe.ch/?lang=de&filter_50=0';

// Hard cap on pagination walk (at 10 rows/page this is 200 vacancies — well
// above the realistic active-vacancy count for the group).
const MAX_PAGES = 20;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Decode HTML entities (&amp; &nbsp; &uuml; etc.) from Umantis HTML.
 * Same set as the spital-davos parser — kept inline here so this file
 * stays self-contained.
 */
function decodeEntities(html = '') {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è')
    .replace(/&szlig;/g, 'ß')
    .replace(/&#8209;/g, '-')
    .replace(/&#x2011;/g, '-')
    .replace(/&ndash;/g, '–')
    .replace(/&#8211;/g, '–')
    .replace(/&mdash;/g, '—');
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Inselspital / Insel Gruppe.
 * Matches the canonical key, the legacy "inselspital-bern" alias, the
 * "insel-gruppe" / "insel" company strings, and any URL on the public
 * insel domains or the Umantis tenant.
 */
export function isInselspitalJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === INSELSPITAL_KEY ||
    key === 'inselspital-bern' ||
    key.startsWith('insel-gruppe') ||
    company.includes('inselspital') ||
    company.includes('insel gruppe') ||
    url.includes('insel.ch') ||
    url.includes('inselgruppe.ch') ||
    url.includes('recruitingapp-2624.umantis.com')
  );
}

/**
 * Validate that a URL belongs to the Insel Gruppe domains or the Umantis ATS.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'insel.ch' ||
      host.endsWith('.insel.ch') ||
      host === 'inselgruppe.ch' ||
      host.endsWith('.inselgruppe.ch') ||
      host === 'recruitingapp-2624.umantis.com' ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect category from title and department fields.
 * University hospital → most roles are healthcare.
 */
function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const signal = `${t} ${d}`;

  if (/\b(pflege|pflegefach|stationsleitung|pflegehelfer|pflegehilfe|fage|fachperson gesundheit|spitex|langzeitpflege|nachtwache)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|oberärztin|chefarzt|leitend|medizin|innere medizin|pädiatrie|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog|neurochirurg)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(clinical research|study coordinator|trial)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|sachbearbeiter|finanzbuchhalt|faktur|account|finanz|controll)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik|comunicaz)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand|phd)/.test(signal)) return 'Formazione';
  if (/\b(forschung|research|wissenschaft|scientist)/.test(signal)) return 'Sanità / Ospedali';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|doktorand|phd)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|stationsleitung|oberarzt|oberärztin|chefarzt|executive)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Detect employment type from title (the listing's Art field is empty
 * for tenant 2624, so title-pct heuristics carry the load).
 */
function detectEmploymentType(artText = '', title = '') {
  const t = normalize(artText || title);
  if (/teilzeit/.test(t)) return 'PART_TIME';
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  const pctMatch = normalize(title).match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || normalize(title).match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

function extractPensum(title = '') {
  const rangeMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = title.match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

/* ── Listing Page Parser ──────────────────────────────────── */

/**
 * Extract pagination URL parts ({ tcParam, searchToken }) from a listing
 * page's `data-pagination-next-href` attribute. Format observed:
 *   ?tc1152481=pN&amp;_search_token1152481=2010729086#connectortable_1152481
 * We pull just the two query params; the page number is rebuilt by
 * the caller for each iteration.
 */
export function extractPagingToken(html = '') {
  const m = html.match(
    /data-pagination-next-href="\?tc1152481=p\d+&amp;_search_token1152481=(\d+)/
  );
  if (!m) return null;
  return { searchToken: m[1] };
}

/**
 * Parse one Umantis listing page (tenant 2624 layout) and return an
 * array of listing objects.
 *
 * Element IDs:
 *   - 1152488: title + link (in <h3>)
 *   - 1184115: snippet (often empty for tenant 2624)
 *   - 1184128: department / Medizinbereich (column-value)
 *   - 1184117: Art (often empty for tenant 2624)
 *   - 1184118: Befristung (befristet/unbefristet)
 *   - 1184120: Organisationseinheit (often empty for tenant 2624)
 */
export function parseInselspitalListingPage(html = '') {
  const results = [];
  const seen = new Set();

  const rowRegex = /<tr\s+class="table-as-list__contentrow[12]"[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const titleMatch = rowHtml.match(
      /tableaslist_element_1152488[\s\S]*?<a\s[^>]*href="\/Vacancies\/(\d+)\/Description\/\d+"[^>]*>([^<]+)<\/a>/
    );
    if (!titleMatch) continue;

    const vacancyId = titleMatch[1];
    if (seen.has(vacancyId)) continue;
    seen.add(vacancyId);

    const title = normalizeSpace(decodeEntities(titleMatch[2]));
    if (!title || title.length < 3) continue;

    if (/^(initiativbewerbung|spontanbewerbung|blindbewerbung)$/i.test(title.trim())) continue;

    const snippet = extractElementText(rowHtml, '1184115');
    const department = extractColumnValue(rowHtml, '1184128') || extractColumnValue(rowHtml, '1184120');
    const artText = extractColumnValue(rowHtml, '1184117');
    const befristung = extractColumnValue(rowHtml, '1184118');

    results.push({
      vacancyId,
      title,
      snippet: normalizeSpace(snippet),
      artText: normalizeSpace(artText),
      befristung: normalizeSpace(befristung),
      department: normalizeSpace(department),
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Description/1`,
      applyUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
    });
  }

  return results;
}

function extractElementText(rowHtml, elementId) {
  const regex = new RegExp(`tableaslist_element_${elementId}"[^>]*>([\\s\\S]*?)(?:<\\/p\\s*>|<\\/h3\\s*>|<\\/li\\s*>)`);
  const match = rowHtml.match(regex);
  if (!match) return '';
  return normalizeSpace(decodeEntities(stripHtml(match[1])));
}

function extractColumnValue(rowHtml, elementId) {
  const regex = new RegExp(`tableaslist_element_${elementId}"[\\s\\S]*?<span\\s+class="column-value"[^>]*>([^<]+)<\\/span>`);
  const match = rowHtml.match(regex);
  if (!match) return '';
  return normalizeSpace(decodeEntities(match[1]));
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

async function fetchPage(url, cookieJar) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': USER_AGENT,
    'Accept-Language': 'de-CH,de;q=0.9',
  };
  if (cookieJar?.value) headers.Cookie = cookieJar.value;

  try {
    const res = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    if (cookieJar) {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        // Coalesce all Set-Cookie name=value pairs into a single Cookie header.
        const pairs = setCookie.split(/,(?=\s*[A-Za-z0-9_-]+=)/g)
          .map((c) => c.split(';')[0].trim())
          .filter(Boolean);
        if (pairs.length) cookieJar.value = pairs.join('; ');
      }
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Inselspital / Insel Gruppe jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch page 1 → extract listings + paging token
 *   2. Walk pages 2..N (capped at MAX_PAGES) until a page yields no new
 *      vacancy IDs
 *   3. Build ParsedJob objects (no detail-page enrichment — Umantis
 *      detail pages are JS-rendered)
 */
export async function fetchAllInselspitalJobs() {
  console.log(`🏥 Fetching Inselspital Bern jobs`);
  console.log(`   Source:        ${LISTING_URL}`);
  console.log(`   Public iframe: ${PUBLIC_CAREER_URL}\n`);

  const cookieJar = { value: '' };
  const allListings = [];
  const seenIds = new Set();

  // Page 1 — also seeds the search token for subsequent pages.
  const firstHtml = await fetchPage(LISTING_URL, cookieJar);
  const firstListings = parseInselspitalListingPage(firstHtml);
  for (const l of firstListings) {
    if (!seenIds.has(l.vacancyId)) {
      seenIds.add(l.vacancyId);
      allListings.push(l);
    }
  }

  const paging = extractPagingToken(firstHtml);
  if (paging?.searchToken) {
    for (let pageNum = 2; pageNum <= MAX_PAGES; pageNum++) {
      const pageUrl = `${LISTING_URL}&tc1152481=p${pageNum}&_search_token1152481=${paging.searchToken}`;
      let pageHtml;
      try {
        pageHtml = await fetchPage(pageUrl, cookieJar);
      } catch (err) {
        console.warn(`  ⚠️ Page ${pageNum} fetch failed: ${err?.message}`);
        break;
      }
      const pageListings = parseInselspitalListingPage(pageHtml);
      let added = 0;
      for (const l of pageListings) {
        if (!seenIds.has(l.vacancyId)) {
          seenIds.add(l.vacancyId);
          allListings.push(l);
          added++;
        }
      }
      if (added === 0) break;
      // Polite pacing between pages.
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  if (allListings.length === 0) {
    console.warn('⚠️ No job listings found on the page.');
    return [];
  }

  console.log(`  📋 Listings found: ${allListings.length}\n`);

  const jobs = [];
  for (const listing of allListings) {
    const title = listing.title;
    const location = 'Bern';
    const canton = 'BE';

    const fallbackDesc = `${title} — Inselspital Bern, Bern`;
    const descriptionText = listing.snippet || fallbackDesc;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} inselspital ch`);
    const urlHash = createHash('sha1')
      .update(`inselspital-vacancy-${listing.vacancyId}`)
      .digest('hex')
      .slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(listing.artText, title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const job = {
      // ── Required fields ──
      id: `inselspital-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: INSELSPITAL_COMPANY_NAME,
      companyKey: INSELSPITAL_KEY,
      companyDomain: INSELSPITAL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: listing.detailUrl,
      source: 'Inselspital Bern Dedicated Parser (Umantis tenant 2624)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: '3010',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (listing.department) {
      job.department = listing.department;
    }
    if (listing.befristung) {
      job.contractDuration = /befristet/i.test(listing.befristung) && !/unbefristet/i.test(listing.befristung)
        ? 'temporary'
        : 'permanent';
    }
    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max
        ? `${pensum.min}%`
        : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 65)} — Bern (${listing.department || 'N/A'})`);
  }

  console.log(`\n📋 Total Inselspital Bern jobs discovered: ${jobs.length}`);
  return jobs;
}
