/**
 * Heineken Switzerland (Calanda Brewery) job parser — HTML scraping.
 *
 * Heineken Switzerland uses SAP SuccessFactors / Jobs2Web (j2w) for their
 * global careers portal at careers.theheinekencompany.com. Swiss jobs are
 * under the /Switzerland/ path prefix.
 *
 * Listing page: https://careers.theheinekencompany.com/Switzerland/search?keywords=&location=&locale=de_DE
 *   - HTML table with rows: Title (link) | Department | Location | Date
 *   - Pagination: ?paginationStartRow=N (25 per page)
 *
 * Detail pages: /Switzerland/job/{Location}-{Title}-{PostalCode}/{jobId}/
 *   - Title in <h2>
 *   - Description in <div id="content"> section
 *   - Apply link: /talentcommunity/apply/{jobId}/?locale=de_DE
 *
 * HQ: Chur, Canton GR, 7000 (Calanda brewery)
 *
 * Source: https://careers.theheinekencompany.com/Switzerland/search
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const HQ = getCompanyDefaults('heineken-ch');

const SEARCH_URL = 'https://careers.theheinekencompany.com/Switzerland/search';
const BASE_URL = 'https://careers.theheinekencompany.com';

export const HEINEKEN_CH_KEY = 'heineken-ch';
export const HEINEKEN_CH_COMPANY_NAME = 'Heineken Switzerland';
export const HEINEKEN_CH_COMPANY_DOMAIN = 'theheinekencompany.com';

/* ── Date helper ──────────────────────────────────────────── */

/**
 * Parse "DD.MM.YYYY" → "YYYY-MM-DD". Returns '' on failure.
 */
export function parseDate(raw = '') {
  const m = String(raw || '').trim().match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/* ── Category detection ──────────────────────────────────── */

export function detectCategory(title = '', department = '') {
  const combined = `${title} ${department}`.toLowerCase();
  if (/brau|brew|lebensmittel|food|produk|production|abfüll|bottling|anlagenfüh/i.test(combined)) return 'Produzione';
  if (/elektr|automat|install|techni|mechan|mechanik|instandhalt|maintenance/i.test(combined)) return 'Tecnica';
  if (/logist|lager|warehouse|supply chain|chauffeur|driver|transport|versand/i.test(combined)) return 'Logistica';
  if (/verkauf|sales|commerce|vertrieb|commercial|berater|conseill|category manager/i.test(combined)) return 'Commerciale';
  if (/market|kommunik|comunicaz|event/i.test(combined)) return 'Marketing';
  if (/\bit\s|software|develop|programm|digital|informatik|system.?admin/i.test(combined)) return 'IT';
  if (/finanz|finance|controll|buchhalt|accounting/i.test(combined)) return 'Finanza';
  if (/hr\b|human|personal|recruit/i.test(combined)) return 'Risorse Umane';
  if (/admin|segret|empfang|office|büro|assist/i.test(combined)) return 'Amministrazione';
  if (/qualit|qa|qc|quality/i.test(combined)) return 'Qualità';
  if (/legal|recht|jurist|compliance/i.test(combined)) return 'Legale';
  if (/engineer|ingenieur|entwickl/i.test(combined)) return 'Ingegneria';
  return 'Altro';
}

/* ── Employment type detection ────────────────────────────── */

export function detectEmploymentType(text = '') {
  const t = String(text || '').toLowerCase();
  if (/teilzeit|part[- ]?time|tempo parziale|temps partiel/i.test(t)) return 'PART_TIME';
  // Check percentage ranges
  const pctMatch = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || t.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  if (/vollzeit|full[- ]?time|tempo pieno|100\s*%/i.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Experience level detection ───────────────────────────── */

function detectExperienceLevel(title = '') {
  const t = title.toLowerCase();
  if (/praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|ausbildung|trainee/i.test(t)) return 'intern';
  if (/junior|jr\b/i.test(t)) return 'junior';
  if (/senior|sr\b|lead|head|director|dirett|chef|verantwort|responsab|leiter|manager/i.test(t)) return 'senior';
  return 'mid';
}

/* ── Location extraction ──────────────────────────────────── */

/**
 * Extract city and postal code from SuccessFactors location string.
 * Format: "City, CC, NNNNN" or "City, CC" (e.g., "Chur, CH, 7000")
 */
export function parseLocation(raw = '') {
  const text = normalizeSpace(raw);
  if (!text) return { city: HQ.city, postalCode: HQ.postalCode };

  const m = text.match(/^([^,]+)(?:,\s*CH)?(?:,\s*(\d{4}))?/i);
  if (!m) return { city: text, postalCode: '' };

  const city = normalizeSpace(m[1]);
  const postalCode = m[2] || '';
  return { city: city || HQ.city, postalCode };
}

/* ── Listing page parser ──────────────────────────────────── */

/**
 * Parse the SuccessFactors / j2w search results HTML table.
 * Each row has: Title (link) | Department | Location | Date
 * Returns array of { title, url, department, location, postedDate, jobId }.
 */
export function parseSearchResults(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  const seen = new Set();

  // Match table rows — the search results table contains job rows with links to /Switzerland/job/...
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Must contain a link to a job detail page
    const linkMatch = rowHtml.match(/<a[^>]+href="(\/Switzerland\/job\/[^"]+\/(\d+)\/?)"/i);
    if (!linkMatch) continue;

    const relUrl = linkMatch[1].replace(/&amp;/g, '&');
    const jobId = linkMatch[2];
    const fullUrl = `${BASE_URL}${relUrl}`;

    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // Extract cells
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(normalizeSpace(stripHtml(cellMatch[1])));
    }

    // We need at least the title cell
    if (cells.length < 1) continue;

    // Extract title from the first cell (may be inside the <a> tag)
    const titleFromLink = rowHtml.match(/<a[^>]+href="\/Switzerland\/job\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleFromLink
      ? normalizeSpace(stripHtml(titleFromLink[1]))
      : cells[0];

    if (!title || title.length < 3) continue;

    // The SuccessFactors table: Title | Department | Location | Date
    const department = cells.length > 1 ? cells[1] : '';
    const location = cells.length > 2 ? cells[2] : '';
    const rawDate = cells.length > 3 ? cells[3] : '';
    const postedDate = parseDate(rawDate);

    jobs.push({
      title,
      url: fullUrl,
      department,
      location,
      postedDate,
      jobId,
    });
  }

  return jobs;
}

/**
 * Extract total results count from the search page.
 * Looks for "Ergebnisse 1 – N von N" or "Results 1 – N of N".
 */
export function extractTotalResults(html) {
  if (!html) return 0;
  const m = html.match(/(?:Ergebnisse|Results)\s+\d+\s*[–-]\s*\d+\s+(?:von|of)\s+(\d+)/i);
  return m ? parseInt(m[1]) : 0;
}

/* ── Detail page parser ──────────────────────────────────── */

/**
 * Parse a Heineken job detail page.
 * Returns { title, description, location, applyUrl }.
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract title — SuccessFactors uses h2 on detail pages
  const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Extract description from the main content area
  // SuccessFactors detail pages use div#content with the job text
  let descriptionHtml = '';

  // Strategy 1: Look for the job description content after the title
  // The content section typically contains the job details
  const contentMatch = html.match(/<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*id="(?:footer|sidebar)|<footer)/i);
  if (contentMatch) {
    descriptionHtml = contentMatch[1];
  }

  // Strategy 2: Look for paragraphs/lists in the main area
  if (!descriptionHtml) {
    // Collect all meaningful paragraph and list content
    const parts = [];
    const blockRe = /<(?:p|ul|ol|li|div)[^>]*>([\s\S]*?)<\/(?:p|ul|ol|li|div)>/gi;
    let blockMatch;
    while ((blockMatch = blockRe.exec(html)) !== null) {
      const text = normalizeSpace(stripHtml(blockMatch[1]));
      // Filter out navigation, buttons, short fragments
      if (text.length > 40 && !/cookie|datenschutz|privacy|navigation|login/i.test(text)) {
        parts.push(text);
      }
    }
    if (parts.length > 0) {
      descriptionHtml = parts.join('\n\n');
    }
  }

  let description = normalizeSpace(stripHtml(descriptionHtml));

  // Reject search widget / alert form garbage that SuccessFactors injects
  // when the detail page renders client-side or in a different locale
  const GARBAGE_PATTERNS = [
    /Suche nach Stichwort/i,
    /Benachrichtigung erstellen/i,
    /Search by keyword/i,
    /Create Alert/i,
    /Select how often/i,
    /Wählen Sie.*wie oft/i,
  ];
  if (GARBAGE_PATTERNS.some((re) => re.test(description))) {
    description = '';
  }

  // Extract apply URL
  const applyMatch = html.match(/href="([^"]*talentcommunity\/apply\/\d+[^"]*)"/i);
  const applyUrl = applyMatch
    ? (applyMatch[1].startsWith('http') ? applyMatch[1] : `${BASE_URL}${applyMatch[1]}`)
    : '';

  // Extract location if present on detail page
  const locMatch = html.match(/(?:Ort|Standort|Location)\s*:?\s*([^<\n,]+)/i);
  const location = locMatch ? normalizeSpace(locMatch[1]) : '';

  return {
    title,
    description,
    location,
    applyUrl,
  };
}

/* ── Fallback description ─────────────────────────────────── */

/**
 * Build a rich fallback description (>50 words) when detail page yields nothing.
 */
export function buildFallbackDescription(title, location, department = '') {
  const deptInfo = department ? ` im Bereich ${department}` : '';
  return `${title}${deptInfo} bei Heineken Switzerland (Calanda Brauerei) in ${location}, Kanton Graubünden, Schweiz.\n\nHEINEKEN Switzerland betreibt die Calanda Brauerei in Chur, Graubünden — eine der traditionsreichsten Brauereien der Schweiz, gegründet 1780. Als Teil der HEINEKEN-Gruppe, dem weltweit zweitgrössten Brauereikonzern, beschäftigt HEINEKEN Switzerland rund 800 Mitarbeitende an mehreren Standorten in der Schweiz. Das Unternehmen braut und vertreibt bekannte Marken wie Calanda, Eichhof, Heineken und Birra Moretti. HEINEKEN Switzerland bietet ein internationales Arbeitsumfeld, moderne Anstellungsbedingungen und vielfältige Entwicklungsmöglichkeiten in den Bereichen Produktion, Logistik, Vertrieb und Administration.`;
}

/* ── Job identification ───────────────────────────────────── */

export function isHeinekenChJob(job = {}) {
  const key = String(job?.companyKey || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === HEINEKEN_CH_KEY ||
    key.startsWith('heineken-ch') ||
    company.includes('heineken switzerland') ||
    company.includes('calanda') ||
    url.includes('theheinekencompany.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'theheinekencompany.com' ||
      host === 'careers.theheinekencompany.com' ||
      host.endsWith('.theheinekencompany.com') ||
      host.endsWith('.successfactors.eu')
    );
  } catch {
    return false;
  }
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
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
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

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Heineken Switzerland jobs.
 * 1. Fetch search listing pages (paginated), parse table rows
 * 2. For each job, fetch detail page for full description
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllHeinekenChJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  console.log(`🍺 Fetching Heineken Switzerland jobs`);
  console.log(`   Search: ${SEARCH_URL}\n`);

  // Step 1: Fetch listing pages (paginated)
  const allListings = [];
  let startRow = 0;
  const PAGE_SIZE = 25; // SuccessFactors/j2w default

  while (true) {
    const searchUrl = `${SEARCH_URL}?keywords=&location=&locale=de_DE&paginationStartRow=${startRow}`;
    console.log(`  📄 Fetching search page at offset ${startRow}...`);

    let html;
    try {
      html = await fetchPage(searchUrl, timeoutMs, userAgent);
    } catch (err) {
      if (startRow === 0) {
        throw new Error(`Failed to fetch search page: ${err?.message || err}`);
      }
      console.warn(`  ⚠️ Pagination fetch failed at offset ${startRow}, stopping.`);
      break;
    }

    const listings = parseSearchResults(html);
    if (listings.length === 0) break;

    allListings.push(...listings);

    // Check if we have all results
    const total = extractTotalResults(html);
    if (total > 0 && allListings.length >= total) break;
    if (listings.length < PAGE_SIZE) break;

    startRow += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`  📋 Found ${allListings.length} job listings\n`);

  if (allListings.length === 0) {
    console.warn('⚠️ No job listings found on the career page.');
    return [];
  }

  // Step 2: Fetch detail pages for descriptions
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
      const { city, postalCode: parsedPostal } = parseLocation(listing.location);
      const location = detail?.location || city;
      const canton = inferSwissTargetCanton(location) || HQ.canton;
      const postalCode = parsedPostal || HQ.postalCode;

      // Build description
      let description = '';
      if (detail?.description && detail.description.split(/\s+/).length >= 50) {
        description = detail.description;
      } else {
        description = buildFallbackDescription(title, location, listing.department);
      }

      const postedDate = listing.postedDate || new Date().toISOString().slice(0, 10);
      const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${title} heineken-ch ${location}`);
      const employmentType = detectEmploymentType(title);

      const job = {
        id: `${HEINEKEN_CH_KEY}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { de: jobSlug },
        company: HEINEKEN_CH_COMPANY_NAME,
        companyKey: HEINEKEN_CH_KEY,
        companyDomain: HEINEKEN_CH_COMPANY_DOMAIN,
        title,
        titleByLocale: { de: title },
        description,
        descriptionByLocale: { de: description },
        location,
        canton,
        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode,
        streetAddress: `${location}, ${canton === 'GR' ? 'Graubünden' : canton}`,
        category: detectCategory(title, listing.department),
        sector: 'Industria / Alimentare',
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectExperienceLevel(title),
        featured: false,
        postedDate,
        url: listing.url,
        applyUrl: detail?.applyUrl || listing.url,
        source: 'Heineken Switzerland Dedicated Parser (SuccessFactors)',
        sourceLang: 'de',
        crawledAt: new Date().toISOString(),
      };

      jobs.push(job);
      console.log(`  ✅ ${title.substring(0, 60)}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${listing.title} — ${err?.message || err}`);
    }

    // Polite delay between requests
    await new Promise((r) => setTimeout(r, 300));
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total unique Heineken Switzerland jobs discovered: ${deduped.length}`);
  return deduped;
}
