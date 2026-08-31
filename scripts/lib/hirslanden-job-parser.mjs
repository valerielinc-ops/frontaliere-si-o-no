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
 *   - Title in <span itemprop="title"> (inside the page <h1>)
 *   - Real per-job description in <span itemprop="description"> (microdata):
 *     <p> intro + <h2><b>DEINE AUFGABEN</b></h2> / <ul><li> blocks. NOTE the
 *     page-level <div id="content"> is the SF main wrapper (it holds the search/
 *     job-alert widget, NOT the role body) — scraping it yielded the same chrome
 *     for every job, so 96% of descriptions collapsed onto the boilerplate
 *     fallback (the duplicate-listings audit critical, #1752).
 *   - Apply link: /talentcommunity/apply/{jobId}/?locale=de_DE
 *
 * Hirslanden operates 17+ private clinics across Switzerland — each job's
 * location is in the table cell. We canton-resolve via inferSwissTargetCanton.
 *
 * Source: https://careers.mediclinic.com/Hirslanden/search
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { rescueHtmlIfChallenged, fetchHtmlViaJinaWithRetry } from './jina-proxy.mjs';
import { isConnectionLevelFetchError, WAF_IP_BLOCK_STATUS } from './transient-fetch.mjs';
import { inferSwissTargetCanton, isKnownSwissCity } from './target-swiss-locations.mjs';
import { stripContactPII } from './strip-contact-pii.mjs';
import { isSuccessFactorsWidgetText, sanitizeSuccessFactorsField } from './successfactors-jobs2web-widget-guard.mjs';
import { parseSuccessFactorsMicrodataLocation } from './successfactors-shared-job-parser-common.mjs';

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
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|lehrling|lernend|apprenti|ausbildung|trainee|studierend)/.test(t)) return 'intern';
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
 * Parse the SuccessFactors / j2w search-results page.
 *
 * Hirslanden's careers.mediclinic.com instance has migrated from the legacy
 * `<tr>/<td>` table layout to the newer div-based "tile" layout where each
 * listing is an `<a class="jobTitle-link" href="/Hirslanden/job/.../{jobId}/">`
 * with the location in a sibling `section-customfield5-value` block. We parse
 * the table layout first (older j2w skins still emit it) and, when no table
 * rows yield a job, fall back to the tile layout so a SF skin swap does not
 * silently zero the crawler.
 *
 * Returns array of { title, url, location, postedDate, jobId }.
 */
export function parseSearchResults(html) {
  if (!html || typeof html !== 'string') return [];
  const fromTable = parseSearchResultsTable(html);
  if (fromTable.length > 0) return fromTable;
  return parseSearchResultsTiles(html);
}

/**
 * Legacy table-row layout: each job is a `<tr>` with a `/Hirslanden/job/...`
 * link plus Title | Location | Date cells.
 */
function parseSearchResultsTable(html) {
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
    // This branch's link is a GENERIC /Hirslanden/job/ anchor with a
    // cells[0] fallback — the row most exposed to picking up the SF
    // cookie-consent / search widget instead of a real posting title.
    if (isSuccessFactorsWidgetText(title)) continue;

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
 * Newer div-based "tile" layout (current careers.mediclinic.com skin):
 *   <a class="jobTitle-link" ... href="/Hirslanden/job/{slug}/{jobId}/"> Title </a>
 *   ... <div id="job-{jobId}-...-customfield5-value"> Ort </div>
 * Each job repeats across desktop/tablet/mobile tile variants, so dedup by
 * jobId. The location lives in a `customfield5-value` div keyed by the jobId.
 */
function parseSearchResultsTiles(html) {
  const jobs = [];
  const seen = new Set();

  // `class` and `href` can appear in either attribute order in the SF skin, so
  // assert the jobTitle-link class via a zero-width lookahead rather than a
  // fixed left-to-right sequence — a future skin reordering attributes would
  // otherwise zero-match → 0 jobs until the health gate fires + a fix cycle.
  const linkRe =
    /<a(?=[^>]*class="[^"]*jobTitle-link[^"]*")[^>]*href="(\/Hirslanden\/job\/[^"]+\/(\d+)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const relUrl = m[1].replace(/&amp;/g, '&');
    const jobId = m[2];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const rawTitle = normalizeSpace(stripHtml(m[3]));
    const title = rawTitle
      .replace(/^(?:Title|Titre|Bezeichnung|Titolo|Titulo)\s*:\s*/i, '')
      .trim();
    if (!title || title.length < 3) continue;
    // Same jobTitle-link anchor can carry SF widget chrome instead of a
    // real posting title — discard the row, don't fabricate a job from it.
    if (isSuccessFactorsWidgetText(title)) continue;

    // Location: `customfield5-value` div keyed by this jobId ("Ort" field).
    let location = '';
    const locRe = new RegExp(
      `<div[^>]+id="job-${jobId}-[^"]*customfield5-value"[^>]*>([\\s\\S]*?)<\\/div>`,
      'i',
    );
    const locMatch = html.match(locRe);
    if (locMatch) location = normalizeSpace(stripHtml(locMatch[1]));

    jobs.push({
      title,
      url: `${BASE_URL}${relUrl}`,
      location,
      postedDate: '',
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
 * Convert a SuccessFactors job-body HTML fragment into structured markdown.
 *
 * The `itemprop="description"` body wraps its `<h2>`/`<ul><li>` content in
 * deeply-nested style `<div>`s. A flat inline-flatten converter (axpo's
 * `htmlToMarkdown`) collapses those lists into one paragraph, so this walker
 * recurses through containers and handles `<ul>/<ol>/<li>` and `<h*>` explicitly
 * — `- ` bullets and `## ` headings survive (keeps the audit "structured
 * content" check green). PII (recruiter phone) is stripped downstream.
 */
export function descriptionBodyToMarkdown(bodyHtml = '') {
  if (!bodyHtml || !bodyHtml.trim()) return '';
  const doc = new JSDOM(`<body>${bodyHtml}</body>`).window.document;
  const body = doc.body;
  body.querySelectorAll('script,style,noscript').forEach((n) => n.remove());

  const lines = [];
  const inlineText = (node) =>
    (node.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  const walk = (node) => {
    if (node.nodeType === 3) {
      const t = inlineText(node);
      if (t) lines.push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();

    if (tag === 'ul' || tag === 'ol') {
      let idx = 0;
      for (const li of node.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        idx += 1;
        const t = inlineText(li);
        if (t) lines.push(tag === 'ol' ? `${idx}. ${t}` : `- ${t}`);
      }
      return;
    }

    if (/^h[1-6]$/.test(tag)) {
      const t = inlineText(node);
      if (t) lines.push('', `## ${t}`, '');
      return;
    }

    if (tag === 'p') {
      const t = inlineText(node);
      if (t) lines.push('', t, '');
      return;
    }

    // Containers (div/section/span/etc): recurse so nested lists/headings are reached.
    for (const child of node.childNodes) walk(child);
  };

  for (const child of body.childNodes) walk(child);

  // De-dup consecutive identical lines, collapse blank runs.
  const out = [];
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (l === '' && out[out.length - 1] === '') continue;
    if (l !== '' && out[out.length - 1] === l) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parse a Hirslanden job detail page (SuccessFactors j2w).
 * Returns { title, description, location, applyUrl }.
 *
 * Title + description come from the SF microdata (`itemprop="title"` /
 * `itemprop="description"`) which carries the REAL per-job content. The old
 * `<div id="content">` selector matched the page main-wrapper (search widget),
 * so every job got the same chrome → boilerplate fallback → 96% duplicates.
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const doc = new JSDOM(html).window.document;

  // Title: SF microdata first, then page <h1>, then <h2> (last — <h2> on the
  // detail page are SECTION headings like "DEINE AUFGABEN", never the role title).
  // Prefer the typed body <span> and exclude void <meta>/<link> microdata nodes:
  // they carry their value in a `content=`/`href=` attribute (empty textContent),
  // and a `<meta itemprop="title">` in <head> would otherwise win by document
  // order → empty title (same first-match class as the description, #1885).
  const titleEl =
    doc.querySelector('span[itemprop="title"]') ||
    doc.querySelector('[itemprop="title"]:not(meta):not(link)') ||
    doc.querySelector('h1') ||
    doc.querySelector('h2');
  // The same selector chain can land on the SF cookie-consent / search
  // widget when the microdata title span is missing on a given render —
  // sanitize before it becomes the job's title. The listing.title fallback
  // (see caller) covers the resulting empty string.
  const title = sanitizeSuccessFactorsField(titleEl ? normalizeSpace(titleEl.textContent || '') : '');

  // Description: the real per-job body lives in <span itemprop="description">.
  // Prefer the typed body <span> and exclude void <meta>/<link> microdata nodes.
  // An unscoped `[itemprop="description"]` would match a `<meta itemprop=
  // "description">` shipped in <head> first (document order), whose `.innerHTML`
  // is empty → every description collapses to buildFallbackDescription → the
  // duplicate-listings audit critical reappears (#1885, follow-up of #1884).
  let description = '';
  const descEl =
    doc.querySelector('span[itemprop="description"]') ||
    doc.querySelector('[itemprop="description"]:not(meta):not(link)');
  if (descEl) {
    description = descriptionBodyToMarkdown(descEl.innerHTML);
  }

  // Reject SF widget garbage (cookie-consent / search / job-alert chrome)
  // that occasionally bleeds into the description — shared module, see its
  // header for why the three near-identical copies of this list got merged.
  description = sanitizeSuccessFactorsField(description);

  // Strip recruiter-contact PII (direct phone numbers) per the Privacy policy.
  if (description) description = stripContactPII(description);

  const applyMatch = html.match(/href="([^"]*talentcommunity\/apply\/\d+[^"]*)"/i);
  const applyUrl = applyMatch
    ? (applyMatch[1].startsWith('http') ? applyMatch[1] : `${BASE_URL}${applyMatch[1]}`)
    : '';

  // SuccessFactors publishes the authoritative facility in PostalAddress
  // microdata. Prefer it over the free-text Arbeitsort line, whose shape
  // varies between "clinic | city", "city – clinic" and plain prose.
  const structuredLocation = parseSuccessFactorsMicrodataLocation(html);
  let location = structuredLocation?.city || '';
  let locationEvidence = location ? 'microdata' : '';
  if (!location) {
    const arbeitsort = description.match(/Arbeitsort:\s*[^|\n]*\|\s*([^|\n]+)/i);
    if (arbeitsort) {
      location = normalizeSpace(arbeitsort[1]).replace(/^"|"$/g, '').trim();
      locationEvidence = 'description';
    }
  }
  if (location && /[<="']|viewport|content|width|home-?office/i.test(location)) location = '';

  return {
    title,
    description,
    location,
    locationEvidence,
    region: structuredLocation?.region || '',
    postalCode: structuredLocation?.postalCode || '',
    applyUrl,
  };
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
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${url}`);
      err.status = res.status;
      throw err;
    }
    // 200-but-challenge (IP-reputation WAF, cambiavalute class #1363) → Jina.
    return await rescueHtmlIfChallenged(await res.text(), url, { timeoutMs });
  } catch (err) {
    clearTimeout(timer);
    // Re-fetch via the Jina clean-IP proxy for two cases: (a) connection-level
    // failure (no HTTP response received — datacenter egress IP blocked, DNS
    // failure, socket reset; root cause of #1680: careers.mediclinic.com
    // unreachable from CI), and (b) an IP-reputation WAF hard status
    // (403/406/415/451, WAF_IP_BLOCK_STATUS) — the server DID respond but with
    // an anti-bot fence keyed on the datacenter IP that Jina's clean IP clears
    // (#2025). Genuine 4xx (404/410 gone, 401 auth) are NOT in the set and still
    // propagate; if Jina also fails it returns null → original error re-throws.
    if (isConnectionLevelFetchError(err) || WAF_IP_BLOCK_STATUS.has(err?.status)) {
      const html = await fetchHtmlViaJinaWithRetry(url, { timeoutMs });
      if (html != null) return html;
    }
    throw err;
  }
}

/**
 * Prefer a locality that resolves to a known Swiss city (BFS registry). The
 * detail page's free-text "Arbeitsort:" line can leak trailing SF form-field
 * noise past the real city (e.g. "Bern - Futsal Minerva Besetzung per: 1.
 * Oktober 2026") when the source HTML's <br>-separated fields collapse onto
 * one markdown paragraph line — inferSwissTargetCanton still resolves a
 * canton off a substring match, but the noise itself must never ship as
 * addressLocality. The listing-cell city is a clean structured field and is
 * the safer choice whenever the detail text isn't itself a real known city.
 */
export function resolveHirslandenLocation(detailLocationText, listingCity) {
  const detail = String(detailLocationText || '').trim();
  const listing = String(listingCity || '').trim();
  if (detail && !isKnownSwissCity(detail) && isKnownSwissCity(listing)) {
    return listing;
  }
  return detail || listing;
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
      const realLocationText = normalizeSpace(detail?.location || '') || normalizeSpace(listing.location || '');
      const location = detail?.locationEvidence === 'microdata'
        ? realLocationText
        : resolveHirslandenLocation(realLocationText, city);
      const inferredCanton = inferSwissTargetCanton(location)
        || inferSwissTargetCanton(detail?.region || '')
        || inferSwissTargetCanton(city)
        || null;
      if (realLocationText && !inferredCanton) {
        console.warn(`  ⚠️ Hirslanden: skipping unresolvable location "${realLocationText}" (${title})`);
        continue;
      }
      const canton = inferredCanton || 'ZH';
      const postalCode = detail?.postalCode || parsedPostal || '8008';

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
