/**
 * AXA Svizzera — Prospective.ch Career Center parser
 *
 * Listing: https://jobs.axa.ch/?lang=it&offset=0&limit=500&filter_20=68794
 *   - filter_20=68794 → Region Tessin
 *   - filter_20=68792 → Region Ostschweiz (inkl. GR)
 *   - Server-rendered HTML, paginated via offset/limit query params
 *   - Jobs in <a id="job-{numericId}" href="/posizioni-aperte/{slug}/{uuid}">
 *     - data-href → Umantis apply URL
 *     - title → job title
 *     - .job-meta1 p → short description
 *     - .job-meta2 → location/workload spans
 *
 * Detail: https://jobs.axa.ch/posizioni-aperte/{slug}/{uuid}
 *   - <h1> → title
 *   - <h2 class="isLast"> → workload + location
 *   - <meta name="description"> → summary
 *   - <div class="multicolumn"> → responsibilities + requirements
 *   - .map a[href*=google.com/maps] → address
 *   - lang= attribute on <html> → language
 *
 * Lang slugs: it→posizioni-aperte, de→offene-stellen, fr→postes-vacants, en→open-positions
 */

import { JSDOM } from 'jsdom';
import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';

const BASE_URL = 'https://jobs.axa.ch';

const LANG_SLUGS = {
  it: 'posizioni-aperte',
  de: 'offene-stellen',
  fr: 'postes-vacants',
  en: 'open-positions',
};

const REGION_FILTERS = {
  tessin: '68794',
  ostschweiz: '68792',
};

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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
 * Build listing URL with region filter.
 * @param {'it'|'de'|'fr'|'en'} lang
 * @param {string} regionCode - REGION_FILTERS value (68794 for Tessin, 68792 for Ostschweiz)
 * @param {number} [limit=500]
 * @returns {string}
 */
export function buildListingUrl(lang = 'it', regionCode = REGION_FILTERS.tessin, limit = 500) {
  return `${BASE_URL}/?lang=${lang}&offset=0&limit=${limit}&filter_20=${regionCode}`;
}

/**
 * Parse the listing HTML to extract job summaries.
 * @param {string} html - Full HTML of the listing page
 * @returns {Array<{id: string, title: string, url: string, applyUrl: string, excerpt: string}>}
 */
export function parseAxaListingPage(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const jobs = [];

  const jobLinks = doc.querySelectorAll('a[id^="job-"]');
  for (const link of jobLinks) {
    const numericId = (link.id || '').replace('job-', '');
    const title = normalizeSpace(link.getAttribute('title') || '');
    const url = link.getAttribute('href') || '';
    const applyUrl = link.getAttribute('data-href') || '';

    const meta1 = link.querySelector('.job-meta1 p');
    const excerpt = normalizeSpace(meta1?.textContent || '');

    if (!title || !url) continue;

    jobs.push({
      id: numericId,
      title,
      url: url.startsWith('http') ? url : `${BASE_URL}${url}`,
      applyUrl: applyUrl || '',
      excerpt,
    });
  }

  return jobs;
}

/**
 * Parse a job detail page.
 * @param {string} html - Full HTML of the detail page
 * @param {string} pageUrl - URL of the page (for canonical reference)
 * @returns {object|null}
 */
export function parseAxaDetailPage(html, pageUrl = '') {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = normalizeSpace(doc.querySelector('h1')?.textContent || '');
  if (!title) return null;

  // Workload + location from <h2 class="isLast">
  const h2 = doc.querySelector('h2.isLast');
  const h2Text = normalizeSpace(h2?.innerHTML?.replace(/<br\s*\/?>/gi, ' | ') || '');
  const h2Clean = stripHtml(h2Text);

  // Extract workload percentage
  const workloadMatch = h2Clean.match(/(\d+[-–]\d+%|\d+%)/);
  const workload = workloadMatch ? workloadMatch[1] : '';

  // Extract location from h2 (after workload line)
  const locationParts = h2Clean.replace(/\d+[-–]?\d*%/g, '').replace(/\|/g, '').trim();
  let location = normalizeSpace(locationParts);

  // Also try Google Maps address
  const mapLink = doc.querySelector('.map a[href*="google.com/maps"]');
  const address = normalizeSpace(mapLink?.textContent || '');

  // Meta description
  const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';

  // Language from <html lang="">
  const htmlLang = (doc.documentElement.getAttribute('lang') || 'de').toLowerCase().slice(0, 2);

  // ── Intro text (p.intro paragraphs only — NOT parent .intro divs) ──
  const introTexts = [];
  for (const el of doc.querySelectorAll('p.intro')) {
    const text = normalizeSpace(el.textContent || '');
    if (text.length > 20 && !introTexts.includes(text)) introTexts.push(text);
  }

  // ── Main content blocks: .width-50 sections ──
  // These contain responsibilities, requirements, company info
  // Section headings use <div class="s2"> or <h3>
  const SKIP_HEADINGS = /^(candidati ora|hai domande|jetzt bewerben|hast du fragen|postulez|avez-vous|apply now|any questions)/i;
  const contentBlocks = [];
  for (const el of doc.querySelectorAll('.width-50')) {
    // Skip non-printable (apply buttons, contact info, process info)
    if (el.classList.contains('non-printable')) continue;

    const heading = normalizeSpace(
      (el.querySelector('.s2, h3, h2') || {}).textContent || ''
    );

    // Skip contact/apply blocks
    if (SKIP_HEADINGS.test(heading)) continue;
    const listItems = [...el.querySelectorAll('li')]
      .map((li) => normalizeSpace(li.textContent || ''))
      .filter((t) => t.length > 5);
    const paragraphs = [...el.querySelectorAll('p')]
      .map((p) => normalizeSpace(p.textContent || ''))
      .filter((t) => t.length > 15);

    if (heading && (listItems.length > 0 || paragraphs.length > 0)) {
      let blockText = `## ${heading}`;
      if (listItems.length > 0) {
        blockText += '\n' + listItems.map((item) => `- ${item}`).join('\n');
      }
      if (paragraphs.length > 0) {
        blockText += '\n' + paragraphs.join('\n');
      }
      contentBlocks.push(blockText);
    } else if (!heading && (listItems.length > 0 || paragraphs.length > 0)) {
      // Content without a heading — skip contact info blocks
      const allText = [...listItems, ...paragraphs].join(' ').toLowerCase();
      if (/domande|fragen|questions|e-mail|@axa\.ch/i.test(allText)) continue;
      if (listItems.length > 0) {
        contentBlocks.push(listItems.map((item) => `- ${item}`).join('\n'));
      }
      if (paragraphs.length > 0) {
        contentBlocks.push(paragraphs.join('\n'));
      }
    }
  }

  // ── Benefits from .content divs inside .benefits ──
  const benefitItems = [];
  for (const el of doc.querySelectorAll('.benefits .content, .benefits-slider .content')) {
    const benefitTitle = normalizeSpace(el.querySelector('h4, h3, strong')?.textContent || '');
    const bullets = [...el.querySelectorAll('li')]
      .map((li) => normalizeSpace(li.textContent || ''))
      .filter((t) => t.length > 5);
    if (benefitTitle && bullets.length > 0) {
      benefitItems.push(`**${benefitTitle}**: ${bullets.join('; ')}`);
    }
  }

  // ── Build full description ──
  const descParts = [];
  if (introTexts.length > 0) descParts.push(introTexts.join('\n\n'));
  if (contentBlocks.length > 0) descParts.push(contentBlocks.join('\n\n'));
  if (benefitItems.length > 0) {
    descParts.push('## Benefits\n' + benefitItems.map((b) => `- ${b}`).join('\n'));
  }
  const description = descParts.join('\n\n').trim() || stripHtml(metaDesc);

  // Apply URL
  const applyLink = doc.querySelector('a[href*="/apply/"]');
  const applyUrl = applyLink?.getAttribute('href') || '';

  return {
    title,
    location: location || address.split(',')[0] || '',
    address,
    workload,
    description,
    metaDescription: normalizeSpace(metaDesc),
    lang: htmlLang,
    applyUrl: applyUrl.startsWith('http') ? applyUrl : (applyUrl ? `${BASE_URL}${applyUrl}` : ''),
  };
}

/**
 * Check if a job is Ticino/GR relevant based on location text.
 */
export function isAxaTicinoRelevant(location = '', address = '', title = '') {
  const combined = `${location} ${address} ${title}`.toLowerCase();
  return isTargetSwissLocation(combined);
}

/**
 * Infer canton from job location/address text.
 *
 * Uses inferAnyCanton, which matches against all 26 Swiss cantons via the BFS
 * municipality dataset (2,110 cities + aliases) plus canton names and codes.
 */
export function inferAxaCanton(location = '', address = '') {
  return inferAnyCanton(`${location} ${address}`);
}

/**
 * Infer job category from title + description.
 */
export function inferAxaCategory(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();
  if (/\b(it|software|developer|devops|engineer|informatik|informatica)\b/i.test(text)) return 'informatica';
  if (/\b(market|comunicat|kommunik|digital|online|seo)\b/i.test(text)) return 'marketing';
  if (/\b(hr|human|risorse umane|personale|talent)\b/i.test(text)) return 'risorse-umane';
  if (/\b(finan[zc]|contabil|buchhalt|accounting|risk|actuari|attuari)\b/i.test(text)) return 'finanza';
  if (/\b(consulent|berat|advisor|sales|vendita|verkauf)\b/i.test(text)) return 'vendita';
  if (/\b(underwriting|assicurat|versicher|insurance)\b/i.test(text)) return 'assicurazioni';
  if (/\b(recht|legal|giuridic|compliance|legale)\b/i.test(text)) return 'legale';
  if (/\b(logist|einkauf|acquist|procurement)\b/i.test(text)) return 'logistica';
  if (/\b(direzione|management|leadership|führung|leitung)\b/i.test(text)) return 'direzione';
  if (/\b(innendienst|backoffice|admin|segretari|kaufm)\b/i.test(text)) return 'amministrazione';
  if (/\b(schaden|sinistri|claims)\b/i.test(text)) return 'sinistri';
  if (/\b(rechtsschutz|protezione giuridica)\b/i.test(text)) return 'protezione-giuridica';
  return 'assicurazioni'; // Default for AXA
}

/**
 * Build localized content object for a job.
 */
export function buildAxaLocalizedContent(detail, listingExcerpt = '') {
  const lang = detail.lang || 'it';
  const content = {};

  content[lang] = {
    title: detail.title,
    description: detail.description,
    excerpt: detail.metaDescription || listingExcerpt || detail.description.slice(0, 300),
    requirements: '',
    location: detail.location || detail.address || '',
  };

  return content;
}

/**
 * Build the detail page URL for a given UUID and language.
 */
export function buildDetailUrl(uuid, lang = 'it') {
  const slug = LANG_SLUGS[lang] || LANG_SLUGS.it;
  return `${BASE_URL}/${slug}/${uuid}`;
}

/**
 * Extract UUID from a job URL.
 */
export function extractUuidFromUrl(url = '') {
  const match = url.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : '';
}

export { REGION_FILTERS, LANG_SLUGS, BASE_URL };
