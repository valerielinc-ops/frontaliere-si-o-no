/**
 * Heineken Switzerland (Calanda Brewery) job parser — Playwright DOM scraper.
 *
 * The legacy SuccessFactors / Jobs2Web search portal at
 * `https://careers.theheinekencompany.com/Switzerland/search` was retired in
 * early 2026 and now 301-redirects to the new Drupal-backed careers site at
 * `/Deutsch/HEINEKEN-Schweiz`. The new site:
 *   - Blocks plain HTTP with a 403 (Cloudflare-ish + bot-UA detection) when
 *     fetched with our `FrontaliereTicinoBot/1.0` UA. A real Chromium with
 *     a browser-grade UA gets through without challenge.
 *   - Renders jobs as `<a href="/job/heineken-switzerland/switzerland/{slug}">`
 *     links inside `/Deutsch/job-listing?operatings_company[]=519` (519 is the
 *     internal Drupal taxonomy id for "HEINEKEN Switzerland").
 *   - Detail pages expose `Location: City, Country` and `Function: Department`
 *     in the body, and link out to SuccessFactors apply URLs that carry the
 *     stable `career_job_req_id=<NNNNN>` (used as the stable job match id).
 *
 * Source: https://careers.theheinekencompany.com/Deutsch/job-listing?operatings_company[]=519
 *
 * Backed by the shared `playwright-runtime.mjs` helper. The runtime's default
 * UA is a bot string ("FrontaliereTicino-Bot/1.0") which the new site blocks;
 * we override it via `createPoliteContext`.
 *
 * Exports kept stable for the crawler runner and tests:
 *   - fetchAllHeinekenChJobs()           — main entry point (Playwright)
 *   - isHeinekenChJob() / isTrustedDomain()
 *   - parseSearchResults() / parseDetailPage() / parseDate() / parseLocation()
 *   - detectCategory() / detectEmploymentType() / extractTotalResults()
 *   - buildFallbackDescription()
 *   - HEINEKEN_CH_KEY / HEINEKEN_CH_COMPANY_NAME / HEINEKEN_CH_COMPANY_DOMAIN
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';
import {
  createBrowser,
  createPoliteContext,
  fetchWithRateLimit,
  closeAll,
  AntiBotBlockError,
  NavigationTimeout,
} from './ats-clients/playwright-runtime.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const HQ = getCompanyDefaults('heineken-ch');

const BASE_URL = 'https://careers.theheinekencompany.com';
// `operatings_company[]=519` is the Drupal taxonomy term id for
// "HEINEKEN Switzerland" on the new careers site (verified 2026-05-13).
const LISTING_URL = `${BASE_URL}/Deutsch/job-listing?operatings_company%5B0%5D=519`;

export const HEINEKEN_CH_KEY = 'heineken-ch';
export const HEINEKEN_CH_COMPANY_NAME = 'Heineken Switzerland';
export const HEINEKEN_CH_COMPANY_DOMAIN = 'theheinekencompany.com';

// New site blocks our default bot UA — use a realistic Safari UA.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Cloudflare on Heineken's CDN throttles aggressively: 1.5s between detail
// pages reliably triggers a 429 + "Just a moment…" challenge after the 2nd
// request. 8s gives clean back-to-back fetches; falls back gracefully to
// templated descriptions when CF still throttles (typical from a sticky IP).
const PER_DETAIL_DELAY_MS = 8000;
const LISTING_WAIT_SELECTOR_MS = 20_000;
const DETAIL_WAIT_SELECTOR_MS = 15_000;
const MIN_DETAIL_DESCRIPTION_LEN = 200;

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
 * Extract city and postal code from a Heineken location string.
 * Old format: "Chur, CH, 7000". New format: "Chur, Switzerland". Both supported.
 */
export function parseLocation(raw = '') {
  const text = normalizeSpace(raw);
  if (!text) return { city: HQ.city, postalCode: HQ.postalCode };

  // Try old SuccessFactors format with postal code first
  const oldFmt = text.match(/^([^,]+),\s*CH(?:,\s*(\d{4}))?/i);
  if (oldFmt) {
    return {
      city: normalizeSpace(oldFmt[1]) || HQ.city,
      postalCode: oldFmt[2] || '',
    };
  }

  // New Drupal format: "City, Switzerland" or just "City"
  const newFmt = text.match(/^([^,]+)(?:,\s*Switzerland|,\s*Schweiz|,\s*Suisse|,\s*Svizzera)?/i);
  const city = newFmt ? normalizeSpace(newFmt[1]) : text;
  return { city: city || HQ.city, postalCode: '' };
}

/* ── Legacy parsers (kept for tests + backwards compat) ──── */

/**
 * Parse legacy SuccessFactors search results HTML. Kept for tests; the
 * new fetchAllHeinekenChJobs() pipeline scrapes the Drupal listing via
 * Playwright instead.
 */
export function parseSearchResults(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  const seen = new Set();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const linkMatch = rowHtml.match(/<a[^>]+href="(\/Switzerland\/job\/[^"]+\/(\d+)\/?)"/i);
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

    const titleFromLink = rowHtml.match(/<a[^>]+href="\/Switzerland\/job\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const rawTitle = titleFromLink
      ? normalizeSpace(stripHtml(titleFromLink[1]))
      : cells[0];
    const title = rawTitle.replace(/^(?:Title|Titre|Bezeichnung|Titolo|Titulo)\s*:\s*/i, '').trim();

    if (!title || title.length < 3) continue;

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
 * Extract total results count from a legacy search page (kept for tests).
 */
export function extractTotalResults(html) {
  if (!html) return 0;
  const m = html.match(/(?:Ergebnisse|Results)\s+\d+\s*[–-]\s*\d+\s+(?:von|of)\s+(\d+)/i);
  return m ? parseInt(m[1]) : 0;
}

/**
 * Parse a Heineken legacy SuccessFactors detail page (kept for tests).
 * The new Drupal detail pages are scraped via Playwright in
 * fetchDetailPage() below.
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  let descriptionHtml = '';

  const contentMatch = html.match(/<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*id="(?:footer|sidebar)|<footer)/i);
  if (contentMatch) {
    descriptionHtml = contentMatch[1];
  }

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
    if (parts.length > 0) {
      descriptionHtml = parts.join('\n\n');
    }
  }

  let description = normalizeSpace(stripHtml(descriptionHtml));

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

  const applyMatch = html.match(/href="([^"]*talentcommunity\/apply\/\d+[^"]*)"/i);
  const applyUrl = applyMatch
    ? (applyMatch[1].startsWith('http') ? applyMatch[1] : `${BASE_URL}${applyMatch[1]}`)
    : '';

  const strippedHtml = html.replace(/<[^>]*>/g, '\n').replace(/[^\S\n]+/g, ' ');
  const locMatch = strippedHtml.match(/(?:Ort|Standort|Location)\s*:?\s*([A-ZÀ-Ü][A-Za-zÀ-ÿ\s\-/]{2,40}?)(?:\s*(?:,|\n|$))/i);
  let location = locMatch ? normalizeSpace(locMatch[1]).replace(/^"|"$/g, '').trim() : '';
  if (location && /[<="']|viewport|content|width/i.test(location)) {
    location = '';
  }

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
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
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

/* ── Playwright DOM extraction ─────────────────────────────── */

async function safeClose(page) {
  try { await page.close(); } catch { /* no-op */ }
}

/**
 * Render the Swiss-only job listing page and return discovered job links.
 *
 * Each row in the new Drupal listing is just an `<a href="/job/...">` link
 * plus an "Ansicht" CTA pointing to the same URL — there is no card-level
 * department / location metadata, so we have to follow each detail page.
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<Array<{ title: string, href: string }>>}
 */
async function fetchListingRows(context) {
  let renderedPage;
  try {
    renderedPage = await fetchWithRateLimit(context, LISTING_URL, { minDelayMs: 0 });
  } catch (err) {
    if (err instanceof AntiBotBlockError) {
      console.warn(`⚠️ Heineken listing anti-bot block: ${err.message}`);
      return [];
    }
    if (err instanceof NavigationTimeout) {
      console.warn(`⚠️ Heineken listing navigation timeout: ${err.message}`);
      return [];
    }
    throw err;
  }

  try {
    await renderedPage.waitForSelector('a[href*="/job/heineken-switzerland/"]', {
      timeout: LISTING_WAIT_SELECTOR_MS,
      state: 'attached',
    });
  } catch {
    console.warn('   Listing: no Heineken Switzerland job links rendered within timeout');
    await safeClose(renderedPage);
    return [];
  }

  const rows = await renderedPage.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/job/heineken-switzerland/"]')];
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const title = (a.textContent || '').trim();
      // Skip "Ansicht" / "View" CTAs — they share the same href as the
      // titled link and the deduplication above already collapses them.
      if (!title || /^(ansicht|view|voir|leggi|details?)$/i.test(title)) continue;
      out.push({ href, title });
    }
    return out;
  });

  await safeClose(renderedPage);
  return rows;
}

/**
 * Open one detail page and extract title, location, function, description,
 * and apply URL.
 *
 * Reuses the BrowserContext passed in — the Cloudflare clearance cookie
 * carries over from the listing pass, so detail navigations don't refire
 * the bot challenge.
 *
 * Returns `null` on any failure (anti-bot, timeout, missing markup, or
 * description shorter than `MIN_DETAIL_DESCRIPTION_LEN`).
 */
async function fetchDetailPage(context, url) {
  let page;
  try {
    page = await fetchWithRateLimit(context, url, { minDelayMs: PER_DETAIL_DELAY_MS });
    await page.waitForSelector('article', {
      timeout: DETAIL_WAIT_SELECTOR_MS,
      state: 'attached',
    }).catch(() => { /* fall through */ });

    const data = await page.evaluate(() => {
      const article = document.querySelector('article');
      const articleText = (article?.innerText || '').trim();

      // Apply URL — the page exposes a "Bewerben" / "Apply Now" link
      // pointing to SuccessFactors. The href contains the stable
      // `career_job_req_id=<NNNNN>` we use for merge/dedup stability.
      const applyLink = [...document.querySelectorAll('a[href]')]
        .find((a) => /apply\s*now|jetzt\s*bewerben|bewerben|postuler|candidat/i.test(a.textContent || ''));

      return {
        articleText,
        applyHref: applyLink?.getAttribute('href') || '',
        h1: document.querySelector('h1')?.innerText || '',
        docTitle: document.title || '',
      };
    });

    await safeClose(page);
    page = null;

    if (!data.articleText) return null;

    const { articleText } = data;
    const locMatch = articleText.match(/Location\s*:?\s*([^\n]+)/i)
      || articleText.match(/Standort\s*:?\s*([^\n]+)/i)
      || articleText.match(/Ort\s*:?\s*([^\n]+)/i);
    const funcMatch = articleText.match(/Function\s*:?\s*([^\n]+)/i)
      || articleText.match(/Funktion\s*:?\s*([^\n]+)/i)
      || articleText.match(/Bereich\s*:?\s*([^\n]+)/i);

    // Title: the article starts with "<companyName>\nBack to Job Search\nApply Now\n<jobTitle>\nLocation: ...".
    // Use the page's <title> as the primary source; fall back to the first
    // non-boilerplate line of the article.
    let title = normalizeSpace(data.docTitle.replace(/\s*[|–]\s*HEINEKEN.*$/i, '').trim());
    if (!title || title.length < 3) {
      const lines = articleText.split('\n').map((s) => s.trim()).filter(Boolean);
      const skip = /^(heineken|back to|apply now|jetzt bewerben|postuler|home)/i;
      title = lines.find((l) => !skip.test(l) && l.length > 3) || '';
    }

    // Description: everything after the "Function: ..." line, stripped of
    // the trailing "Apply Now" CTAs.
    let description = articleText;
    const funcAnchor = articleText.search(/Function\s*:?\s*[^\n]+/i);
    if (funcAnchor >= 0) {
      description = articleText
        .slice(funcAnchor)
        .replace(/^Function\s*:?\s*[^\n]+\n*/i, '');
    }
    description = description
      .replace(/(?:apply\s*now|jetzt\s*bewerben|postuler|candidat)[\s\S]*$/i, '')
      .trim();
    description = normalizeSpace(description);

    // Extract the SuccessFactors stable id from the apply URL (used as the
    // jobMatchKey by the dedup pipeline — see notes on `job.url` below).
    const jobReqId =
      (data.applyHref || '').match(/career_job_req_id=(\d+)/i)?.[1] || '';

    if (description.length < MIN_DETAIL_DESCRIPTION_LEN) {
      return {
        title,
        location: normalizeSpace(locMatch?.[1] || ''),
        department: normalizeSpace(funcMatch?.[1] || ''),
        description: '',
        applyUrl: data.applyHref || '',
        jobReqId,
      };
    }

    return {
      title,
      location: normalizeSpace(locMatch?.[1] || ''),
      department: normalizeSpace(funcMatch?.[1] || ''),
      description,
      applyUrl: data.applyHref || '',
      jobReqId,
    };
  } catch (err) {
    if (err instanceof AntiBotBlockError) {
      console.warn(`   ⚠️ Anti-bot block on detail ${url}: ${err.message}`);
    } else if (err instanceof NavigationTimeout) {
      console.warn(`   ⚠️ Detail navigation timeout: ${url}`);
    } else {
      console.warn(`   ⚠️ Detail fetch error on ${url}: ${err?.message || err}`);
    }
    return null;
  } finally {
    if (page) await safeClose(page);
  }
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Heineken Switzerland jobs from the public careers portal.
 *
 * Returns an array of ParsedJob objects with source-locale (de) fields only.
 * Other locales are filled by the AI localization step.
 */
export async function fetchAllHeinekenChJobs() {
  console.log('🍺 Fetching Heineken Switzerland jobs via Playwright');
  console.log(`   Source: ${LISTING_URL}\n`);

  let browser;
  try {
    browser = await createBrowser({ userAgent: BROWSER_UA });
    const context = await createPoliteContext(browser, { userAgent: BROWSER_UA });

    const rows = await fetchListingRows(context);
    console.log(`  📋 Discovered ${rows.length} job links`);

    if (rows.length === 0) {
      console.warn('⚠️ No Heineken Switzerland job links found on listing page.');
      return [];
    }

    const jobs = [];
    let ok = 0;
    let fallback = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const detailUrl = row.href.startsWith('http')
        ? row.href
        : `${BASE_URL}${row.href.startsWith('/') ? '' : '/'}${row.href}`;

      const detail = await fetchDetailPage(context, detailUrl);

      const title = normalizeSpace(detail?.title || row.title);
      if (!title || title.length < 3) {
        console.warn(`   ⚠️ Skipping ${detailUrl} — missing title`);
        continue;
      }

      const rawLocation = detail?.location || '';
      const { city, postalCode: parsedPostal } = parseLocation(rawLocation);
      const location = city;
      const canton = inferSwissTargetCanton(location) || inferAnyCanton(location) || HQ.canton;
      const postalCode = parsedPostal || HQ.postalCode;
      const department = detail?.department || '';

      let description = detail?.description || '';
      if (!description || description.split(/\s+/).length < 50) {
        description = buildFallbackDescription(title, location, department);
        fallback++;
      } else {
        ok++;
      }

      // The new Drupal listing URL is `/job/heineken-switzerland/switzerland/<slug>` —
      // the `extractJobIdentityFromUrl()` heuristic in dedicated-crawler-common.mjs
      // matches `/job/<x>/<y>` and would dedupe every Swiss job down to a single
      // entry (captured = "switzerland"). Append a stable per-job identifier as
      // a `jobid` query param so the heuristic instead picks up that unique
      // value (see queryKeys at line 4162 of dedicated-crawler-common.mjs).
      // Prefer the SuccessFactors req-id when the apply-link was scraped;
      // fall back to the listing URL's terminal slug (always unique per job).
      const jobReqId = detail?.jobReqId || '';
      const urlSlugFallback =
        (row.href.match(/\/job\/heineken-switzerland\/switzerland\/([^/?#]+)/i)?.[1] || '')
          .toLowerCase();
      const stableId = jobReqId || urlSlugFallback;
      const canonicalUrl = stableId
        ? `${detailUrl}?jobid=${stableId}`
        : detailUrl;

      const urlHash = createHash('sha1').update(canonicalUrl).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${title} heineken-ch ${location}`);
      const employmentType = detectEmploymentType(title);
      const postedDate = new Date().toISOString().slice(0, 10);

      jobs.push({
        id: `${HEINEKEN_CH_KEY}-${urlHash}`,
        jobReqId: jobReqId || null,
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
        category: detectCategory(title, department),
        sector: 'Industria / Alimentare',
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectExperienceLevel(title),
        featured: false,
        postedDate,
        url: canonicalUrl,
        applyUrl: detail?.applyUrl || detailUrl,
        source: 'Heineken Switzerland Dedicated Parser (Playwright)',
        sourceLang: 'de',
        crawledAt: new Date().toISOString(),
      });

      console.log(`  ✅ ${title.substring(0, 60)} — ${location}`);
    }

    console.log(`\n  Detail enrichment: ${ok} rich, ${fallback} fallback`);

    // Deduplicate by canonical URL (which embeds the stable jobReqId).
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
  } catch (err) {
    console.error(`❌ Heineken Switzerland Playwright discovery failed: ${err?.message || err}`);
    return [];
  } finally {
    await closeAll(browser);
  }
}
