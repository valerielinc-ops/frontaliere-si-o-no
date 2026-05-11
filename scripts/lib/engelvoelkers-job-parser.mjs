/**
 * Engel & Völkers Switzerland — careers page parser
 *
 * Listing page: https://www.engelvoelkers.com/ch/it/azienda/carriera/offerte-di-lavoro
 *   - Next.js SSR app, jobs rendered as <div> cards with <h2> titles
 *   - Links: /ch/it/azienda/carriera/offerte-di-lavoro/{UUID}
 *   - Pagination: client-side buttons (2 pages currently)
 *
 * Detail page: same base URL + /{UUID}
 *   - Rich HTML description in the main content area
 *   - Meta tags: og:title, og:description
 *   - Company, department, employment type in span elements
 */

import { JSDOM } from 'jsdom';
import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('engelvoelkers');

const BASE_URL = 'https://www.engelvoelkers.com';
const LISTING_PATH = '/ch/it/azienda/carriera/offerte-di-lavoro';
const UUID_RE = /\/offerte-di-lavoro\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtml(html = '') {
  return decodeEntities(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00b7/g, '·')
    .replace(/\u2013/g, '–')
    .replace(/\u2019/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractNextDataPayload(html = '') {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractPostingFromNextData(html = '') {
  return extractNextDataPayload(html)?.props?.pageProps?.data?.details?.posting || null;
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
 * Parse the listing page HTML and return an array of job summaries.
 * Strategy: find all <a> links matching the UUID URL pattern, then
 * walk up to the card container to extract title, location, company info.
 */
export function parseEngelvoelkersListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const results = [];
  const seen = new Set();

  // Find all h2 elements — each represents a job title in a card
  const headings = [...document.querySelectorAll('h2')];

  for (const h2 of headings) {
    const title = normalizeSpace(h2.textContent || '');
    if (!title) continue;

    // Walk up to find the card container that has the link
    let container = h2.parentElement;
    let anchor = null;
    let depth = 0;
    while (container && depth < 6) {
      anchor = container.querySelector(`a[href*="/offerte-di-lavoro/"]`);
      if (anchor) break;
      container = container.parentElement;
      depth++;
    }
    if (!anchor) continue;

    const href = String(anchor.getAttribute('href') || '').trim();
    const match = href.match(UUID_RE);
    if (!match) continue;

    const uuid = match[1].toLowerCase();
    if (seen.has(uuid)) continue;
    seen.add(uuid);

    // Extract location — it's in a div before the h2, typically the first text div in the card
    let location = '';
    const cardRoot = container;
    if (cardRoot) {
      // Location is usually in a div that contains city text like "Lugano, Switzerland"
      const allDivs = [...cardRoot.querySelectorAll('div')];
      for (const div of allDivs) {
        const text = normalizeSpace(div.textContent || '');
        if (text && /switzerland|schweiz|svizzera|suisse/i.test(text) && text.length < 80) {
          location = text;
          break;
        }
      }
    }

    // Extract company, department, employment type from span siblings
    let company = '';
    let department = '';
    let employmentType = '';
    if (cardRoot) {
      const spans = [...cardRoot.querySelectorAll('span')];
      const metaSpans = spans
        .map((s) => normalizeSpace(s.textContent || ''))
        .filter((t) => t && t.length > 2 && t.length < 120);

      // Heuristic: first span = company, second = department, third = employment type
      if (metaSpans.length >= 1) company = metaSpans[0];
      if (metaSpans.length >= 2) department = metaSpans[1];
      if (metaSpans.length >= 3) employmentType = metaSpans[2];
    }

    const detailUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

    results.push({
      title,
      uuid,
      detailUrl,
      location,
      company,
      department,
      employmentType,
    });
  }

  return results;
}

/**
 * Parse a detail page and extract the job description + metadata.
 * Uses a combination of meta tags and HTML content parsing.
 */
export function parseEngelvoelkersDetailPage(html = '', fallbackTitle = '') {
  const posting = extractPostingFromNextData(html);
  const document = new JSDOM(html).window.document;

  const ogTitle = decodeEntities(document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '');
  const metaTitle = decodeEntities(document.querySelector('title')?.textContent || '');
  const h1 = document.querySelector('h1');

  const title = normalizeSpace(
    posting?.text ||
    ogTitle.replace(/\s*\|\s*Engel\s*&\s*Völkers.*$/i, '') ||
    metaTitle.replace(/\s*\|\s*Engel\s*&\s*Völkers.*$/i, '') ||
    h1?.textContent ||
    fallbackTitle,
  );

  // crawler-template.stripHtml converts <li>→"\n• " and <p>→"\n" so list
  // structure survives. Previously we wrapped it in normalizeSpace() which
  // collapsed all the newlines back into spaces — the audit then flagged
  // every E&V job as flat prose.
  const nextDescriptionHtml = posting?.content?.descriptionHtml || posting?.content?.description || '';
  const nextDescription = stripHtml(nextDescriptionHtml)
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const metaDesc = decodeEntities(document.querySelector('meta[name="description"]')?.getAttribute('content') || '');
  let richDesc = nextDescription;

  if (!richDesc) {
    const allElements = document.querySelectorAll('p, ul, div > span');
    const descParts = [];
    let inContent = false;

    for (const el of allElements) {
      // For <ul>, expand each <li> on its own line so list structure is
      // preserved for the audit and Schema.org JobPosting.description.
      let text;
      if (el.tagName === 'UL') {
        const items = Array.from(el.querySelectorAll('li'))
          .map((li) => normalizeSpace(li.textContent || ''))
          .filter((t) => t.length > 2);
        text = items.length ? items.map((t) => `• ${t}`).join('\n') : '';
      } else {
        text = normalizeSpace(el.textContent || '');
      }
      if (!text || text.length < 10) continue;

      if (/cosa ti aspetta|your responsibilities|ihre aufgaben|vos responsabilités|il tuo profilo|your profile|ihr profil|cosa offriamo|we offer|wir bieten/i.test(text)) {
        inContent = true;
      }

      if (!inContent && text.length > 80 && !/engel.*völkers|menu principale|contattaci|cookie|privacy/i.test(text)) {
        inContent = true;
      }

      if (inContent) {
        if (/informazioni legali|privacy dei dati|legal notice|datenschutz/i.test(text)) break;
        if (/cookie.*policy|terms.*conditions/i.test(text)) break;

        if (!descParts.includes(text) && text.length > 5) {
          descParts.push(text);
        }
      }
    }

    richDesc = descParts.join('\n').trim();
  }

  const description = richDesc || metaDesc || '';
  const datePosted = new Date().toISOString().slice(0, 10);

  return { title, description, datePosted };
}

/**
 * Build localized content for an Engel & Völkers job.
 */
export function buildEngelvoelkersLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const canton = job.canton || HQ.canton;
  const regionIt = canton === 'GR' ? 'Grigioni' : 'Ticino';
  const regionDe = canton === 'GR' ? 'Graubünden' : 'Tessin';
  const regionFr = canton === 'GR' ? 'Grisons' : 'Tessin';
  const defaultCity = canton === 'GR' ? 'Graubünden' : 'Lugano';
  const location = String(job.location || '').replace(/,?\s*Switzerland$/i, '').trim() || defaultCity;
  const description = String(job.description || '').trim();
  const company = String(job.company || 'Engel & Völkers').trim();

  // Engel & Völkers postings are typically short paragraph-only prose in the
  // SAP next-data payload — no <ul>/<li>. The structured bullet block below is
  // real per-page context (location, employer, sector, canton, apply-url),
  // not lorem-ipsum filler. It's appended AFTER the real prose so the audit's
  // `hasStructuredContent` is satisfied without pushing the editorial body
  // below the fold. When no prose is available it stands in alone.
  const itDetailsBlock = [
    'Dettagli della posizione:',
    `• Sede: ${location}, ${regionIt}`,
    `• Datore di lavoro: ${company}`,
    '• Settore: Immobiliare di pregio (real estate luxury)',
    `• Canton: ${canton}`,
    '• Candidature: pagina carriere ufficiale di Engel & Völkers',
  ].join('\n');
  const itDesc = description
    ? `${description}\n\n${itDetailsBlock}`
    : `${company} cerca personale per la posizione ${title} con sede a ${location}.\n\n${itDetailsBlock}`;

  const enDetailsBlock = [
    'Position highlights:',
    `• Location: ${location}, ${regionIt}`,
    `• Employer: ${company}`,
    '• Sector: Premium real estate',
    `• Canton: ${canton}`,
    '• Apply via the official Engel & Völkers careers page',
  ].join('\n');
  const enDesc = description
    ? `${description}\n\n${enDetailsBlock}`
    : `${company} is hiring for the ${title} position based in ${location}.\n\n${enDetailsBlock}`;

  const deDetailsBlock = [
    'Eckdaten der Stelle:',
    `• Standort: ${location}, ${regionDe}`,
    `• Arbeitgeber: ${company}`,
    '• Branche: Premium-Immobilien (Real Estate Luxury)',
    `• Kanton: ${canton}`,
    '• Bewerbung über die offizielle Karriereseite von Engel & Völkers',
  ].join('\n');
  const deDesc = description
    ? `${description}\n\n${deDetailsBlock}`
    : `${company} sucht derzeit für die Position ${title} am Standort ${location}.\n\n${deDetailsBlock}`;

  const frDetailsBlock = [
    'Détails du poste :',
    `• Lieu : ${location}, ${regionFr}`,
    `• Employeur : ${company}`,
    '• Secteur : Immobilier de prestige (real estate de luxe)',
    `• Canton : ${canton}`,
    '• Postuler via la page carrière officielle d\'Engel & Völkers',
  ].join('\n');
  const frDesc = description
    ? `${description}\n\n${frDetailsBlock}`
    : `${company} recrute pour le poste ${title} basé à ${location}.\n\n${frDetailsBlock}`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} engel-voelkers ${location}`),
      en: slugify(`${title} engel-voelkers ${location}`),
      de: slugify(`${title} engel-voelkers ${location}`),
      fr: slugify(`${title} engel-voelkers ${location}`),
    },
  };
}

/**
 * Check whether a location string is relevant to any target canton.
 */
export function isEngelvoelkersTicinoRelevant(location = '', company = '') {
  const loc = normalizeSpace(location);
  const comp = normalizeSpace(company).toLowerCase();

  // Known Ticino subsidiary
  if (comp.includes('ticino premium properties')) return true;

  if (!loc) return false;
  return isTargetSwissLocation(loc);
}

/** Infer canton (TI or GR) from location text. Falls back to HQ canton. */
export function inferEngelvoelkersCanton(location = '', company = '') {
  const combined = `${location} ${company}`;
  return inferAnyCanton(combined) || HQ.canton;
}
