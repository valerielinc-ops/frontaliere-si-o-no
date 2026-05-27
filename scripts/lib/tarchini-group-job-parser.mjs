/**
 * Tarchini Group — HTML job parser
 *
 * Listing: https://www.tarchinigroup.com/it/lavora-con-noi
 *   - Job links as <a href="/it/work/{id}/{slug}">Title</a>
 *
 * Detail:  https://www.tarchinigroup.com/it/work/{id}/{slug}
 *   - Content in <section class="section dettaglio-offerta-lavoro">
 *     → <div class="text">...description HTML...</div>
 *   - Apply via email: risorseumane@tarchinigroup.com?subject={title}
 */

import { inferAnyCanton } from './target-swiss-locations.mjs';

const BASE_URL = 'https://www.tarchinigroup.com';

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
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&egrave;/g, 'è')
    .replace(/&agrave;/g, 'à')
    .replace(/&ograve;/g, 'ò')
    .replace(/&ugrave;/g, 'ù')
    .replace(/&igrave;/g, 'ì')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&ldquo;/g, '\u201C')
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
 * Parse the listing page HTML to extract job links.
 * @param {string} html - Raw HTML of /it/lavora-con-noi
 * @returns {{ items: Array }}
 */
export function parseTarchiniListingPage(html = '') {
  const items = [];
  // Match links to /it/work/{id}/{slug} pattern
  const linkRegex = /<a\s+href="((?:https:\/\/www\.tarchinigroup\.com)?\/it\/work\/(\d+)\/([^"]+))"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const rawHref = match[1];
    const jobId = match[2];
    const urlSlug = match[3];
    const title = normalizeSpace(match[4]);
    const detailUrl = rawHref.startsWith('http') ? rawHref : `${BASE_URL}${rawHref}`;
    items.push({ jobId, title, detailUrl, urlSlug });
  }

  // Deduplicate by jobId
  const seen = new Set();
  const unique = items.filter((item) => {
    if (seen.has(item.jobId)) return false;
    seen.add(item.jobId);
    return true;
  });

  return { items: unique };
}

/**
 * Extract job description from a detail page.
 * @param {string} html - Raw HTML of /it/work/{id}/{slug}
 * @returns {{ description: string, applyEmail: string, location: string }}
 */
export function parseTarchiniDetailPage(html = '') {
  let description = '';

  // Extract from <div class="text">...</div> inside dettaglio-offerta-lavoro
  const sectionMatch = html.match(
    /<section\s+class="section\s+dettaglio-offerta-lavoro">([\s\S]*?)<\/section>/i,
  );
  if (sectionMatch) {
    const textMatch = sectionMatch[1].match(/<div\s+class="text">([\s\S]*?)<\/div>/i);
    if (textMatch) {
      description = stripHtml(textMatch[1]);
    }
  }

  // Extract apply email
  let applyEmail = '';
  const emailMatch = html.match(/href="mailto:([^"?]+)/i);
  if (emailMatch) {
    applyEmail = emailMatch[1];
  }

  // Try to infer location from description
  let location = 'Manno';
  const descLower = (description || '').toLowerCase();
  if (/mendrisio/i.test(descLower)) location = 'Mendrisio';
  else if (/lugano/i.test(descLower)) location = 'Lugano';
  else if (/manno/i.test(descLower)) location = 'Manno';
  else if (/chiasso/i.test(descLower)) location = 'Chiasso';

  return { description, applyEmail, location };
}

/**
 * Build localized content for a Tarchini Group job.
 */
export function buildTarchiniLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || 'Manno').trim();
  const description = String(job.description || '').trim();

  const itDesc = description
    || `Tarchini Group cerca un/una ${title} con sede a ${location}. Gruppo immobiliare attivo in Ticino nella progettazione, costruzione e gestione di stabili. Per candidarti invia il CV a risorseumane@tarchinigroup.com.`;
  const enDesc = description
    ? description
    : `Tarchini Group is hiring for the ${title} role in ${location}, Ticino. Real estate group active in property development, construction and management. Apply by sending your CV to risorseumane@tarchinigroup.com.`;
  const deDesc = description
    ? description
    : `Tarchini Group sucht derzeit für die Position ${title} in ${location}, Tessin. Immobiliengruppe in Planung, Bau und Verwaltung. Bewirb dich per E-Mail an risorseumane@tarchinigroup.com.`;
  const frDesc = description
    ? description
    : `Tarchini Group recrute pour le poste ${title} à ${location}, Tessin. Groupe immobilier actif dans la planification, construction et gestion. Postulez par e-mail à risorseumane@tarchinigroup.com.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} tarchini-group ${location}`),
      en: slugify(`${title} tarchini-group ${location}`),
      de: slugify(`${title} tarchini-group ${location}`),
      fr: slugify(`${title} tarchini-group ${location}`),
    },
  };
}

/**
 * All Tarchini jobs are in Ticino by definition (the group operates only in TI).
 */
export function isTarchiniTicinoRelevant() {
  return true;
}

/**
 * Infer canton via the BFS municipality dataset; defaults to TI (Tarchini HQ).
 */
export function inferTarchiniCanton(location = '') {
  return inferAnyCanton(normalizeSpace(location)) || 'TI';
}
