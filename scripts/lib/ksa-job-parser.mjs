#!/usr/bin/env node
/**
 * Kantonsspital Aarau (KSA) job parser — Umantis ATS (tenant 122706).
 *
 * Public career page: https://www.ksa.ch/de/kantonsspital-aarau/karriere-bildung
 *   → links to https://recruitingapp-122706.umantis.com/Vacancies/...
 *
 * Listing page (server-rendered, ~10 rows/page with pagination token):
 *   https://recruitingapp-122706.umantis.com/Jobs/All?lang=ger
 *
 * Same Umantis layout as Inselspital (tenant 2624) — element IDs are stable
 * across tenants (1152488 = title+link, 1184128 = department, etc.). We
 * piggy-back on the inselspital parser's regex helpers (rowRegex, element
 * extractors) since they are tenant-agnostic.
 *
 * Rich descriptions — Prospective careercenter join (July 2026):
 *   The Umantis detail page (/Vacancies/{ID}/Description/1) is DEAD for this
 *   tenant: it 302-redirects cross-host to https://www.ksa.ch/offene-stellen
 *   (itself a 404), and the surviving CheckLogin/Application pages carry no
 *   job body. KSA publishes the actual job content on its Prospective.ch
 *   careercenter (medium 1003009, iframed at jobs.ksa.ch):
 *
 *     https://ohws.prospective.ch/public/v1/medium/1003009/jobs?lang=de
 *
 *   Each Prospective listing carries `szas.sza_apply_link` = the Umantis
 *   vacancy ID (verified live: "5564" ↔ /Vacancies/5564/...), plus the full
 *   Aufgaben/Anforderungen/company-profile sections. We keep the Umantis
 *   listing as the source of truth (stable IDs/URLs) and join the Prospective
 *   feed on that key to enrich descriptions. Listings without a Prospective
 *   match (mostly one-day "Berufswahlpraktikum" taster events) fall back to
 *   the listing snippet, as before.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKsaJobs()  — Fetch and parse all jobs across pages
 *   - isKsaJob()         — Match jobs belonging to KSA
 *   - isTrustedDomain()  — Validate URLs belong to KSA / Umantis tenant 122706
 *   - KSA_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import {
  slugify,
  stripHtml,
  normalizeSpace,
  normalizeDescriptionBullets,
  fetchJson,
  fetchHtmlWithCookies,
} from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KSA_KEY = 'ksa';
export const KSA_COMPANY_NAME = 'Kantonsspital Aarau (KSA)';
export const KSA_COMPANY_DOMAIN = 'ksa.ch';

const UMANTIS_TENANT = '122706';
const BASE_URL = `https://recruitingapp-${UMANTIS_TENANT}.umantis.com`;
const LISTING_URL = `${BASE_URL}/Jobs/All?lang=ger`;
const PUBLIC_CAREER_URL = 'https://www.ksa.ch/de/kantonsspital-aarau/karriere-bildung/bewerben/offene-stellen';

// Hard cap on pagination walk (10 rows/page → 200 vacancies max).
const MAX_PAGES = 20;

// Prospective.ch careercenter tenant carrying the rich job bodies (the
// Umantis detail page is dead — see file header). Same public API shape as
// prospective-ch-job-parser-common.mjs consumers.
const PROSPECTIVE_MEDIUM_ID = '1003009';
const PROSPECTIVE_API_BASE = `https://ohws.prospective.ch/public/v1/medium/${PROSPECTIVE_MEDIUM_ID}/jobs`;
const PROSPECTIVE_PAGE_SIZE = 100;
// Safety cap: 10 pages × 100 = 1000 vacancies, far above the ~110 real ones.
const PROSPECTIVE_MAX_PAGES = 10;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

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
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isKsaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KSA_KEY ||
    key.startsWith('kantonsspital-aarau') ||
    company.includes('kantonsspital aarau') ||
    company === 'ksa' ||
    url.includes('ksa.ch') ||
    url.includes(`recruitingapp-${UMANTIS_TENANT}.umantis.com`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'ksa.ch' || host.endsWith('.ksa.ch')) return true;
    if (host === `recruitingapp-${UMANTIS_TENANT}.umantis.com`) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics (hospital) ─ */

function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const signal = `${t} ${d}`;
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|oberärztin|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung|hebamme)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance|elektr|install)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|finanzbuchhalt|account|finanz|controll)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|apprendist|lehrling|lernend|doktorand)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|oberärztin|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

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
  if (rangeMatch) return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  const singleMatch = title.match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

/* ── Listing Page Parser (Umantis layout) ─────────────────── */

export function extractPagingToken(html = '') {
  const m = html.match(
    /data-pagination-next-href="\?tc1152481=p\d+&amp;_search_token1152481=(\d+)/
  );
  if (!m) return null;
  return { searchToken: m[1] };
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

export function parseKsaListingPage(html = '') {
  const results = [];
  const seen = new Set();
  const rowRegex = /<tr\s+class="table-as-list__contentrow[12]"[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    // Umantis dropped the standalone `/Description/{n}` detail page for this
    // tenant (now 404s) — the listing's title link now goes straight to
    // `/Application/CheckLogin/{n}` (still 200, shows the job title/intro
    // before the login wall). Match either shape so we don't silently drop
    // every row when the ATS changes its link target again.
    const titleMatch = rowHtml.match(
      /tableaslist_element_1152488[\s\S]*?<a\s[^>]*href="\/Vacancies\/(\d+)\/(?:Description|Application\/CheckLogin)\/\d+[^"]*"[^>]*>([^<]+)<\/a>/
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
      // `/Description/1` 404s on this tenant now (see titleMatch comment
      // above) — point both URLs at the confirmed-working CheckLogin page.
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
      applyUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
    });
  }
  return results;
}

/* ── Prospective careercenter enrichment ──────────────────── */

/**
 * Build the section-headed plain-text description from one Prospective
 * listing's `szas` bag. Mirrors the shared prospective-ch factory's
 * buildDescription(): intro → Aufgaben → Anforderungen → Wir bieten →
 * company profile. `<ul><li>` markup becomes `• ` bullets via stripHtml, so
 * the result satisfies the parser-quality structured-content check.
 *
 * @param {object} szas  `job.szas` from the Prospective API
 * @returns {string} plain-text description ('' when the bag is empty)
 */
export function buildKsaDetailDescription(szas = {}) {
  const parts = [];
  const intro = normalizeSpace(stripHtml(szas.sza_introduction || ''));
  if (intro) parts.push(intro);
  const tasks = stripHtml(szas.sza_tasks || '');
  if (tasks) parts.push(`Aufgaben:\n${tasks}`);
  const reqs = stripHtml(szas.sza_requirements || '');
  if (reqs) parts.push(`Anforderungen:\n${reqs}`);
  const benefits = stripHtml(szas.sza_benefits || '');
  if (benefits) parts.push(`Wir bieten:\n${benefits}`);
  const profile = stripHtml(szas.sza_company_profil || '');
  if (profile) parts.push(profile);
  return normalizeDescriptionBullets(parts.join('\n\n'));
}

/**
 * Index Prospective listings by their Umantis vacancy ID (`sza_apply_link`,
 * a bare numeric reference on this tenant — verified live July 2026).
 * Entries without a usable numeric key or without any body text are skipped.
 *
 * @param {Array<object>} prospectiveJobs  `jobs` array from the API
 * @returns {Map<string, string>} vacancyId → rich description
 */
export function buildProspectiveDescriptionMap(prospectiveJobs = []) {
  const map = new Map();
  for (const job of Array.isArray(prospectiveJobs) ? prospectiveJobs : []) {
    const applyLink = String(job?.szas?.sza_apply_link || '').trim();
    if (!/^\d+$/.test(applyLink)) continue;
    const description = buildKsaDetailDescription(job?.szas || {});
    if (!description || description.length < 100) continue;
    map.set(applyLink, description);
  }
  return map;
}

/**
 * Fetch every KSA job from the Prospective careercenter API (paginated).
 * Graceful degradation: any HTTP/network/JSON error returns whatever was
 * collected so far (possibly []) — the crawler then falls back to the
 * listing snippet exactly as before the enrichment existed.
 *
 * @returns {Promise<Array<object>>}
 */
async function fetchProspectiveJobs() {
  const all = [];
  let total = Infinity;
  for (let page = 0; page < PROSPECTIVE_MAX_PAGES && all.length < total; page++) {
    const offset = page * PROSPECTIVE_PAGE_SIZE;
    const url = `${PROSPECTIVE_API_BASE}?lang=de&offset=${offset}&limit=${PROSPECTIVE_PAGE_SIZE}`;
    try {
      // Shared fetchJson (retry on transient network/5xx/invalid-JSON-on-200)
      // instead of a naked single-attempt fetch — sibling-pattern fix for
      // issue #4057 item 2 (CI-specific fetch blips): PR #4056 fixed the
      // equivalent naked-fetch anti-pattern for csd-engineers' detail page,
      // but its sibling check only scanned literal "detail page" fetchers —
      // KSA's rich content comes from this Prospective JSON join instead
      // (see file header), so it didn't match and was missed.
      const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } });
      const items = Array.isArray(data?.jobs) ? data.jobs : [];
      if (Number.isFinite(Number(data?.total))) total = Number(data.total);
      if (items.length === 0) break;
      all.push(...items);
      if (items.length < PROSPECTIVE_PAGE_SIZE) break;
    } catch (err) {
      console.warn(`  ⚠️ Prospective enrichment fetch failed at offset=${offset}: ${err?.message || err}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return all;
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

/**
 * Fetch one Umantis listing page. `cookieJar` is an external `Map` (NOT
 * fetchHtmlWithCookies's own per-attempt jar) so the session cookie set on
 * page 1 is resent on page 2+ — pagination continuity spans several
 * SEPARATE calls, which fetchHtmlWithCookies's `options.cookieJar` param
 * exists specifically to support (see its doc in crawler-template.mjs).
 * Shared helper (retry + manual redirect cookie relay) replaces a naked
 * single-attempt fetch — same sibling-pattern fix as fetchProspectiveJobs()
 * above (issue #4057 item 2).
 */
async function fetchPage(url, cookieJar) {
  return fetchHtmlWithCookies(url, {
    cookieJar,
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'de-CH,de;q=0.9' },
  });
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllKsaJobs() {
  console.log(`🏥 Fetching ${KSA_COMPANY_NAME} jobs`);
  console.log(`   Source:        ${LISTING_URL}`);
  console.log(`   Public career: ${PUBLIC_CAREER_URL}\n`);

  // External Map (not a `{value}` box) — the shape fetchHtmlWithCookies's
  // `options.cookieJar` expects so pagination cookies survive across calls.
  const cookieJar = new Map();
  const allListings = [];
  const seenIds = new Set();

  const firstHtml = await fetchPage(LISTING_URL, cookieJar);
  const firstListings = parseKsaListingPage(firstHtml);
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
      const pageListings = parseKsaListingPage(pageHtml);
      let added = 0;
      for (const l of pageListings) {
        if (!seenIds.has(l.vacancyId)) {
          seenIds.add(l.vacancyId);
          allListings.push(l);
          added++;
        }
      }
      if (added === 0) break;
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  if (allListings.length === 0) {
    console.warn('⚠️ No job listings found on the page.');
    return [];
  }

  console.log(`  📋 Listings found: ${allListings.length}\n`);

  // Rich-description join: Umantis vacancy ID → Prospective body (see file
  // header). Failure here is non-fatal — jobs fall back to the snippet.
  console.log(`  📖 Fetching rich bodies from Prospective medium ${PROSPECTIVE_MEDIUM_ID}…`);
  const prospectiveJobs = await fetchProspectiveJobs();
  const descriptionByVacancyId = buildProspectiveDescriptionMap(prospectiveJobs);
  console.log(`  📖 Prospective bodies indexed: ${descriptionByVacancyId.size} (from ${prospectiveJobs.length} listings)\n`);

  const jobs = [];
  let enriched = 0;
  for (const listing of allListings) {
    const title = listing.title;
    const location = 'Aarau';
    const canton = 'AG';

    const fallbackDesc = `${title} — ${KSA_COMPANY_NAME}, Aarau`;
    const richDesc = descriptionByVacancyId.get(listing.vacancyId) || '';
    if (richDesc) enriched += 1;
    const descriptionText = richDesc || listing.snippet || fallbackDesc;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} ksa ch`);
    const urlHash = createHash('sha1')
      .update(`ksa-vacancy-${listing.vacancyId}`)
      .digest('hex')
      .slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(listing.artText, title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const job = {
      id: `ksa-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KSA_COMPANY_NAME,
      companyKey: KSA_KEY,
      companyDomain: KSA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: listing.detailUrl,
      source: `KSA Dedicated Parser (Umantis tenant ${UMANTIS_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      postalCode: '5001',
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

    if (listing.department) job.department = listing.department;

    jobs.push(job);
  }

  console.log(`  ✓ Rich descriptions joined: ${enriched}/${jobs.length}`);
  console.log(`\n📋 Total ${KSA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
