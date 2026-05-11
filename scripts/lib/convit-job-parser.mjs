/**
 * Convit Holding GmbH — careers-page.com (Manatal ATS) parser
 *
 * Listing page: https://www.careers-page.com/convit-holding-gmbh
 *   - Jobs in <li class="list-group-item"> with <a href="/convit-holding-gmbh/job/{CODE}">
 *
 * Detail page: https://www.careers-page.com/convit-holding-gmbh/job/{CODE}
 *   - Title in <h1 class="...job-position-break">
 *   - Description in <div class="col-md-9"> after "Stellenbeschreibung"
 *   - Location in <h5> after "Arbeitsplatz" with <span class="fa fa-map-marker">
 *   - JSON-LD JobPosting in <script type="application/ld+json">
 */

import { JSDOM } from 'jsdom';
import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('convit');

const BASE_URL = 'https://www.careers-page.com';
const COMPANY_SLUG = 'convit-holding-gmbh';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/**
 * Parse the listing page HTML and return an array of { title, code, detailUrl }
 */
export function parseConvitListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const items = [...document.querySelectorAll('li.list-group-item')];
  const seen = new Set();
  const results = [];

  for (const li of items) {
    const anchor = li.querySelector('a[href*="/job/"]');
    if (!anchor) continue;
    const href = String(anchor.getAttribute('href') || '').trim();
    const match = href.match(/\/job\/([A-Za-z0-9]+)/);
    if (!match) continue;
    const code = match[1];
    if (seen.has(code)) continue;
    seen.add(code);

    const titleSpan = anchor.querySelector('span.job-position-break');
    const title = normalizeSpace(titleSpan?.textContent || anchor.textContent || '');
    if (!title) continue;

    results.push({
      title,
      code,
      detailUrl: `${BASE_URL}/${COMPANY_SLUG}/job/${code}`,
      applyUrl: `${BASE_URL}/${COMPANY_SLUG}/job/${code}/apply`,
    });
  }

  return results;
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
  const regionLabel = canton === 'GR' ? 'Grigioni' : 'Ticino';
  const regionLabelDe = canton === 'GR' ? 'Graubünden' : 'Tessin';
  const regionLabelFr = canton === 'GR' ? 'Grisons' : 'Tessin';
  const defaultCity = canton === 'GR' ? 'Graubünden' : 'Massagno';
  const location = String(job.location || '').trim() || defaultCity;
  const description = String(job.description || '').trim();

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
export function isConvitTicinoRelevant(location = '') {
  const loc = normalizeSpace(location);
  if (!loc) return true; // Convit is known TI company — include if no location
  return isTargetSwissLocation(loc);
}

/**
 * Infer canton (TI or GR) from location text. Falls back to HQ canton for Convit's home base.
 */
export function inferConvitCanton(location = '') {
  return inferAnyCanton(location) || HQ.canton;
}
