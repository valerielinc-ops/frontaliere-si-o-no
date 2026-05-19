#!/usr/bin/env node
/**
 * Schindler job parser — SAP SuccessFactors jobs2web (j2w) HTML scraper.
 *
 * Source: https://job.schindler.com/search/?q=&locationsearch=Switzerland
 *
 * Schindler migrated off SmartRecruiters (2026) to SAP SuccessFactors jobs2web.
 * Listings are spread across multiple SF career-site "tenants" all served from
 * `job.schindler.com`:
 *   - /Schindler/job/...           (corporate HQ & central Schindler postings)
 *   - /ASZ/job/...                 (Aufzüge Schweiz AG — sales/admin)
 *   - /ASZ_Fitter/job/...          (ASZ — fitter / installation technicians)
 *   - /ASZ_Service_TechnikerIn/... (ASZ — service technicians)
 *   - /ASZ_Office_General/...      (ASZ — office staff)
 *   - /SBB/, /SBB_AS/, /SCH_Fitter/, /Jardine_Schindler/, ...
 *
 * All tenants share the same j2w listing/detail format, so we match them
 * generically by URL pattern `/{Tenant}/job/.../{jobId}/`.
 *
 * Strategy:
 *   1. Walk paginated search results at /search/?q=&locationsearch=Switzerland
 *      (25 per page, ~93 total Swiss jobs)
 *   2. For each listing extract: title, url, location, postedDate, jobId
 *   3. Fetch each detail page for the full description (<div id="content">)
 *   4. Build ParsedJob with canton resolution + fallback description
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSchindlerJobs()  — Fetch and parse all jobs
 *   - isSchindlerJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SCHINDLER_KEY = 'schindler';
export const SCHINDLER_COMPANY_NAME = 'Schindler';
export const SCHINDLER_COMPANY_DOMAIN = 'schindler.com';

const BASE_URL = 'https://job.schindler.com';
const SEARCH_URL = `${BASE_URL}/search/`;
const PAGE_SIZE = 25; // SuccessFactors j2w default

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Date helpers ─────────────────────────────────────────── */

const MONTH_ABBR = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
  // German abbreviations
  mär: '03', maerz: '03', mai: '05', okt: '10', dez: '12',
  // Italian
  gen: '01', mag: '05', giu: '06', lug: '07', ago: '08', set: '09', ott: '10', dic: '12',
};

/**
 * Parse SF j2w date string. Accepts:
 *   - "May 11, 2026" / "Apr 28, 2026"  (English, common default)
 *   - "DD.MM.YYYY"                     (German format)
 *   - "2026-05-11"                     (ISO, just-in-case)
 * Returns YYYY-MM-DD or '' on failure.
 */
export function parseDate(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';

  // ISO already
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // English "MMM D, YYYY"
  const en = text.match(/^([A-Za-zÀ-ÿ]{3,5})\s+(\d{1,2}),?\s+(\d{4})/);
  if (en) {
    const mm = MONTH_ABBR[en[1].toLowerCase().slice(0, 4)] || MONTH_ABBR[en[1].toLowerCase().slice(0, 3)];
    if (mm) return `${en[3]}-${mm}-${en[2].padStart(2, '0')}`;
  }

  // German "DD.MM.YYYY"
  const de = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (de) return `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`;

  return '';
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Schindler.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSchindlerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SCHINDLER_KEY ||
    key.startsWith('schindler') ||
    company.includes('schindler') ||
    url.includes('schindler.com') ||
    url.includes('schindler.ch') ||
    url.includes('job.schindler.com')
  );
}

/**
 * Validate that a URL belongs to Schindler or one of its SF j2w tenants
 * hosted under `job.schindler.com`.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'schindler.com' || host.endsWith('.schindler.com')) return true;
    if (host === 'schindler.ch' || host.endsWith('.schindler.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / level / employment detection ──────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|montage|monteur|aufzug)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|verkaufsprofi|neukunden|salesperson|account.manager)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|procurement|supply.chain|purchasing)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it\b|software|develop|programm|data.analyst)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|event)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|schnupperlehre|working.student|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|teamleiter|montageleiter|montagechef|projektleiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  const pctMatch = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || t.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    if (maxPct < 80) return 'PART_TIME';
    if (maxPct >= 80) return 'FULL_TIME';
  }
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|100\s*%)/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Location extraction ──────────────────────────────────── */

/**
 * Parse SF j2w location string. Format: "City, Region, CC" or "City, CC".
 * (e.g., "Ebikon, Lucerne, CH", "Visp, Wallis, CH").
 */
export function parseLocation(raw = '') {
  const text = normalizeSpace(raw);
  if (!text) return { city: '', region: '' };
  // Strip trailing ", CH" if present
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { city: '', region: '' };
  const last = parts[parts.length - 1];
  if (/^(CH|Switzerland|Schweiz|Suisse|Svizzera)$/i.test(last)) parts.pop();
  return {
    city: parts[0] || '',
    region: parts[1] || '',
  };
}

/* ── Listing page parser ──────────────────────────────────── */

/**
 * Parse the SuccessFactors / j2w search-results HTML table.
 * Each row links to a detail page at /{Tenant}/job/.../{jobId}/.
 * Tenants seen: Schindler, ASZ, ASZ_Fitter, ASZ_Service_TechnikerIn,
 * ASZ_Office_General, SBB, SBB_AS, SCH_Fitter, Jardine_Schindler.
 * Returns array of { title, url, location, postedDate, jobId, tenant }.
 */
export function parseSearchResults(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];
  const seen = new Set();

  // Match anchors to detail pages across any tenant under job.schindler.com.
  // Pattern: /{Tenant}/job/{slug}/{jobId}/
  // We only care about ones whose anchor has class jobTitle-link to avoid
  // matching breadcrumb / unrelated links.
  const anchorRe = /<a[^>]+class="[^"]*jobTitle-link[^"]*"[^>]+href="(\/([A-Za-z_][A-Za-z0-9_]*)\/job\/[^"]+\/(\d+)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const relUrl = m[1].replace(/&amp;/g, '&');
    const tenant = m[2];
    const jobId = m[3];
    const rawTitle = normalizeSpace(stripHtml(m[4]));
    if (!rawTitle || rawTitle.length < 3) continue;
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const fullUrl = `${BASE_URL}${relUrl}`;

    // Locate the surrounding row to extract location + date columns.
    // The relevant pattern in the j2w template:
    //   <td class="colLocation ...">...<span class="jobLocation">City, Region, CC</span>...</td>
    //   <td class="colDate ...">...<span class="jobDate">May 11, 2026</span>...</td>
    // We search forward from the anchor match for the next ~3KB of HTML.
    const lookahead = html.slice(m.index, m.index + 4000);
    const locMatch = lookahead.match(/class="jobLocation"[^>]*>\s*([^<]+?)\s*</i);
    const dateMatch = lookahead.match(/class="jobDate"[^>]*>\s*([^<]+?)\s*</i);

    const location = locMatch ? normalizeSpace(locMatch[1]) : '';
    const rawDate = dateMatch ? normalizeSpace(dateMatch[1]) : '';
    const postedDate = parseDate(rawDate);

    jobs.push({
      title: rawTitle,
      url: fullUrl,
      location,
      postedDate,
      jobId,
      tenant,
    });
  }
  return jobs;
}

/**
 * Extract total results count: "Results 1 – N of N" / "Ergebnisse 1 – N von N".
 */
export function extractTotalResults(html) {
  if (!html) return 0;
  // SF j2w pagination format wraps numbers in <b>: "Results <b>1 – 25</b> of <b>93</b>"
  // Strip <b>/<strong> tags first so the regex can match across both bare and wrapped formats.
  const flat = String(html).replace(/<\/?(?:b|strong)>/gi, '');
  const m = flat.match(/(?:Ergebnisse|Results|Risultati|Résultats)\s+\d+\s*[–\-]\s*\d+\s+(?:von|of|di|de|sur)\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/* ── Detail page parser ──────────────────────────────────── */

/**
 * Parse a Schindler SF j2w detail page.
 * Returns { title, description, location, applyUrl }.
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  // Title: <h1 class="job-title"> for Schindler tenants
  const titleMatch = html.match(/<h1[^>]*class="[^"]*job-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Description: Schindler SF j2w puts the actual job body inside
  //   <span class="jobdescription">...</span>
  // (NOT in <div id="content"> — that wrapper contains search widgets too).
  let descriptionHtml = '';
  const jdSpanMatch = html.match(/<span[^>]*class="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)<\/span>\s*(?:<\/div>\s*){0,5}(?:<div[^>]*class="(?:job-action|jobtitle-action|btn|apply-button)|<footer|<div[^>]*id="footer")/i);
  if (jdSpanMatch) {
    descriptionHtml = jdSpanMatch[1];
  } else {
    // Fall back: greedy match from <span class="jobdescription"> to its closing </span>.
    // SF templates can nest tags inside jobdescription, so we accept the largest match.
    const fallbackSpan = html.match(/<span[^>]*class="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/i);
    if (fallbackSpan) descriptionHtml = fallbackSpan[1];
  }

  if (!descriptionHtml) {
    // Last resort: previously-supported <div id="content"> shape (other SF tenants)
    const contentMatch = html.match(/<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*id="(?:footer|sidebar)|<footer)/i);
    if (contentMatch) descriptionHtml = contentMatch[1];
  }

  if (!descriptionHtml) {
    const parts = [];
    const blockRe = /<(?:p|ul|ol|li|div)[^>]*>([\s\S]*?)<\/(?:p|ul|ol|li|div)>/gi;
    let blockMatch;
    while ((blockMatch = blockRe.exec(html)) !== null) {
      const text = normalizeDescriptionSpace(stripHtml(blockMatch[1]));
      if (text.length > 40 && !/cookie|datenschutz|privacy|navigation|login|consent/i.test(text)) {
        parts.push(text);
      }
    }
    if (parts.length > 0) descriptionHtml = parts.join('\n\n');
  }

  let description = normalizeDescriptionSpace(stripHtml(descriptionHtml));

  // Reject SF widget garbage that occasionally bleeds into the description
  const GARBAGE = [
    /Suche nach Stichwort/i,
    /Benachrichtigung erstellen/i,
    /Search by keyword/i,
    /Create Alert/i,
    /Select how often/i,
    /Wählen Sie.*wie oft/i,
    /Manager für Cookie/i,
    /Cookie Consent/i,
  ];
  if (GARBAGE.some((re) => re.test(description))) description = '';

  // Apply URL: SF talent-community / apply link
  const applyMatch = html.match(/href="([^"]*(?:talentcommunity\/apply|\/apply\/)\d+[^"]*)"/i);
  const applyUrl = applyMatch
    ? (applyMatch[1].startsWith('http') ? applyMatch[1] : `${BASE_URL}${applyMatch[1]}`)
    : '';

  // NOTE: We do NOT extract a canonical location from the detail page.
  // SF j2w detail pages render a "Standort suchen" / "Search location" widget
  // whose text inevitably matches naive Ort/Standort regexes and pollutes the
  // location field (e.g. → "suchen"). The listing-page `<span class="jobLocation">`
  // value is always authoritative; fetchAll uses it directly.
  const location = '';

  return { title, description, location, applyUrl };
}

/* ── Fallback description ─────────────────────────────────── */

function buildFallbackDescription(title, location) {
  return `${title} bei Schindler in ${location || 'der Schweiz'}.\n\nDie Schindler-Gruppe ist einer der weltweit führenden Hersteller von Aufzügen, Fahrtreppen und Fahrsteigen. Das 1874 in der Schweiz gegründete Unternehmen beschäftigt rund 70'000 Mitarbeitende weltweit, davon mehrere tausend in der Schweiz. Schindler bietet ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen, vielfältige Weiterbildungsmöglichkeiten und Karriereperspektiven in einem global tätigen Schweizer Technologieunternehmen mit Hauptsitz in Ebikon (Kanton Luzern).`;
}

/* ── HTTP fetch with timeout ──────────────────────────────── */

async function fetchPage(url, timeoutMs, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7,it;q=0.5,fr;q=0.4',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Schindler jobs from job.schindler.com (SF jobs2web).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSchindlerJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT || DEFAULT_USER_AGENT;

  console.log(`🔍 Fetching ${SCHINDLER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${SEARCH_URL}?locationsearch=Switzerland (SuccessFactors jobs2web)\n`);

  // Step 1 — listing pages (paginated, 25 per page)
  const allListings = [];
  let startrow = 0;
  let totalReported = 0;
  for (let page = 0; page < 50; page += 1) {
    const url = `${SEARCH_URL}?q=&locationsearch=Switzerland&startrow=${startrow}`;
    console.log(`  📄 Fetching search page at startrow=${startrow}...`);
    let html;
    try {
      html = await fetchPage(url, timeoutMs, userAgent);
    } catch (err) {
      if (startrow === 0) {
        throw new Error(`Failed to fetch search page: ${err?.message || err}`);
      }
      console.warn(`  ⚠️ Pagination fetch failed at startrow=${startrow}, stopping.`);
      break;
    }
    const listings = parseSearchResults(html);
    if (startrow === 0) {
      totalReported = extractTotalResults(html);
      console.log(`  📋 Total Swiss results reported by site: ${totalReported || 'unknown'}`);
    }
    if (listings.length === 0) break;
    allListings.push(...listings);

    if (totalReported > 0 && allListings.length >= totalReported) break;
    if (listings.length < PAGE_SIZE) break;

    startrow += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`  📋 Found ${allListings.length} job listings\n`);
  if (allListings.length === 0) {
    console.warn('⚠️ No Schindler job listings found.');
    return [];
  }

  // Step 2 — detail pages
  const jobs = [];
  for (const listing of allListings) {
    try {
      let detail = null;
      try {
        const detailHtml = await fetchPage(listing.url, timeoutMs, userAgent);
        detail = parseDetailPage(detailHtml);
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
      }

      const title = detail?.title || listing.title;
      const { city, region } = parseLocation(listing.location);
      const location = detail?.location || city || listing.location || 'Switzerland';
      const canton =
        inferSwissTargetCanton(`${location} ${region}`) ||
        inferSwissTargetCanton(location) ||
        inferSwissTargetCanton(region) ||
        'LU'; // Schindler HQ is in Ebikon (LU)

      let description = '';
      if (detail?.description && detail.description.split(/\s+/).length >= 50) {
        description = detail.description;
      } else {
        description = buildFallbackDescription(title, location);
      }

      const sourceLang = detectLang(description || title, 'de');
      const postedDate = listing.postedDate || new Date().toISOString().slice(0, 10);
      const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${title} ${SCHINDLER_KEY} ${location}`);
      const employmentType = detectEmploymentType(title);

      const job = {
        // ── Required fields ──
        id: `${SCHINDLER_KEY}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: SCHINDLER_COMPANY_NAME,
        companyKey: SCHINDLER_KEY,
        companyDomain: SCHINDLER_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        location,
        canton,
        url: listing.url,
        source: 'Schindler Dedicated Parser (SuccessFactors j2w)',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        category: detectCategory(title),
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectExperienceLevel(title),
        sector: 'Industrial',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: detail?.applyUrl || listing.url,
        jobReqId: listing.jobId || null,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };

      jobs.push(job);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${listing.title} — ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Deduplicate by URL (safety: multiple tenants can occasionally cross-link)
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total unique ${SCHINDLER_COMPANY_NAME} jobs discovered: ${deduped.length}`);
  return deduped;
}
