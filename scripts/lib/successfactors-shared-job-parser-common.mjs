#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using SAP SuccessFactors Career Site
 * Builder (CSB) — the "html-jobreq" flavor.
 *
 * Tenants typically expose a vanity hostname (e.g. `karriere.zurzachcare.ch`)
 * that proxies a SuccessFactors backend (identified by `sfCompanyId`). The
 * vanity site renders:
 *
 *   GET /search/?startrow=N            → server-rendered HTML table
 *                                        rows of <a href="/job/.../{jobId}/">
 *                                        with a "Seite X von Y" / "Page X of Y"
 *                                        counter and "Ergebnisse 1–N von TOTAL"
 *                                        / "Results 1–N of TOTAL".
 *
 *   GET /job/{slug}/{jobId}/           → server-rendered HTML detail page with
 *                                        `data-careersite-propertyid="..."`
 *                                        attributes on the property blocks
 *                                        (title, description, location, …) and
 *                                        schema.org microdata
 *                                        (`itemprop="datePosted"`,
 *                                         `itemprop="hiringOrganization"`).
 *
 * Confirmed tenants in this codebase:
 *   - ZURZACHCare → karriere.zurzachcare.ch (sfCompanyId: 'ZURZACHCare')
 *
 * Notes:
 *   - The CSB output is identical across tenants — only the host, brand
 *     strings and default location vary. The HTML extraction is done with
 *     plain regex against `data-careersite-propertyid` attributes.
 *   - Detail pages can be > 90 KB; we read the `description` propertyid
 *     block (typically 3–8 KB of HTML) and strip to plain text.
 *   - Polite delay: 250 ms between detail fetches.
 *   - This factory only handles tenants whose CSB site is publicly reachable
 *     via HTTP (no Playwright / no login). For tenants that hide jobs behind
 *     a SPA, use `scripts/lib/ats-clients/successfactors-client.mjs`.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  USER_AGENT,
} from './hospital-custom-html-helpers.mjs';

const PAGE_SIZE = 25; // SF CSB default — observed 78 jobs returned on a single
                      // page for ZURZACH Care, so larger sites may need it.
const DETAIL_DELAY_MS = 250;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/**
 * Local category detector that fixes a known mis-categorisation in the shared
 * `detectHealthcareCategory`: titles like "Lehrstelle Köchin" match its bare
 * `/hr/` substring (inside "Le**hr**stelle") and end up as "Risorse Umane"
 * instead of "Formazione". We check apprentice / training keywords first.
 */
function detectCategoryForSf(title = '') {
  const t = normalize(title);
  if (/lehrstelle|lernend|ausbildung|praktik|apprend|stagia|tirocin|formaz|studierend/.test(t)) {
    return 'Formazione';
  }
  return detectHealthcareCategory(title);
}

/* ── Listing page parser ──────────────────────────────────── */

/**
 * Extract job listings from a SuccessFactors CSB `/search/` page.
 * Returns array of `{ relUrl, jobId, title, location, postedDate }`.
 *
 * The CSB table layout looks like:
 *
 *   <tr ...>
 *     <td class="jobTitle-column ..."><a href="/job/{slug}/{jobId}/">{Title}</a></td>
 *     <td class="jobLocation ..."> ... City, Region, CH, Postal ... </td>
 *     <td class="jobDepartment ..."> ... </td>
 *     <td class="jobDate ..."> ... ISO date ... </td>
 *   </tr>
 *
 * We don't rely on column order — we extract the link + each cell's text and
 * use heuristics to identify the location cell and date cell.
 */
export function parseCsbSearchResults(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const linkMatch = rowHtml.match(/<a[^>]+href="(\/job\/[^"]+\/(\d+)\/?)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const relUrl = linkMatch[1].replace(/&amp;/g, '&');
    const jobId = linkMatch[2];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const title = decodeEntities(normalizeSpace(stripHtml(linkMatch[3])));
    if (!title || title.length < 3) continue;

    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(decodeEntities(normalizeSpace(stripHtml(cellMatch[1]))));
    }

    // Find the cell that looks like a location: contains "CH" / a 4-digit
    // postal code / a canton code, OR matches a known city pattern.
    let location = '';
    let postedDate = '';
    for (const cell of cells) {
      if (!location && /,\s*[A-Z]{2}(?:,|$)/.test(cell)) {
        location = cell;
        continue;
      }
      // ISO-ish date in the cell?
      const dm = cell.match(/(\d{4}-\d{2}-\d{2})/) || cell.match(/(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/);
      if (!postedDate && dm) postedDate = parseLooseDate(dm[1]);
    }

    out.push({ relUrl, jobId, title, location, postedDate });
  }

  return out;
}

function parseLooseDate(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

/**
 * Extract total result count from CSB `/search/` HTML.
 *   "Ergebnisse 1 – 25 von 78"  /  "Results 1 – 25 of 78"
 */
export function extractCsbTotal(html) {
  if (!html) return 0;
  const m = html.match(/(?:Ergebnisse|Results|R[ée]sultats|Risultati)\s+\d+\s*[–\-‑]\s*\d+\s+(?:von|of|de|di)\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/* ── Detail page parser ──────────────────────────────────── */

/**
 * Read a CSB `data-careersite-propertyid="..."` block from the page HTML.
 * Returns the raw inner HTML (caller decides if they want text).
 *
 * CSB nests these blocks inside other layout divs; we read until the next
 * propertyid block, the apply button widget, or a layout closer.
 */
function readPropertyBlock(html, propId) {
  const re = new RegExp(`data-careersite-propertyid="${propId}"[^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = html.slice(start);
  const candidates = [
    rest.indexOf('data-careersite-propertyid'),
    rest.indexOf('<!-- WIDGET BUTTON -->'),
    rest.indexOf('id="jobBottomButtons'),
    rest.indexOf('class="map-container'),
    rest.indexOf('id="applyButton'),
    rest.indexOf('<!-- end of'),
  ].filter((x) => x > 0);
  let cut = candidates.length ? Math.min(...candidates) : 8000;
  // The propertyid attribute lives inside an HTML tag opener (`<span ... data-careersite-propertyid="..."...>`).
  // If we cut at the attribute position, we leave an unclosed `<span` in the
  // captured slice — and `stripHtml` only removes `<...>` pairs with a
  // closing `>`. Walk back to the previous `<` so the truncated opener is
  // dropped cleanly.
  if (candidates.length) {
    const before = rest.slice(0, cut);
    const lastLt = before.lastIndexOf('<');
    if (lastLt > 0) cut = lastLt;
  }
  return rest.slice(0, cut);
}

/**
 * Read a schema.org microdata field by `itemprop="..."`. Returns text content
 * (with the `content="..."` attribute taking priority if present).
 */
function readItemprop(html, prop) {
  const re = new RegExp(`itemprop="${prop}"[^>]*?(?:content="([^"]+)"|>([\\s\\S]{0,1500}?)</)`, 'i');
  const m = html.match(re);
  if (!m) return '';
  return decodeEntities(normalizeSpace(stripHtml(m[1] || m[2] || ''))).trim();
}

/**
 * Parse a SuccessFactors CSB job detail page.
 * Returns `{ title, descriptionHtml, descriptionText, location, applyUrl,
 *            postedDate, rateText, language }`.
 */
export function parseCsbDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const titleHtml = readPropertyBlock(html, 'title');
  const title = decodeEntities(normalizeSpace(stripHtml(titleHtml)));

  const descriptionHtml = readPropertyBlock(html, 'description');
  const descriptionText = htmlToText(descriptionHtml);

  const locationHtml = readPropertyBlock(html, 'location');
  // CSB location block usually starts with "City, Region, CH, Postal" then a
  // sibling inline style block + secondary fields. Grab the first comma-line.
  const locationRaw = decodeEntities(normalizeSpace(stripHtml(locationHtml)));
  // Match a canonical SF location pattern "City, RR, CC[, NNNN]". Anchored to
  // the start so we ignore trailing junk like "Arbeitsbeginn: ..." that often
  // bleeds into the same plain-text block.
  const canonicalLoc = locationRaw.match(/^([^,]+),\s*([A-Z]{2}),\s*[A-Z]{2}(?:,\s*(\d{4}))?/);
  let city = '';
  let region = '';
  let postalCode = '';
  if (canonicalLoc) {
    city = canonicalLoc[1].trim();
    region = canonicalLoc[2].trim();
    postalCode = (canonicalLoc[3] || '').trim();
  } else {
    // Fallback: split on commas
    const locParts = locationRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (locParts.length >= 1) city = locParts[0];
    if (locParts.length >= 2 && /^[A-Z]{2}$/.test(locParts[1])) region = locParts[1];
    for (const p of locParts) {
      const pm = p.match(/^(\d{4})\b/);
      if (pm) { postalCode = pm[1]; break; }
    }
  }
  const locationFirstLine = canonicalLoc ? canonicalLoc[0] : locationRaw.split(/\n/)[0];

  // Customfield5 is usually "Workload" on CSB sites (e.g. "100%", "80–100%")
  const rateHtml = readPropertyBlock(html, 'customfield5');
  const rateText = decodeEntities(normalizeSpace(stripHtml(rateHtml)));

  // schema.org microdata for date and apply link
  const postedDate = (() => {
    const raw = readItemprop(html, 'datePosted');
    if (!raw) return '';
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  })();

  // Apply URL — try the SF "/talentcommunity/apply/{jobId}" pattern.
  const applyMatch = html.match(/href="([^"]*talentcommunity\/apply\/[^"]+)"/i)
    || html.match(/href="(\/apply\?[^"]*jobId=[^"]+)"/i)
    || html.match(/href="([^"]*Apply[^"]*\?[^"]*jobReqId=[^"]+)"/i);
  const applyUrl = applyMatch ? applyMatch[1] : '';

  // Page locale: look at the lang attribute or xml:lang in description
  const langMatch = html.match(/<html[^>]+lang="([a-z]{2})/i)
    || (descriptionHtml || '').match(/xml:lang="([a-z]{2})/i);
  const language = langMatch ? langMatch[1].toLowerCase() : '';

  return {
    title,
    descriptionHtml,
    descriptionText,
    location: locationFirstLine,
    city,
    region,
    postalCode,
    rateText,
    postedDate,
    applyUrl,
    language,
  };
}

/* ── Factory ──────────────────────────────────────────────── */

/**
 * Build a parser bundle for one SuccessFactors CSB tenant.
 *
 * @param {Object} config
 * @param {string} config.companyKey         Internal slug (e.g. 'zurzach-care').
 * @param {string} config.companyName        Brand string (e.g. 'ZURZACH Care').
 * @param {string} config.companyDomain      Public domain (e.g. 'zurzachcare.ch').
 * @param {string} config.sfCompanyId        SuccessFactors tenant code (e.g. 'ZURZACHCare').
 * @param {string} config.publicCareerUrl    Base URL (e.g. 'https://karriere.zurzachcare.ch').
 * @param {string} config.defaultCanton      ISO canton (e.g. 'AG').
 * @param {string} config.defaultCity        Fallback city.
 * @param {string} config.defaultPostalCode  Fallback postal code (e.g. '5330').
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.sourceLabel]      Optional source label override.
 * @returns {{
 *   fetchAllJobs: () => Promise<ParsedJob[]>,
 *   isCompanyJob: (job: any) => boolean,
 *   isTrustedDomain: (url: string) => boolean,
 * }}
 */
export function createSuccessFactorsParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    sfCompanyId,
    publicCareerUrl,
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    defaultSourceLang = 'de',
    sourceLabel,
  } = config;

  if (!companyKey || !companyName || !sfCompanyId || !publicCareerUrl || !defaultCanton) {
    throw new Error('createSuccessFactorsParser: missing required config');
  }

  const baseUrl = publicCareerUrl.replace(/\/+$/, '');
  const careerHost = new URL(baseUrl).hostname.toLowerCase();
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost) {
      const brand = corporateHost.split('.')[0];
      if (brand && company.includes(brand)) return true;
      if (url.includes(corporateHost)) return true;
    }
    if (careerHost && url.includes(careerHost)) return true;
    if (url.includes(`company=${sfCompanyId.toLowerCase()}`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (careerHost && (host === careerHost || host.endsWith(`.${careerHost}`))) return true;
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (host.endsWith('.successfactors.eu') || host.endsWith('.successfactors.com')) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${baseUrl}/search/ (SuccessFactors CSB, sfCompanyId=${sfCompanyId})\n`);

    // Step 1 — walk listing pages
    const listings = [];
    const seenIds = new Set();
    let startrow = 0;
    let total = 0;
    let pages = 0;
    while (true) {
      pages += 1;
      if (pages > 200) break; // hard stop safety
      const url = `${baseUrl}/search/?startrow=${startrow}`;
      let html;
      try {
        html = await fetchHtml(url);
      } catch (err) {
        if (startrow === 0) {
          throw new Error(`Failed to fetch ${url}: ${err?.message || err}`);
        }
        console.warn(`  ⚠️ Pagination failed at startrow=${startrow}: ${err?.message || err}`);
        break;
      }
      const pageRows = parseCsbSearchResults(html);
      if (total === 0) total = extractCsbTotal(html) || 0;

      let added = 0;
      for (const r of pageRows) {
        if (seenIds.has(r.jobId)) continue;
        seenIds.add(r.jobId);
        listings.push(r);
        added += 1;
      }
      console.log(`  📄 startrow=${startrow}: +${added} (total seen so far: ${listings.length}${total ? `/${total}` : ''})`);

      // Stop conditions:
      if (added === 0) break;
      if (total > 0 && listings.length >= total) break;
      // CSB returns ALL jobs on the first page when total ≤ page-size; in that
      // case `total` was already extracted and we stopped above. If the site
      // didn't expose the counter, we paginate via PAGE_SIZE.
      if (pageRows.length < PAGE_SIZE && total === 0) break;

      startrow += PAGE_SIZE;
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    if (!listings.length) {
      console.warn(`⚠️ No listings found on ${baseUrl}/search/`);
      return [];
    }
    console.log(`  📋 Total listings discovered: ${listings.length}\n`);

    // Step 2 — fetch detail pages
    const jobs = [];
    for (const listing of listings) {
      const fullUrl = `${baseUrl}${listing.relUrl}`;
      let detail = null;
      try {
        const detailHtml = await fetchHtml(fullUrl);
        detail = parseCsbDetailPage(detailHtml);
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed for ${listing.title} (${listing.jobId}): ${err?.message || err}`);
      }

      const title = (detail?.title || listing.title || '').trim();
      if (!title) continue;

      const city = detail?.city
        || (listing.location ? listing.location.split(',')[0].trim() : '')
        || defaultCity;
      const region = detail?.region || defaultCanton;
      const canton = inferSwissTargetCanton(city) || region || defaultCanton;
      const postalCode = detail?.postalCode || defaultPostalCode;

      const sourceLang = (detail?.language && /^(de|fr|it|en)$/.test(detail.language))
        ? detail.language
        : detectLang(detail?.descriptionText || title, defaultSourceLang);

      let description = detail?.descriptionText || '';
      // Boilerplate guard: require ≥30 unique words (matches the threshold
      // mentioned in the task spec) — otherwise fall back to a brand summary.
      const uniqueWords = new Set(
        description.toLowerCase().replace(/[^a-zà-ÿäöüß\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
      );
      if (uniqueWords.size < 30) {
        description = `${title} bei ${companyName} in ${city || defaultCity}.\n\n${companyName} ist ein etablierter Schweizer Gesundheitsdienstleister. Diese Stelle bietet ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen und vielfältige Weiterbildungsmöglichkeiten.`;
      }

      const postedDate = detail?.postedDate
        || listing.postedDate
        || new Date().toISOString().slice(0, 10);

      const urlHash = createHash('sha1').update(fullUrl).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${title} ${companyKey} ${city}`);
      const employmentType = detectHealthcareEmploymentType(`${title} ${detail?.rateText || ''}`);
      const applyUrl = detail?.applyUrl
        ? (detail.applyUrl.startsWith('http') ? detail.applyUrl : `${baseUrl}${detail.applyUrl}`)
        : fullUrl;

      const job = {
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        location: city,
        canton,
        url: fullUrl,
        source: sourceLabel || `${companyName} Dedicated Parser (SuccessFactors CSB)`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: city,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode,
        category: detectCategoryForSf(title),
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };
      jobs.push(job);

      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    // Deduplicate by URL
    const seen = new Set();
    const deduped = [];
    for (const job of jobs) {
      const k = job.url.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(job);
    }
    console.log(`\n📋 Total unique ${companyName} jobs: ${deduped.length}`);
    return deduped;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}

/* ── Internal exports for tests ───────────────────────────── */
export const __internals = { parseLooseDate, USER_AGENT };
