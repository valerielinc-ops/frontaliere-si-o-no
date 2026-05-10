#!/usr/bin/env node
/**
 * Hirslanden Klinik (Mediclinic Group CH) job parser — SAP SuccessFactors jobs2web.
 *
 * Hirslanden is the Swiss arm of Mediclinic International. Their global
 * careers portal at careers.mediclinic.com hosts the Hirslanden listings
 * under the `/Hirslanden/` path prefix. The platform is the same SF
 * jobs2web (j2w) overlay used by Heineken Switzerland (`/Switzerland/...`).
 *
 * Listing page: https://careers.mediclinic.com/Hirslanden/search?locale=de_DE
 *   - HTML table with rows: Title (link) | Location | Date
 *   - Pagination: ?startrow=N (25 per page)
 *
 * Detail pages: /Hirslanden/job/{Klinik}-{Title}-{Location}-{PostalCode}/{jobId}/
 *   - Title in <h2>
 *   - Description in <div id="content"> section
 *   - Apply link: /talentcommunity/apply/{jobId}/?locale=de_DE
 *
 * Hirslanden operates 17+ private clinics across Switzerland — each job's
 * location is in the table cell. We canton-resolve via inferSwissTargetCanton.
 *
 * Source: https://careers.mediclinic.com/Hirslanden/search
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const SEARCH_URL = 'https://careers.mediclinic.com/Hirslanden/search';
const BASE_URL = 'https://careers.mediclinic.com';
const PUBLIC_CAREER_URL = 'https://careers.mediclinic.com/Hirslanden/?locale=de_DE';

export const HIRSLANDEN_KEY = 'hirslanden';
export const HIRSLANDEN_COMPANY_NAME = 'Hirslanden Klinik';
export const HIRSLANDEN_COMPANY_DOMAIN = 'hirslanden.ch';

const PAGE_SIZE = 25; // SuccessFactors / j2w default

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

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
  const t = normalize(`${title} ${department}`);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|op[\s-]technik)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|physiother|ergo|logopäd|rehabilit|apothek|pharma|expert.*pflege|expertin.*pflege)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|studierend)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

/* ── Employment type detection ────────────────────────────── */

export function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/teilzeit|part[- ]?time|tempo parziale|temps partiel/.test(t)) return 'PART_TIME';
  const pctMatch = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || t.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    if (maxPct < 80) return 'PART_TIME';
  }
  if (/vollzeit|full[- ]?time|tempo pieno|100\s*%/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Experience level detection ───────────────────────────── */

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/praktik|stage|intern|lehrling|lernend|apprenti|ausbildung|trainee|studierend/.test(t)) return 'intern';
  if (/junior|jr\b/.test(t)) return 'junior';
  if (/senior|sr\b|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt|manager/.test(t)) return 'senior';
  return 'mid';
}

/* ── Location extraction ──────────────────────────────────── */

/**
 * Parse SuccessFactors location string. Format: "City, CC, NNNN" or "City, CC"
 * (e.g., "Zürich, CH, 8008", "Biel, CH, 2503").
 */
export function parseLocation(raw = '') {
  const text = normalizeSpace(raw);
  if (!text) return { city: 'Zürich', postalCode: '8008' };
  const m = text.match(/^([^,]+)(?:,\s*CH)?(?:,\s*(\d{4}))?/i);
  if (!m) return { city: text, postalCode: '' };
  return {
    city: normalizeSpace(m[1]) || 'Zürich',
    postalCode: m[2] || '',
  };
}

/* ── Listing page parser ──────────────────────────────────── */

/**
 * Parse the SuccessFactors / j2w search-results HTML table.
 * Each row links to a detail page at /Hirslanden/job/.../{jobId}/.
 * Returns array of { title, url, location, postedDate, jobId }.
 */
export function parseSearchResults(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];
  const seen = new Set();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Match a link to a Hirslanden detail page: /Hirslanden/job/.../{jobId}/
    const linkMatch = rowHtml.match(/<a[^>]+href="(\/Hirslanden\/job\/[^"]+\/(\d+)\/?)"/i);
    if (!linkMatch) continue;

    const relUrl = linkMatch[1].replace(/&amp;/g, '&');
    const jobId = linkMatch[2];
    const fullUrl = `${BASE_URL}${relUrl}`;
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(normalizeSpace(stripHtml(cellMatch[1])));
    }
    if (cells.length < 1) continue;

    const titleFromLink = rowHtml.match(/<a[^>]+href="\/Hirslanden\/job\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const rawTitle = titleFromLink
      ? normalizeSpace(stripHtml(titleFromLink[1]))
      : cells[0];
    const title = rawTitle.replace(/^(?:Title|Titre|Bezeichnung|Titolo|Titulo)\s*:\s*/i, '').trim();
    if (!title || title.length < 3) continue;

    // Hirslanden table layout: Title | Location | Date
    const location = cells.length > 1 ? cells[1] : '';
    const rawDate = cells.length > 2 ? cells[2] : '';
    const postedDate = parseDate(rawDate);

    jobs.push({
      title,
      url: fullUrl,
      location,
      postedDate,
      jobId,
    });
  }
  return jobs;
}

/**
 * Extract total results count: "Ergebnisse 1 – N von N" / "Results 1 – N of N".
 */
export function extractTotalResults(html) {
  if (!html) return 0;
  const m = html.match(/(?:Ergebnisse|Results)\s+\d+\s*[–-]\s*\d+\s+(?:von|of)\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/* ── Detail page parser ──────────────────────────────────── */

/**
 * Parse a Hirslanden job detail page (SuccessFactors j2w).
 * Returns { title, description, location, applyUrl }.
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  let descriptionHtml = '';
  const contentMatch = html.match(/<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*id="(?:footer|sidebar)|<footer)/i);
  if (contentMatch) descriptionHtml = contentMatch[1];

  if (!descriptionHtml) {
    const parts = [];
    const blockRe = /<(?:p|ul|ol|li|div)[^>]*>([\s\S]*?)<\/(?:p|ul|ol|li|div)>/gi;
    let blockMatch;
    while ((blockMatch = blockRe.exec(html)) !== null) {
      const text = normalizeSpace(stripHtml(blockMatch[1]));
      if (text.length > 40 && !/cookie|datenschutz|privacy|navigation|login/i.test(text)) {
        parts.push(text);
      }
    }
    if (parts.length > 0) descriptionHtml = parts.join('\n\n');
  }

  let description = normalizeSpace(stripHtml(descriptionHtml));

  // Reject SF widget garbage that occasionally bleeds into the description
  const GARBAGE = [
    /Suche nach Stichwort/i,
    /Benachrichtigung erstellen/i,
    /Search by keyword/i,
    /Create Alert/i,
    /Select how often/i,
    /Wählen Sie.*wie oft/i,
  ];
  if (GARBAGE.some((re) => re.test(description))) description = '';

  const applyMatch = html.match(/href="([^"]*talentcommunity\/apply\/\d+[^"]*)"/i);
  const applyUrl = applyMatch
    ? (applyMatch[1].startsWith('http') ? applyMatch[1] : `${BASE_URL}${applyMatch[1]}`)
    : '';

  // Extract canonical location ("Ort:", "Standort:", "Location:")
  const stripped = html.replace(/<[^>]*>/g, '\n').replace(/[^\S\n]+/g, ' ');
  const locMatch = stripped.match(/(?:Ort|Standort|Location)\s*:?\s*([A-ZÀ-Ü][A-Za-zÀ-ÿ\s\-/]{2,40}?)(?:\s*(?:,|\n|$))/i);
  let location = locMatch ? normalizeSpace(locMatch[1]).replace(/^"|"$/g, '').trim() : '';
  if (location && /[<="']|viewport|content|width/i.test(location)) location = '';

  return { title, description, location, applyUrl };
}

/* ── Fallback description ─────────────────────────────────── */

function buildFallbackDescription(title, location) {
  return `${title} bei der Hirslanden-Klinik in ${location || 'der Schweiz'}.\n\nDie Hirslanden-Gruppe ist mit 17 Privatkliniken und mehreren Tageskliniken die führende Privatklinik-Gruppe der Schweiz. Sie beschäftigt rund 11'000 Mitarbeitende und arbeitet mit über 2'500 Belegärztinnen und Belegärzten zusammen. Hirslanden gehört zur internationalen Mediclinic-Gruppe (Südafrika / Vereinigtes Königreich / Schweiz / Vereinigte Arabische Emirate). Wir bieten ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen, vielfältige Weiterbildungsmöglichkeiten und Karriereperspektiven in einem führenden Schweizer Gesundheitsunternehmen.`;
}

/* ── Job identification ───────────────────────────────────── */

export function isHirslandenJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === HIRSLANDEN_KEY ||
    key.startsWith('hirslanden') ||
    company.includes('hirslanden') ||
    url.includes('hirslanden.ch') ||
    url.includes('careers.mediclinic.com/hirslanden')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'hirslanden.ch' || host.endsWith('.hirslanden.ch')) return true;
    if (host === 'careers.mediclinic.com' && /\/Hirslanden\//i.test(rawUrl)) return true;
    if (host.endsWith('.successfactors.eu')) return true;
    return false;
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
 * Fetch all Hirslanden Klinik jobs.
 *   1. Walk paginated SF j2w search results
 *   2. For each listing, fetch its detail page for the description
 * Returns ParsedJob[] with source-locale fields only (sourceLang='de').
 */
export async function fetchAllHirslandenJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT
    || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  console.log(`🏥 Fetching ${HIRSLANDEN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${SEARCH_URL} (SuccessFactors jobs2web)\n`);

  // Step 1 — listing pages
  const allListings = [];
  let startrow = 0;
  while (true) {
    const url = `${SEARCH_URL}?keywords=&location=&locale=de_DE&startrow=${startrow}`;
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
    if (listings.length === 0) break;
    allListings.push(...listings);

    const total = extractTotalResults(html);
    if (total > 0 && allListings.length >= total) break;
    if (listings.length < PAGE_SIZE) break;

    startrow += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`  📋 Found ${allListings.length} job listings\n`);
  if (allListings.length === 0) {
    console.warn('⚠️ No job listings found.');
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
      const { city, postalCode: parsedPostal } = parseLocation(listing.location);
      const location = detail?.location || city;
      const canton = inferSwissTargetCanton(location) || 'ZH';
      const postalCode = parsedPostal || '8008';

      let description = '';
      if (detail?.description && detail.description.split(/\s+/).length >= 50) {
        description = detail.description;
      } else {
        description = buildFallbackDescription(title, location);
      }

      const postedDate = listing.postedDate || new Date().toISOString().slice(0, 10);
      const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${title} ${HIRSLANDEN_KEY} ${location}`);
      const employmentType = detectEmploymentType(title);

      const job = {
        id: `${HIRSLANDEN_KEY}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { de: jobSlug },
        company: HIRSLANDEN_COMPANY_NAME,
        companyKey: HIRSLANDEN_KEY,
        companyDomain: HIRSLANDEN_COMPANY_DOMAIN,
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
        category: detectCategory(title),
        sector: 'Sanità / Ospedali',
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectExperienceLevel(title),
        currency: 'CHF',
        featured: false,
        postedDate,
        url: listing.url,
        applyUrl: detail?.applyUrl || listing.url,
        source: 'Hirslanden Klinik Dedicated Parser (SuccessFactors j2w)',
        sourceLang: 'de',
        crawledAt: new Date().toISOString(),
        requirements: [],
        requirementsByLocale: { de: [] },
      };

      jobs.push(job);
      console.log(`  ✅ ${title.substring(0, 60)} — ${location}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${listing.title} — ${err?.message || err}`);
    }
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

  console.log(`\n📋 Total unique ${HIRSLANDEN_COMPANY_NAME} jobs discovered: ${deduped.length}`);
  return deduped;
}
