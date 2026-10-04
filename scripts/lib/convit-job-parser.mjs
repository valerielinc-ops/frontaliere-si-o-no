import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * Convit Holding GmbH — careers-page.com (Manatal ATS) parser
 *
 * Listing page: https://www.careers-page.com/convit-holding-gmbh
 *   - Jobs expose canonical <a href="/convit-holding-gmbh/job/{CODE}"> detail links
 *
 * Detail page: https://www.careers-page.com/convit-holding-gmbh/job/{CODE}
 *   - Title in <h1 class="...job-position-break">
 *   - Description in <div class="col-md-9"> after "Stellenbeschreibung"
 *   - Location in <h5> after "Arbeitsplatz" with <span class="fa fa-map-marker">
 *   - JSON-LD JobPosting in <script type="application/ld+json">
 */

import { JSDOM } from 'jsdom';
import {
  isTargetSwissLocation,
  inferAnyCanton,
  swissCityFromLocationField,
} from './target-swiss-locations.mjs';
import { getCompanyDefaults, getCantonDisplayName } from './crawler-location-config.mjs';
import { stripLocationRegionMarkers } from './job-location-plausibility.mjs';
import { dropFabricatedLocaleText } from './source-locale-description.mjs';

const HQ = getCompanyDefaults('convit');

const BASE_URL = 'https://www.careers-page.com';
const COMPANY_SLUG = 'convit-holding-gmbh';
const BASE_ORIGIN = new URL(BASE_URL).origin;
const JOB_PATH_RE = new RegExp(`^/${COMPANY_SLUG}/job/([A-Za-z0-9]+)/?$`);
const LISTING_PATH_RE = new RegExp(`^/${COMPANY_SLUG}/?$`);

function extractConvitListingCode(rawUrl = '') {
  try {
    const url = new URL(rawUrl, BASE_URL);
    if (url.origin !== BASE_ORIGIN) return '';
    return url.pathname.match(JOB_PATH_RE)?.[1] || '';
  } catch {
    return '';
  }
}

function normalizeConvitListingKey(value = '') {
  const rawValue = String(value || '').trim();
  const codeFromUrl = extractConvitListingCode(rawValue);
  const code = codeFromUrl || rawValue;
  return /^[A-Za-z0-9]+$/.test(code) ? code.toLowerCase() : '';
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Some careers-page.com detail pages expose the employer's street address in
 * the location field, while the actual vacancy area is carried by the title,
 * e.g. "... (zona Chiasso)".  Keep the fallback deliberately narrow: only a
 * parenthesised `zona` annotation that is itself a recognised target location
 * may replace the generic address.
 */
function extractTitleLocation(title = '') {
  const match = String(title || '').match(/\(\s*zona\s+([^)]*?)\s*\)/i);
  const candidate = normalizeSpace(match?.[1] || '');
  return candidate && isTargetSwissLocation(candidate) ? candidate : '';
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00b7/g, '·')
    .replace(/\u2013/g, '–')
    .replace(/\u2019/g, "'")
    .trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

// The live Manatal career page (measured 2026-09-28) carries neither
// `<link rel="canonical">` nor `og:url`: only `<title>`/`og:title`
// "Convit Holding GmbH | Career Page" and `og:site_name` "Manatal". A generic
// Manatal 404 is titled just "Manatal", a challenge page has neither.
const CONVIT_LISTING_TITLE = 'convit holding gmbh | career page';
const MANATAL_SITE_NAME = 'manatal';

/**
 * Recognize the employer's listing document before treating an empty page as
 * the terminal pagination page. This rejects generic challenge/error pages.
 *
 * A canonical/og:url pointing at the listing path is sufficient. Without one,
 * the document must carry BOTH the employer's own career-page title (in
 * `<title>` or `og:title`) and the Manatal `og:site_name`: the title alone is
 * what an error page could echo back, the site name alone is every tenant.
 */
export function isConvitListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const canonicalUrls = [
    document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    document.querySelector('meta[property="og:url"]')?.getAttribute('content'),
  ].filter(Boolean);

  const canonicalListing = canonicalUrls.some((rawUrl) => {
    try {
      const url = new URL(rawUrl, BASE_URL);
      return url.origin === BASE_ORIGIN && LISTING_PATH_RE.test(url.pathname);
    } catch {
      return false;
    }
  });
  if (canonicalListing) return true;

  const titles = [
    document.querySelector('title')?.textContent,
    document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
  ].map((value) => normalizeSpace(value).toLowerCase());
  const siteName = normalizeSpace(
    document.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
  ).toLowerCase();
  return siteName === MANATAL_SITE_NAME && titles.includes(CONVIT_LISTING_TITLE);
}

/**
 * Return every canonical vacancy code in a listing document, including links
 * whose title markup is empty or not recognized by the title selector.
 */
export function extractConvitListingCodes(html = '') {
  const document = new JSDOM(html).window.document;
  const codes = new Set();

  for (const anchor of document.querySelectorAll('a[href]')) {
    const code = extractConvitListingCode(anchor.getAttribute('href') || '');
    if (code) codes.add(code);
  }

  return [...codes];
}

/**
 * Parse the listing page HTML and return an array of { title, code, detailUrl }
 */
export function parseConvitListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const anchors = [...document.querySelectorAll('a[href]')];
  const seen = new Set();
  const results = [];

  for (const anchor of anchors) {
    const href = String(anchor.getAttribute('href') || '').trim();
    const code = extractConvitListingCode(href);
    if (!code) continue;
    if (seen.has(code)) continue;

    const titleElement = anchor.querySelector('span.job-position-break, [class*="job-position"], [class*="job-title"]');
    const title = normalizeSpace(titleElement?.textContent || anchor.textContent || '');
    if (!title) continue;
    seen.add(code);

    results.push({
      title,
      code,
      detailUrl: `${BASE_URL}/${COMPANY_SLUG}/job/${code}`,
      applyUrl: `${BASE_URL}/${COMPANY_SLUG}/job/${code}/apply`,
    });
  }

  return results;
}

/**
 * Build the source validator used when the complete Convit listing snapshot
 * proves a shrink. careers-page.com can keep old detail pages reachable after
 * removing them from the employer's listing, so a detail-page HTTP 200 is not
 * evidence that the vacancy is still open. An incomplete/empty snapshot must
 * remain fail-open: it can never prove a job gone.
 */
export function createConvitListingSourceValidator(
  listings = [],
  { complete = false, listedCodes = [] } = {},
) {
  const listedKeys = new Set(
    [
      ...(Array.isArray(listings) ? listings : [])
        .map((listing) => normalizeConvitListingKey(listing?.detailUrl || listing?.url || listing?.code)),
      ...(Array.isArray(listedCodes) ? listedCodes : [])
        .map((code) => normalizeConvitListingKey(code)),
    ].filter(Boolean),
  );

  return async (jobs = []) => (Array.isArray(jobs) ? jobs : []).map((job) => {
    const key = extractConvitListingCode(job?.url).toLowerCase();
    const id = job?.id || key || '';
    if (!complete || listedKeys.size === 0 || !key) {
      return {
        id,
        valid: true,
        definitive: false,
        reason: !complete || listedKeys.size === 0
          ? 'incomplete-convit-listing-snapshot'
          : 'missing-convit-listing-code',
      };
    }
    if (listedKeys.has(key)) {
      return { id, valid: true, reason: 'still-in-convit-listing' };
    }
    return {
      id,
      valid: false,
      definitive: true,
      reason: 'not-in-complete-convit-listing',
    };
  });
}

const MIN_DESCRIPTION_LENGTH = 350;

/**
 * Extract the job description from the HTML DOM.
 *
 * careers-page.com renders a Bootstrap row grid:
 *   <div class="col-md-3"><h4>Stellenbeschreibung:</h4></div>
 *   <div class="col-md-9">... description HTML ...</div>
 *
 * Primary strategy: find the col-md-3 label cell containing "Stellenbeschreibung"
 * and grab the inner HTML of the adjacent col-md-9 content cell.
 * Fallback: return the largest col-md-9 div on the page.
 */
function extractDescriptionFromDom(document) {
  // Strategy 1: locate via the "Stellenbeschreibung" row label
  for (const labelCell of document.querySelectorAll('div[class*="col-md-3"], div[class*="col-lg-3"]')) {
    if (!/stellenbeschreibung/i.test(labelCell.textContent || '')) continue;
    const contentCell = labelCell.nextElementSibling;
    if (contentCell && /col-md-9|col-lg-9/.test(contentCell.className || '')) {
      const text = stripHtml(contentCell.innerHTML || '');
      if (text.length >= MIN_DESCRIPTION_LENGTH) return text;
    }
  }

  // Strategy 2: pick the largest col-md-9 div (description is always the longest)
  let best = null;
  let bestLen = 0;
  for (const div of document.querySelectorAll('div[class*="col-md-9"]')) {
    const len = (div.textContent || '').trim().length;
    if (len > bestLen) { best = div; bestLen = len; }
  }
  if (best && bestLen >= MIN_DESCRIPTION_LENGTH) return stripHtml(best.innerHTML || '');

  return '';
}

/**
 * Parse a job detail page and extract rich metadata from HTML + JSON-LD.
 */
export function parseConvitDetailPage(html = '', fallbackTitle = '') {
  const document = new JSDOM(html).window.document;

  // Extract JSON-LD JobPosting
  let jsonLd = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || '');
      if (data?.['@type'] === 'JobPosting') {
        jsonLd = data;
        break;
      }
    } catch { /* ignore */ }
  }

  // Title
  const h1 = document.querySelector('h1');
  const title = normalizeSpace(h1?.textContent || jsonLd?.title || fallbackTitle);

  // Location from HTML
  const locationH5 = document.querySelector('.fa-map-marker')?.closest('h5');
  let location = normalizeSpace(locationH5?.textContent || '');
  // Fallback: JSON-LD jobLocation
  if (!location && jsonLd?.jobLocation) {
    const jl = jsonLd.jobLocation;
    const addr = jl?.address || {};
    location = normalizeSpace(
      [addr.addressLocality, addr.addressRegion, addr.addressCountry]
        .filter(Boolean)
        .join(', '),
    );
  }

  const titleLocation = extractTitleLocation(title);
  if (titleLocation && !isTargetSwissLocation(location)) {
    location = titleLocation;
  }
  // Careers-page occasionally exposes the registered street address in both
  // HTML and JSON-LD (for example "Via al Mulino 22a, 6814 Cadempino"). The
  // location field must remain a municipality for structured data and SEO;
  // use the shared field resolver so decorated city values stay source-backed.
  const cityLocation = swissCityFromLocationField(location);
  if (cityLocation) location = cityLocation;

  // Description: prefer JSON-LD when full-length; fall back to DOM extraction
  const jsonLdDesc = stripHtml(jsonLd?.description || '');
  const description = jsonLdDesc.length >= MIN_DESCRIPTION_LENGTH
    ? jsonLdDesc
    : (extractDescriptionFromDom(document) || jsonLdDesc);

  // Date posted
  const datePosted = typeof jsonLd?.datePosted === 'string' ? jsonLd.datePosted : '';

  return { title, location, description, datePosted };
}

/**
 * Build localized content for a Convit job. The description is the posting's
 * own text (JSON-LD or detail DOM), keyed by its language (`job.sourceLang`,
 * Italian by default); the other locales are left to the translation step.
 *
 * This used to write a sentence of its own into EVERY non-source slot of every
 * job ("Convit Holding GmbH is hiring for the <title> role based in <city>.
 * Financial and pension consulting in Ticino. Apply through the official Convit
 * careers page.", and the same in German and French) and, without a source
 * text, an Italian one too. Convit publishes none of it, and because those
 * slots were full the translation step never replaced them. A posting without
 * text now gets no description and takes the pipeline's thin-source path.
 */
export function buildConvitLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const canton = job.canton || HQ.canton;
  const defaultCity = getCantonDisplayName(canton, 'it') || canton || 'Svizzera';
  const location = String(job.location || '').trim() || defaultCity;
  const description = stripLocationRegionMarkers(
    String(job.description || '').trim(),
    location,
    canton,
  );
  const sourceLang = String(job.sourceLang || '').trim() || 'it';

  return {
    description,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: description ? { [sourceLang]: description } : {},
    slugByLocale: {
      it: slugify(`${title} convit ${location}`),
      en: slugify(`${title} convit ${location}`),
      de: slugify(`${title} convit ${location}`),
      fr: slugify(`${title} convit ${location}`),
    },
  };
}

// Fossils of the former builder's sentences in stored jobs.
const CONVIT_FABRICATED_RE = /^Convit Holding GmbH (?:ha aperto una selezione per il ruolo|is hiring for the|sucht derzeit für die Position|recrute actuellement pour le poste) /;

/**
 * Remove the former builder's sentences from a stored job. The runner's merge
 * keeps existing non-source slots, so without this they would never be
 * translated from the posting.
 *
 * @returns {boolean} true when the job carried one.
 */
export function dropConvitFabricatedText(job) {
  let changed = false;
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (dropFabricatedLocaleText(job, locale, CONVIT_FABRICATED_RE)) changed = true;
  }
  if (CONVIT_FABRICATED_RE.test(String(job?.description || '').trim())) {
    job.description = '';
    job.needsRetranslation = true;
    changed = true;
  }
  return changed;
}

/**
 * Check whether a location string is relevant to any target canton.
 */
export function isConvitSwissRelevant(location = '') {
  const loc = normalizeSpace(location);
  if (!loc) return true; // Convit's registered Swiss HQ is the safe fallback.
  return isTargetSwissLocation(loc);
}

/**
 * Infer the canton from location text across all 26 Swiss cantons. Falls back
 * to the registered HQ canton only when the listing has no location signal.
 */
export function inferConvitCanton(location = '') {
  return inferAnyCanton(location) || HQ.canton;
}
