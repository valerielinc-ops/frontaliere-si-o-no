/**
 * Lombardi Group — careers page parser
 *
 * Listing: https://lombardi.group/eng/careers/open-positions
 *   Embedded `var _jobs = [...]` JSON array with all positions.
 *   Each entry has annuncioId, sedeId, titolo, descNazione, descrizione, occupMin/Max.
 *
 * Detail: https://lombardi.group/eng/careers/job?id={annuncioId}
 *   HTML page with full description, requirements, location, contacts.
 *
 * Sede mapping (Swiss offices):
 *   sedeId=1       → Giubiasco (TI)  ← target
 *   sedeId=12      → Fribourg
 *   sedeId=435302  → Rotkreuz
 *   sedeId=446348  → Urdorf
 *   sedeId=458683  → Lausanne
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';

const LISTING_URL = 'https://lombardi.group/eng/careers/open-positions';
const DETAIL_URL = 'https://lombardi.group/eng/careers/job?id=';

// Ticino sedeIds (Giubiasco)
const TICINO_SEDE_IDS = new Set([1]);


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

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch and parse the listing page to extract the embedded _jobs JSON.
 */
export async function parseLombardiListingPage(timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(LISTING_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const match = html.match(/var _jobs = (\[.*?\]);/s);
    if (!match) throw new Error('Could not find _jobs data in listing page');

    return JSON.parse(match[1]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract list items from an HTML section (content between two h3 tags).
 */
function extractListItems(sectionHtml) {
  const items = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(sectionHtml)) !== null) {
    const text = stripHtml(m[1]);
    if (text.length > 2) items.push(text);
  }
  return items;
}

/**
 * Word-level overlap between two strings (0..1).
 */
export function titleOverlap(a, b) {
  if (!a || !b) return 0;
  const clean = (s) =>
    String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean);
  const wordsA = new Set(clean(a));
  const wordsB = new Set(clean(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.max(wordsA.size, wordsB.size);
}

// Section headings to extract content from (all site languages)
const CONTENT_HEADINGS = /Job Description|Descrizione dell.offerta|Requisiti|Requirements|Anforderungen|Profil|We offer|Offriamo|Wir bieten|Nous offrons/i;
// Section headings to skip
const SKIP_HEADINGS = /Contact|Contatti|Kontakt|Apply now|Candidati ora|Jetzt bewerben|Postuler|Thank you|Grazie/i;

/**
 * Parse a Lombardi detail page into structured markdown content.
 * Extracts title, intro, and all job-relevant sections (Job Description, Requirements, We offer).
 */
export function parseLombardiDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Decode HTML entities
  const decoded = html
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&nbsp;/gi, ' ');

  // Extract title from <h2 class="h1 intro__subtitle">
  const titleMatch = decoded.match(/<h2[^>]*class="[^"]*intro__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  const detailTitle = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Extract occupancy and city: "80%–100% | Giubiasco"
  const locMatch = decoded.match(/(\d+%\s*[–-]\s*\d+%)\s*\|\s*([^<]+)/);
  const city = locMatch ? normalizeSpace(locMatch[2]) : '';
  const occupancy = locMatch ? normalizeSpace(locMatch[1]) : '';

  // Extract intro text from <div class="intro__rich-text">
  const introMatch = decoded.match(/<div[^>]*class="[^"]*intro__rich-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const introText = introMatch ? normalizeDescriptionSpace(stripHtml(introMatch[1])) : '';

  // Extract main content area (between <!-- Title END--> and the contact/form section)
  const mainMatch = decoded.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const mainHtml = mainMatch ? mainMatch[1] : decoded;

  // Parse all h3 sections and their content
  const sections = [];
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const h3Matches = [];
  let m;
  while ((m = h3Re.exec(mainHtml)) !== null) {
    h3Matches.push({ heading: normalizeSpace(stripHtml(m[1])), index: m.index, length: m[0].length });
  }

  for (let i = 0; i < h3Matches.length; i++) {
    const { heading, index, length } = h3Matches[i];

    if (SKIP_HEADINGS.test(heading)) continue;
    if (!CONTENT_HEADINGS.test(heading)) continue;

    // Content between this h3 and the next h3 (or end of main)
    const start = index + length;
    const end = i + 1 < h3Matches.length ? h3Matches[i + 1].index : mainHtml.length;
    const sectionHtml = mainHtml.slice(start, end);

    const items = extractListItems(sectionHtml);
    if (items.length > 0) {
      // Map English headings to Italian for consistency
      let itHeading = heading;
      if (/Job Description|Descrizione/i.test(heading)) itHeading = 'Mansioni';
      else if (/Requirements|Requisiti|Anforderungen/i.test(heading)) itHeading = 'Requisiti';
      else if (/We offer|Offriamo|Wir bieten/i.test(heading)) itHeading = 'Offriamo';
      sections.push({ heading: itHeading, items });
    }
  }

  // Build markdown description
  const parts = [];
  if (introText) parts.push(introText);
  for (const sec of sections) {
    parts.push(`\n## ${sec.heading}\n${sec.items.map((it) => `- ${it}`).join('\n')}`);
  }
  const markdown = parts.join('\n').trim();
  const sectionCount = sections.length;

  return {
    detailTitle,
    city,
    occupancy,
    introText,
    sections,
    markdown,
    sectionCount,
    sourceTextLength: stripHtml(mainHtml).length,
  };
}

/**
 * Fetch a detail page and extract structured content.
 */
export async function parseLombardiDetailPage(annuncioId, timeoutMs = 15000) {
  const url = `${DETAIL_URL}${annuncioId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseLombardiDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if a Lombardi job is in any target canton.
 */
export function isLombardiTicinoRelevant(job = {}) {
  if (TICINO_SEDE_IDS.has(job.sedeId)) return true;
  const loc = normalizeSpace(job.city || '');
  if (!loc) return false;
  return isTargetSwissLocation(loc);
}

/**
 * Company boilerplate fallback for descriptions when detail page is unavailable.
 */
function lombardiBoilerplate(title, city, occupancy) {
  const occLabel = occupancy ? ` (${occupancy})` : '';
  return `Lombardi Group, studio di ingegneria con sede a ${city}, cerca un profilo ${title}${occLabel}. Lombardi è specializzata nella progettazione di grandi infrastrutture: tunnel, dighe, ponti e impianti idroelettrici in Svizzera e nel mondo. Lo studio, con sede principale a Giubiasco (Ticino), opera nei settori dell'ingegneria civile, idraulica e geotecnica. Candidati tramite il portale ufficiale.`;
}

/**
 * Build localized content for a Lombardi job.
 * Uses full structured markdown from detail page when available.
 */
export function buildLombardiLocalizedContent(job = {}) {
  const title = normalizeSpace(job.title);
  const city = normalizeSpace(job.city) || 'Giubiasco';
  const occupancy = job.occupancy || '';
  const detailDesc = job.detailMarkdown && job.detailMarkdown.length > 100
    ? job.detailMarkdown
    : '';
  const itBoilerplate = lombardiBoilerplate(title, city, occupancy);
  const sourceLang = detailDesc ? detectLang(detailDesc, 'it') : 'it';
  const descriptionByLocale = { it: itBoilerplate };

  if (detailDesc) {
    descriptionByLocale[sourceLang] = detailDesc;
  }

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale,
    slugByLocale: {
      it: slugify(`${title} lombardi ${city}`),
      en: slugify(`${title} lombardi ${city}`),
      de: slugify(`${title} lombardi ${city}`),
      fr: slugify(`${title} lombardi ${city}`),
    },
  };
}
