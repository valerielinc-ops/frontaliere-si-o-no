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

const HQ = getCompanyDefaults('convit');

const BASE_URL = 'https://www.careers-page.com';
const COMPANY_SLUG = 'convit-holding-gmbh';
const BASE_ORIGIN = new URL(BASE_URL).origin;
const JOB_PATH_RE = new RegExp(`^/${COMPANY_SLUG}/job/([A-Za-z0-9]+)/?$`);

function extractConvitListingCode(rawUrl = '') {
  try {
    const url = new URL(rawUrl, BASE_URL);
    if (url.origin !== BASE_ORIGIN) return '';
    return url.pathname.match(JOB_PATH_RE)?.[1] || '';
  } catch {
    return '';
  }
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

/**
 * Recognize the employer's listing document before treating an empty page as
 * the terminal pagination page. This rejects generic challenge/error pages.
 */
export function isConvitListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const canonicalSignals = [
    document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    document.querySelector('meta[property="og:url"]')?.getAttribute('content'),
  ];
  const textSignals = [
    document.title,
    document.body?.textContent,
  ];
  const source = [...canonicalSignals, ...textSignals]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return source.includes(COMPANY_SLUG) || /convit\s+holding(?:\s+gmbh)?/i.test(source);
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
    let url;
    try {
      url = new URL(href, BASE_URL);
    } catch {
      continue;
    }
    if (url.origin !== BASE_ORIGIN) continue;

    const match = url.pathname.match(JOB_PATH_RE);
    if (!match) continue;
    const code = match[1];
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
export function createConvitListingSourceValidator(listings = [], { complete = false } = {}) {
  const listedKeys = new Set(
    (Array.isArray(listings) ? listings : [])
      .map((listing) => extractConvitListingCode(listing?.detailUrl || listing?.url).toLowerCase())
      .filter(Boolean),
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
  const datePosted = jsonLd?.datePosted
    ? String(jsonLd.datePosted).slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  return { title, location, description, datePosted };
}

/**
 * Build localized content for a Convit job.
 */
export function buildConvitLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const canton = job.canton || HQ.canton;
  const regionLabel = getCantonDisplayName(canton, 'it') || canton || 'Svizzera';
  const regionLabelDe = getCantonDisplayName(canton, 'de') || canton || 'Schweiz';
  const regionLabelFr = getCantonDisplayName(canton, 'fr') || canton || 'Suisse';
  const defaultCity = regionLabel;
  const location = String(job.location || '').trim() || defaultCity;
  const description = stripLocationRegionMarkers(
    String(job.description || '').trim(),
    location,
    canton,
  );

  const itDesc = description
    || `Convit Holding GmbH ha aperto una selezione per il ruolo ${title} con sede a ${location}. Consulenza finanziaria e previdenziale in ${regionLabel}. Per candidarti utilizza il modulo ufficiale nella pagina Convit.`;
  const enDesc = `Convit Holding GmbH is hiring for the ${title} role based in ${location}. Financial and pension consulting in ${regionLabel}. Apply through the official Convit careers page.`;
  const deDesc = `Convit Holding GmbH sucht derzeit für die Position ${title} am Standort ${location}. Finanz- und Vorsorgeberatung im ${regionLabelDe}. Bewirb dich über die offizielle Karriereseite von Convit.`;
  const frDesc = `Convit Holding GmbH recrute actuellement pour le poste ${title} basé à ${location}. Conseil financier et prévoyance au ${regionLabelFr}. Postulez via la page carrière officielle de Convit.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} convit ${location}`),
      en: slugify(`${title} convit ${location}`),
      de: slugify(`${title} convit ${location}`),
      fr: slugify(`${title} convit ${location}`),
    },
  };
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
