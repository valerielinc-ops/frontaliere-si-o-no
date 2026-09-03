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
import { slugify, stripHtml, normalizeDescriptionBullets } from './crawler-template.mjs';
import { inferSwissTargetCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  locateTagByAttribute,
  extractBalancedTagBlock,
  USER_AGENT,
} from './hospital-custom-html-helpers.mjs';
import {
  isSuccessFactorsWidgetText,
  sanitizeSuccessFactorsField,
  stripSuccessFactorsMoreLocations,
} from './successfactors-jobs2web-widget-guard.mjs';

const PAGE_SIZE = 25; // SF CSB default — observed 78 jobs returned on a single
                      // page for ZURZACH Care, so larger sites may need it.
const DETAIL_DELAY_MS = 250;

// Boilerplate guard threshold: descriptions with fewer unique words than
// this are treated as too-thin/empty (extraction gap) rather than a real
// job description. Shared by the propertyid→microdata fallback in
// `parseCsbDetailPage` and the brand-summary fallback in `fetchAllJobs`.
const MIN_DESCRIPTION_UNIQUE_WORDS = 30;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function countUniqueWords(text = '') {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-zà-ÿäöüß\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  ).size;
}

/**
 * Local category detector that fixes a known mis-categorisation in the shared
 * `detectHealthcareCategory`: titles like "Lehrstelle Köchin" match its bare
 * `/hr/` substring (inside "Le**hr**stelle") and end up as "Risorse Umane"
 * instead of "Formazione". We check apprentice / training keywords first.
 */
function detectCategoryForSf(title = '', fallbackCategory = 'Sanità / Ospedali') {
  const t = normalize(title);
  if (/lehrstelle|lernend|ausbildung|praktik|apprend|stagia|tirocin|formaz|studierend/.test(t)) {
    return 'Formazione';
  }
  return detectHealthcareCategory(title, fallbackCategory);
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
 * Some multi-brand/global tenants (e.g. Endress+Hauser's `careers.endress.com`,
 * which fronts sub-brands like Analytik Jena) prefix the job path with a single
 * country/brand segment instead of a flat `/job/...` link, e.g.
 * `/Switzerland/job/{slug}/{jobId}/` or `/analytik-jena/job/{slug}/{jobId}/`.
 * The link regex below tolerates one optional leading path segment so both
 * shapes match.
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

    const linkMatch = rowHtml.match(/<a[^>]+href="((?:\/[a-zA-Z0-9%._-]+)?\/job\/[^"]+\/(\d+)\/?)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const relUrl = linkMatch[1].replace(/&amp;/g, '&');
    const jobId = linkMatch[2];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const title = decodeEntities(normalizeSpace(stripHtml(linkMatch[3])));
    if (!title || title.length < 3) continue;
    // A row link's anchor text can be the SF cookie-consent / search widget
    // rather than a posting title on some CSB skins — discard the row.
    if (isSuccessFactorsWidgetText(title)) continue;

    // Preferred: dedicated `<td class="colLocation hidden-phone">` cell or
    // `<span class="jobLocation">…</span>` directly. This avoids picking up
    // the title cell on layouts where mobile + desktop variants concatenate
    // title + location + department text into a single `<td>`.
    let location = '';
    const colLocationMatch = rowHtml.match(
      /<td[^>]*class="[^"]*colLocation[^"]*hidden-phone[^"]*"[^>]*>([\s\S]*?)<\/td>/i,
    ) || rowHtml.match(/<td[^>]*headers="hdrLocation"[^>]*>([\s\S]*?)<\/td>/i);
    if (colLocationMatch) {
      location = decodeEntities(normalizeSpace(stripHtml(colLocationMatch[1])));
    }

    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(decodeEntities(normalizeSpace(stripHtml(cellMatch[1]))));
    }

    // Fallback: heuristic — find the cell that looks like a location ("City,
    // CC[,…]"). We skip cells that contain the job title to avoid the
    // dual-layout issue described above.
    let postedDate = '';
    for (const cell of cells) {
      if (!location && /,\s*[A-Z]{2}(?:,|$)/.test(cell) && !cell.includes(title)) {
        location = cell;
        continue;
      }
      // ISO-ish date in the cell?
      const dm = cell.match(/(\d{4}-\d{2}-\d{2})/) || cell.match(/(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/);
      if (!postedDate && dm) postedDate = parseLooseDate(dm[1]);
    }

    // A posting open in several offices appends a nested `<small>+N
    // more&hellip;</small>` to the location cell; both the dedicated-cell read
    // and the heuristic cell scan capture it. Keep the visible office.
    location = stripSuccessFactorsMoreLocations(location);

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
 *   "Ergebnisse 1 – 25 von 78"      /  "Results 1 – 25 of 78"
 *   "Ergebnisse 1 bis 25 von 78"    /  "Results 1 to 25 of 78"   (Sonova etc.)
 */
export function extractCsbTotal(html) {
  if (!html) return 0;
  // Separator: en-dash, hyphen, non-breaking hyphen, OR "bis"/"to"/"a"/"à" word.
  const m = html.match(
    /(?:Ergebnisse|Results|R[ée]sultats|Risultati)\s+\d+\s*(?:[–\-‑]|bis|to|à|a)\s*\d+\s+(?:von|of|de|di)\s+(\d+)/i,
  );
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
  // Short fields (title, location, customfield5) live inside ONE span/element
  // and close immediately. For those we cut at the matching `</span>` to avoid
  // bleeding into the next sibling block (e.g. on Bachem, the title `<span>`
  // closes right after the title text, then unrelated brand copy follows
  // inside the layout div before the `description` propertyid). Long fields
  // (description) keep the original heuristic that looks for the next
  // propertyid / layout marker.
  const isShortField = /^(?:title|location|customfield5|customfield2|customfield1|city|country|department|shifttype|jobtype|adcode)$/i.test(propId);
  const candidates = [
    rest.indexOf('data-careersite-propertyid'),
    rest.indexOf('<!-- WIDGET BUTTON -->'),
    rest.indexOf('id="jobBottomButtons'),
    rest.indexOf('class="map-container'),
    rest.indexOf('id="applyButton'),
    rest.indexOf('<!-- end of'),
  ].filter((x) => x > 0);
  if (isShortField) {
    // Prefer the first close-span as the boundary (the propertyid attribute
    // sits on the inner span). Look in the first 4 KB to keep this cheap.
    const closeSpan = rest.slice(0, 4096).search(/<\/span\b/i);
    if (closeSpan > 0) candidates.unshift(closeSpan);
  }
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
 * Read the exact element carrying a CSB property instead of cutting at the
 * next layout marker. Long description blocks can contain nested spans and a
 * trailing sibling widget; a balanced boundary keeps the real body while
 * preventing job-alert/cookie chrome from reaching the field sanitizer.
 */
function readBalancedPropertyBlock(html, propId) {
  const loc = locateTagByAttribute(
    html,
    `data-careersite-propertyid="${propId}"`,
    { skipVoidTags: true },
  );
  if (!loc) return '';
  return extractBalancedTagBlock(loc.rest, loc.tagName);
}

/**
 * Locate a schema.org microdata field's opening tag (`itemprop="prop"`) via
 * the shared `locateTagByAttribute`. Returns `{ tagName, contentAttr, rest }`
 * — `contentAttr` is set when the element carries a `content="..."`
 * attribute (typical for `<meta>` fields like `datePosted`/`hiringOrganization`).
 * Returns `null` if not found.
 */
function locateItemprop(html, prop) {
  const loc = locateTagByAttribute(html, `itemprop="${prop}"`);
  if (!loc) return null;
  const contentMatch = loc.attrs.match(/\bcontent="([^"]*)"/i);
  return { tagName: loc.tagName, contentAttr: contentMatch ? contentMatch[1] : null, rest: loc.rest };
}

/**
 * Read a schema.org microdata field's raw inner HTML by `itemprop="..."`.
 * Returns '' when the field is expressed via a `content="..."` attribute
 * instead of inner HTML (see `readItemprop` for that case). Uses the shared
 * `extractBalancedTagBlock` so nested same-name tags (long fields like
 * `description` wrap many nested `<span>`/`<p>` blocks) don't get truncated
 * at the first inner close tag.
 */
function readItempropBlock(html, prop) {
  const loc = locateItemprop(html, prop);
  if (!loc || loc.contentAttr != null) return '';
  return extractBalancedTagBlock(loc.rest, loc.tagName);
}

/**
 * Read a schema.org microdata field by `itemprop="..."`. Returns text content
 * (with the `content="..."` attribute taking priority if present, otherwise
 * strips the element's inner HTML via `readItempropBlock`/`extractBalancedTagBlock`).
 */
function readItemprop(html, prop) {
  const loc = locateItemprop(html, prop);
  if (!loc) return '';
  if (loc.contentAttr != null) return decodeEntities(normalizeSpace(loc.contentAttr)).trim();
  return decodeEntities(normalizeSpace(stripHtml(extractBalancedTagBlock(loc.rest, loc.tagName)))).trim();
}

/**
 * Read the authoritative PostalAddress embedded by SuccessFactors detail
 * pages. This is shared by CSB and jobs2web skins; labels and free-text fields
 * differ by tenant, while these microdata names remain stable.
 */
export function parseSuccessFactorsMicrodataLocation(html) {
  if (!html || typeof html !== 'string') return null;
  const city = readItemprop(html, 'addressLocality');
  const region = readItemprop(html, 'addressRegion');
  const postalCode = readItemprop(html, 'postalCode');
  const country = readItemprop(html, 'addressCountry');
  if (!city && !region && !postalCode && !country) return null;
  return {
    city,
    region,
    postalCode,
    country,
    location: [city, region].filter(Boolean).join(', '),
  };
}

/**
 * Parse a SuccessFactors CSB job detail page.
 * Returns `{ title, descriptionHtml, descriptionText, location, applyUrl,
 *            postedDate, rateText, language }`.
 */
export function parseCsbDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const titleHtml = readPropertyBlock(html, 'title');
  // The title propertyid block can resolve to SF widget chrome (cookie
  // consent / search box) on a skin variant — sanitize so the factory's
  // listing.title fallback (see createSuccessFactorsParser) takes over.
  const title = sanitizeSuccessFactorsField(decodeEntities(normalizeSpace(stripHtml(titleHtml))));

  let descriptionHtml = readBalancedPropertyBlock(html, 'description')
    || readPropertyBlock(html, 'description');
  let descriptionText = htmlToText(descriptionHtml);

  // Some CSB tenants (e.g. Helsana, as of mid-2026) stopped emitting the
  // `data-careersite-propertyid="description"` attribute entirely — the
  // current template uses schema.org microdata instead
  // (`itemprop="description"`). Fall back to that when the propertyid-based
  // read is empty/too-thin, so the boilerplate guard downstream (see
  // `createSuccessFactorsParser`) doesn't fire on a plain extraction gap.
  if (countUniqueWords(descriptionText) < MIN_DESCRIPTION_UNIQUE_WORDS) {
    const fallbackHtml = readItempropBlock(html, 'description');
    const fallbackText = fallbackHtml ? htmlToText(fallbackHtml) : '';
    if (countUniqueWords(fallbackText) > countUniqueWords(descriptionText)) {
      descriptionHtml = fallbackHtml;
      descriptionText = fallbackText;
    }
  }

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
  const microdataLocation = parseSuccessFactorsMicrodataLocation(html);
  if (!city) city = microdataLocation?.city || '';
  if (!region) region = microdataLocation?.region || '';
  if (!postalCode) postalCode = microdataLocation?.postalCode || '';
  const locationFirstLine = canonicalLoc
    ? canonicalLoc[0]
    : (locationRaw.split(/\n/)[0] || microdataLocation?.location || '');

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
    // Widget chrome (cookie consent / search / job-alert) occasionally
    // bleeds into the description propertyid block or its microdata
    // fallback above — reject it here rather than ship it as a job body.
    descriptionText: sanitizeSuccessFactorsField(normalizeDescriptionBullets(descriptionText)),
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
 * @param {string} [config.sector]           Job-category sector label (default
 *   `'Sanità / Ospedali'` — this factory originated with hospital tenants; pass
 *   an explicit sector for non-healthcare tenants, e.g. industrial/finance).
 * @param {string} [config.descriptionFallbackTagline] One-sentence company
 *   tagline used only inside the thin-description boilerplate guard (default
 *   `'ist ein etablierter Schweizer Gesundheitsdienstleister'` — override for
 *   non-healthcare tenants so the rare fallback text stays factually correct).
 * @param {string} [config.fallbackCategory] Category label substituted when
 *   `detectHealthcareCategory()` (hospital-tuned, see
 *   `hospital-custom-html-helpers.mjs`) falls through to its generic
 *   `'Sanità / Ospedali'` default — set for non-healthcare tenants so titles
 *   that don't match any clinical/technical/admin/HR keyword aren't mislabeled
 *   as a hospital-sector job. Unset (default) preserves existing behavior for
 *   genuine hospital/clinic tenants.
 * @param {Object<string,string>} [config.searchParams] Extra query params for
 *   the `/search/?...` listing endpoint (e.g. `{ locationsearch: 'Switzerland' }`
 *   to restrict a multi-country SF tenant to CH jobs). The factory always sets
 *   `startrow` itself; do not include it here.
 * @param {(job: any) => boolean} [config.acceptJob] Optional final-stage filter.
 *   When the listing endpoint cannot restrict to CH (or the filter is fuzzy),
 *   return `false` to drop a parsed job. Receives the same shape as the final
 *   ParsedJob (location, canton, addressLocality, addressCountry resolved).
 * @param {boolean} [config.trustPageLangAttr=true] Whether to trust the CSB
 *   detail page's `<html lang>` / `xml:lang` attribute (`detail.language`,
 *   see `parseCsbDetailPage`) as the job's content language. Defaults to
 *   `true` for backward compatibility with existing tenants. Set `false` for
 *   tenants whose CSB template hardcodes a fixed UI locale (e.g.
 *   `lang="en-GB"`) on every page regardless of the actual job-content
 *   language (observed on SICPA, whose French Vaud postings all carry a
 *   fixed `en-GB` page lang) — in that case content language is always
 *   derived from `detectLang(descriptionText || title, defaultSourceLang)`.
 * @param {string} [config.sector='Sanità / Ospedali'] Sector label written onto
 *   every job. Defaults to the healthcare label this factory originally
 *   shipped with (all confirmed tenants so far are hospital/pharma/biotech).
 *   Override for tenants in an unrelated industry (e.g. a manufacturing or
 *   financial-services CSB tenant) so `sector` isn't silently mislabeled.
 * @param {(title: string) => string} [config.detectCategory] Category
 *   detector applied to the job title. Defaults to the shared
 *   `detectCategoryForSf` (healthcare-oriented keyword buckets, catch-all
 *   fallback `'Sanità / Ospedali'`). Override for non-healthcare tenants —
 *   the healthcare fallback otherwise mislabels any title that doesn't match
 *   a healthcare keyword (e.g. "Chemist", "Automation Technician") as
 *   healthcare.
 * @param {(title: string, companyName: string, city: string, canton?: string) => string}
 *   [config.boilerplateFallback] Thin-description fallback text builder,
 *   invoked when the detail page's real description has fewer than
 *   `MIN_DESCRIPTION_UNIQUE_WORDS` unique words. Defaults to the shared
 *   German "etablierter Schweizer Gesundheitsdienstleister" (healthcare)
 *   summary. Override for non-healthcare / non-German-primary tenants so the
 *   fallback text isn't wrong-industry and/or wrong-language, or for tenants
 *   whose thin fallback fires on (almost) every job (e.g. Helsana — see
 *   helsana-job-parser.mjs) so the fallback carries real per-job structure
 *   (bulleted, title/location-first) instead of a near-identical paragraph.
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
    sector = 'Sanità / Ospedali',
    descriptionFallbackTagline = 'ist ein etablierter Schweizer Gesundheitsdienstleister',
    fallbackCategory = 'Sanità / Ospedali',
    searchParams = null,
    acceptJob = null,
    trustPageLangAttr = true,
    detectCategory = detectCategoryForSf,
    boilerplateFallback = null,
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
      // Brand token from the domain (e.g. 'six-group' from six-group.com). Match
      // hyphen- and space-insensitively so a company named "SIX Group" still
      // matches a hyphenated domain.
      const brand = corporateHost.split('.')[0];
      const brandSpaced = brand.replace(/-/g, ' ');
      if (brand && (company.includes(brand) || company.includes(brandSpaced))) return true;
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
      // Build URL with optional extra search params (e.g. locationsearch=Switzerland)
      let url = `${baseUrl}/search/?startrow=${startrow}`;
      if (searchParams && typeof searchParams === 'object') {
        for (const [k, v] of Object.entries(searchParams)) {
          if (k === 'startrow' || v == null) continue;
          url += `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
        }
      }
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
      if (pageRows.length === 0) {
        // Fetch succeeded but parsed to zero rows — could be genuine EOF or
        // a challenge/error page rendered with a 200 status. Warn so a
        // sustained pattern is visible, since we can't tell the two apart.
        console.warn(`  ⚠️ startrow=${startrow}: parsed 0 rows — treating as end of pagination.`);
      }
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

      // Resolve city: prefer detail.city, then first comma-segment of the
      // listing location, then defaultCity. Drop country-name fallbacks like
      // "Switzerland" / "Schweiz" / "Suisse" that some SF tenants emit when
      // a job has no specific city (e.g. Tecan remote / global roles).
      const COUNTRY_TOKEN = /^(?:switzerland|schweiz|suisse|svizzera|ch)$/i;
      const detailCity = detail?.city && !COUNTRY_TOKEN.test(detail.city) ? detail.city : '';
      const listingCity = (() => {
        if (!listing.location) return '';
        const first = listing.location.split(',')[0].trim();
        return COUNTRY_TOKEN.test(first) ? '' : first;
      })();
      const city = detailCity || listingCity || defaultCity;
      const region = detail?.region || defaultCanton;
      const canton = inferSwissTargetCanton(city) || normalizeCantonCode(region) || defaultCanton;
      const postalCode = detail?.postalCode || defaultPostalCode;

      const sourceLang = (trustPageLangAttr && detail?.language && /^(de|fr|it|en)$/.test(detail.language))
        ? detail.language
        : detectLang(detail?.descriptionText || title, defaultSourceLang);

      let description = detail?.descriptionText || '';
      // Boilerplate guard: require ≥MIN_DESCRIPTION_UNIQUE_WORDS unique words
      // (same threshold `parseCsbDetailPage` uses to decide whether to fall
      // back to the microdata `itemprop="description"` read) — otherwise
      // fall back to a brand summary.
      if (countUniqueWords(description) < MIN_DESCRIPTION_UNIQUE_WORDS) {
        description = typeof boilerplateFallback === 'function'
          ? boilerplateFallback(title, companyName, city || defaultCity, canton)
          : `${title} bei ${companyName} in ${city || defaultCity}.\n\n${companyName} ${descriptionFallbackTagline}. Diese Stelle bietet ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen und vielfältige Weiterbildungsmöglichkeiten.`;
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
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't (cache miss + AI quota), the flag stays and
        // `translate-pending.yml` picks the job up out-of-band. Without this
        // flag the locale-completeness gate trips before translation can run.
        needsRetranslation: true,
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
        category: detectCategory(title, fallbackCategory),
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector,
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };

      // Optional caller-supplied filter: drop jobs that don't pass an
      // employer-specific predicate (e.g. multi-country SF tenant restricted
      // to CH). Applied AFTER detail fetch so the predicate can see the
      // resolved city / location / language.
      if (typeof acceptJob === 'function' && !acceptJob(job)) {
        await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
        continue;
      }

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
