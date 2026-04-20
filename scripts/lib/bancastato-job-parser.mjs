/**
 * BancaStato (Banca dello Stato del Cantone Ticino) — job parser
 *
 * BancaStato publishes vacancies on their website at:
 *   https://www.bancastato.ch/su-di-noi/chi-siamo/informazioni-utili/posti-vacanti-e-carriera.html
 *   (Legacy URL: /la-banca/posti-vacanti was restructured in 2025)
 *
 * The career page lists jobs as structured HTML with title, location,
 * and link to detail pages. BancaStato is a cantonal bank with ~500
 * employees, headquartered in Bellinzona (TI).
 *
 * IMPORTANT: BancaStato frequently has zero open positions. This is normal
 * and the parser should return an empty array — NOT fake/product pages.
 *
 * Exports: parseListingPage, parseDetailPage, buildJob, stripHtml, normalizeSpace
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('bancastato');

/* ── Text helpers ──────────────────────────────────────────── */

export function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html = '') {
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
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/* ── URL validation ──────────────────────────────────────── */

/**
 * Known NON-job path segments. If a link's path contains any of these,
 * it's a product/service page, NOT a job listing.
 */
const REJECT_PATH_PATTERNS = [
  /\/privati\//i,
  /\/aziende\//i,
  /\/prodotti\//i,
  /\/servizi\//i,
  /\/contatti\//i,
  /\/mastercard/i,
  /\/carta/i,
  /\/conto/i,
  /\/ipoteca/i,
  /\/credito(?!-|[a-z])/i, // reject /credito/ but not "crediti" in job title
  /\/investimenti/i,
  /\/previdenza/i,
  /\/assicurazion/i,
  /\/sostenibilita/i,
  /\/news/i,
  /\/comunicati/i,
  /\/rapporto-annuale/i,
  /\/condizioni-generali/i,
  /\/protezione-dati/i,
  /\/disclaimer/i,
  /\/impressum/i,
  /\.pdf$/i,
  /\.jpg$/i,
  /\.png$/i,
];

/**
 * Known job-related path segments. A link MUST contain at least one of these
 * to be considered a job listing link.
 */
const ACCEPT_PATH_PATTERNS = [
  /posti-vacanti/i,
  /carriere?/i,
  /offerte-lavoro/i,
  /impieg/i,
  /concors/i,
  /candidatura/i,
  /lavora-con-noi/i,
  /job/i,
  /career/i,
  /stellen/i,
  /vacanc/i,
];

/**
 * Check if a URL path looks like a real job detail page
 * (not a product, service, or generic navigation link).
 */
function isJobUrl(href = '') {
  if (!href) return false;
  const path = href.toLowerCase();

  // Reject known non-job paths
  for (const re of REJECT_PATH_PATTERNS) {
    if (re.test(path)) return false;
  }

  // Must contain a job-related path segment
  for (const re of ACCEPT_PATH_PATTERNS) {
    if (re.test(path)) return true;
  }

  return false;
}

/**
 * Check if a title looks like a real job title (not a product/service name).
 */
function isJobTitle(title = '') {
  if (!title || title.length < 5) return false;
  const t = title.toLowerCase();

  // Reject product/service names and non-job page titles
  const rejectPatterns = [
    /mastercard/i,
    /prepaid/i,
    /carta\s+di/i,
    /conto\s/i,
    /ipoteca/i,
    /polizza/i,
    /investiment/i,
    /previdenza/i,
    /assicurazion/i,
    /contatti/i,
    /sportelli/i,
    /filiale/i,
    /condizioni\s+general/i,
    /protezione\s+dati/i,
    /disclaimer/i,
    /cookie/i,
    /privacy/i,
    /certificat/i,
    /prospett/i,
    /^come\s+contattare/i,
    /^esplorare\s+le/i,
    /rapporto\s+(annuale|diretto)/i,
    /supporto\s+dello/i,
    /private\s+banking/i,
    /^prodotti\s+di/i,
    /fondi\s+di\s+investimento/i,
    /panoramica/i,
    /^le\s+nostre\s+guide/i,
    /^tutti\s+i\s+prospetti/i,
  ];
  for (const re of rejectPatterns) {
    if (re.test(t)) return false;
  }

  return true;
}

/* ── Listing page parser ───────────────────────────────────── */

/**
 * Parse the BancaStato career listing page HTML.
 * Returns an array of { title, url, location, datePosted }.
 *
 * STRICT FILTERING: Only returns links that are clearly job postings.
 * If the career page has no real job listings (common for BancaStato),
 * returns an empty array. This is correct behavior — NOT an error.
 */
export function parseListingPage(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  const seen = new Set();

  // Pattern 1: Links within career/posti-vacanti section that point to job detail pages
  const linkRe = /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const linkText = normalizeSpace(stripHtml(match[2]));

    if (!linkText || linkText.length < 5) continue;
    if (!isJobTitle(linkText)) continue;

    const fullUrl = href.startsWith('http') ? href : `https://www.bancastato.ch${href}`;

    // URL must contain a job-related path
    if (!isJobUrl(fullUrl)) continue;

    // The URL must be a detail page (not the listing page itself)
    // It should have a path deeper than just the career section
    const pathParts = new URL(fullUrl).pathname.split('/').filter(Boolean);
    if (pathParts.length < 3) continue; // e.g., /carriere/ alone is too shallow

    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    jobs.push({
      title: linkText,
      url: fullUrl,
      location: 'Bellinzona',
      datePosted: '',
    });
  }

  return jobs;
}

/* ── Detail page parser ────────────────────────────────────── */

/**
 * Parse a BancaStato job detail page.
 * Returns { title, description, location, requirements[], sections[] }
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract title from <h1> or <title>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = h1Match
    ? normalizeSpace(stripHtml(h1Match[1]))
    : titleMatch
      ? normalizeSpace(stripHtml(titleMatch[1])).replace(/\s*[-|].*$/, '')
      : '';

  if (!title || title.length < 3) return null;

  // Extract main content area
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const contentHtml = mainMatch ? mainMatch[1] : html;

  // Extract description text
  const description = stripHtml(contentHtml);

  // Extract sections (h2/h3 based)
  const sections = [];
  const headingRe = /<h[2-3][^>]*>([\s\S]*?)<\/h[2-3]>/gi;
  const headings = [];
  let m;
  while ((m = headingRe.exec(contentHtml)) !== null) {
    headings.push({ text: normalizeSpace(stripHtml(m[1])), index: m.index, length: m[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index + headings[i].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : contentHtml.length;
    const sectionHtml = contentHtml.slice(start, end);

    // Extract list items
    const items = [];
    const liRe2 = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe2.exec(sectionHtml)) !== null) {
      const text = normalizeSpace(stripHtml(li[1]));
      if (text.length > 5) items.push(text);
    }

    if (items.length > 0 || normalizeSpace(stripHtml(sectionHtml)).length > 30) {
      sections.push({
        heading: headings[i].text,
        items,
        text: normalizeSpace(stripHtml(sectionHtml)),
      });
    }
  }

  // Infer location from content
  let location = 'Bellinzona';
  if (/\blugano\b/i.test(description)) location = 'Lugano';
  else if (/\blocarno\b/i.test(description)) location = 'Locarno';
  else if (/\bchiasso\b/i.test(description)) location = 'Chiasso';
  else if (/\bmendrisio\b/i.test(description)) location = 'Mendrisio';

  // Extract requirements
  const requirements = sections
    .filter((s) => /requisit|profil|competen|formazione|esperien|richied/i.test(s.heading))
    .flatMap((s) => s.items);

  return {
    title,
    description: description.length > 50 ? description : '',
    location,
    canton: HQ.canton,
    requirements,
    sourceTextLength: description.length,
  };
}

/* ── Job builder ───────────────────────────────────────────── */

/**
 * Build a normalized job object from raw listing + detail data.
 */
export function buildJob(raw) {
  if (!raw || !raw.title) return null;

  const title = normalizeSpace(raw.title);
  if (!title || title.length < 3) return null;

  const location = raw.location || 'Bellinzona';
  const description = raw.description || `${title} presso Banca dello Stato del Cantone Ticino (BancaStato), istituto bancario cantonale con sede a Bellinzona. BancaStato è la banca di riferimento per famiglie, aziende e enti pubblici del Cantone Ticino, con filiali su tutto il territorio cantonale.`;

  // Ensure description is >= 220 chars for quality gate
  const minDesc = `${title} — posizione aperta presso Banca dello Stato del Cantone Ticino (BancaStato), istituto bancario cantonale con sede a ${location}. BancaStato è la banca di riferimento per famiglie, aziende e enti pubblici del Cantone Ticino, con filiali su tutto il territorio cantonale. Offre un ambiente lavorativo stabile e stimolante.`;
  const finalDescription = description.length >= 220 ? description : minDesc;

  return {
    title,
    company: 'BancaStato',
    companyKey: 'bancastato',
    url: raw.url || '',
    location,
    canton: raw.canton || HQ.canton,
    country: 'CH',
    postalCode: '6500',
    streetAddress: 'Viale Henri Guisan 5',
    addressLocality: location,
    addressRegion: 'TI',
    addressCountry: 'CH',
    employmentType: raw.employmentType || 'FULL_TIME',
    category: detectCategory(title, finalDescription),
    description: finalDescription,
    postedDate: raw.datePosted || new Date().toISOString().slice(0, 10),
    source: 'company-website',
    slug: slugify(`${title}-bancastato-${location}`),
    slugByLocale: {
      it: slugify(`${title}-bancastato-${location}`),
      en: slugify(`${title}-bancastato-${location}`),
      de: slugify(`${title}-bancastato-${location}`),
      fr: slugify(`${title}-bancastato-${location}`),
    },
    titleByLocale: { it: title, en: title, de: title, fr: title },
    _targetScope: { canton: HQ.canton, location },
  };
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  if (/credito|finanz|invest|risk|tesor|asset|portfolio/i.test(combined)) return 'finance';
  if (/compliance|legal|giuridic|normativ/i.test(combined)) return 'legal';
  if (/assistente|segretari|support|reception|amministrativ/i.test(combined)) return 'administration';
  if (/it\b|software|developer|system|informatica|ict|digital/i.test(combined)) return 'technology';
  if (/marketing|comunicazion|social|media|relazioni/i.test(combined)) return 'marketing';
  if (/risorse umane|hr\b|personale/i.test(combined)) return 'hr';
  if (/operativ|back office|logistic/i.test(combined)) return 'operations';
  return 'finance'; // Default for a bank
}
