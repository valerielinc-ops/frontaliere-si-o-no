/**
 * Cerbios-Pharma SA — job parser
 *
 * Cerbios-Pharma is a pharmaceutical CDMO based in Barbengo/Lugano (TI).
 * They publish vacancies through:
 *   - https://cerbios.swiss/cerbios/working-in-cerbios/ (career overview)
 *   - https://www.e-lavoro.ch/node/91 (external job portal by AITI Servizi SA)
 *
 * The e-lavoro.ch portal shows job listings with title, description, and
 * contact information. When no positions are available, it shows a
 * "no offers" message.
 *
 * Exports: parseListingPage, parseDetailPage, buildJob, stripHtml, normalizeSpace
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('cerbios-pharma');

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

/* ── Listing page parser ───────────────────────────────────── */

/**
 * Parse the e-lavoro.ch listing page for Cerbios-Pharma jobs.
 * Returns an array of { title, url, location, datePosted, description }.
 *
 * The e-lavoro.ch portal structures jobs as:
 *   - <div class="views-row"> or similar wrapper
 *   - Job title in heading or <a> text
 *   - Description text with role details
 *   - May show "no offers" message when empty
 */
export function parseListingPage(html) {
  if (!html || typeof html !== 'string') return [];

  // Check for "no offers" message
  if (/non ci sono offerte|nessuna offerta|no.*job.*offer|no.*vacanc/i.test(html)) {
    return [];
  }

  const jobs = [];
  const seen = new Set();

  // Pattern 1: Drupal views rows (e-lavoro.ch uses Drupal)
  const rowRe = /<(?:div|article)[^>]*class="[^"]*views-row[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article)>/gi;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    const rowHtml = match[1];

    // Title from heading or link
    const titleMatch = rowHtml.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i)
      || rowHtml.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    let title, url;
    if (titleMatch[2]) {
      url = titleMatch[1];
      title = normalizeSpace(stripHtml(titleMatch[2]));
    } else {
      title = normalizeSpace(stripHtml(titleMatch[1]));
      const linkMatch = rowHtml.match(/<a[^>]+href="([^"]+)"/i);
      url = linkMatch ? linkMatch[1] : '';
    }

    if (!title || title.length < 5) continue;
    const fullUrl = url && url.startsWith('http') ? url : url ? `https://www.e-lavoro.ch${url}` : '';
    if (fullUrl && seen.has(fullUrl)) continue;
    if (fullUrl) seen.add(fullUrl);

    const descText = normalizeSpace(stripHtml(rowHtml));

    jobs.push({
      title,
      url: fullUrl || 'https://www.e-lavoro.ch/node/91',
      location: 'Barbengo',
      datePosted: '',
      description: descText.length > 50 ? descText : '',
    });
  }

  // Pattern 2: Node teaser items (alternative Drupal layout)
  const nodeRe = /<(?:div|article)[^>]*class="[^"]*node[^"]*teaser[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article)>/gi;
  while ((match = nodeRe.exec(html)) !== null) {
    const nodeHtml = match[1];
    const linkMatch = nodeHtml.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = linkMatch[1];
    const title = normalizeSpace(stripHtml(linkMatch[2]));
    if (!title || title.length < 5) continue;

    const fullUrl = url.startsWith('http') ? url : `https://www.e-lavoro.ch${url}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    jobs.push({
      title,
      url: fullUrl,
      location: 'Barbengo',
      datePosted: '',
    });
  }

  // Pattern 3: Generic link list within job section
  const linkRe = /<a[^>]+href="(\/node\/\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = linkRe.exec(html)) !== null) {
    const url = match[1];
    const title = normalizeSpace(stripHtml(match[2]));
    if (!title || title.length < 10) continue;

    const fullUrl = `https://www.e-lavoro.ch${url}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    // Filter out navigation links
    if (!/annunci|offert|lavoro|position|impieg/i.test(title)) continue;

    jobs.push({
      title,
      url: fullUrl,
      location: 'Barbengo',
      datePosted: '',
    });
  }

  return jobs;
}

/* ── Detail page parser ────────────────────────────────────── */

/**
 * Parse a Cerbios-Pharma / e-lavoro.ch job detail page.
 * Returns { title, description, location, sections[], requirements[] }
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? normalizeSpace(stripHtml(h1Match[1])) : '';
  if (!title || title.length < 3) return null;

  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*(?:content|field-items)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const contentHtml = mainMatch ? mainMatch[1] : html;
  const description = stripHtml(contentHtml);

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
    const items = [];
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe.exec(sectionHtml)) !== null) {
      const text = normalizeSpace(stripHtml(li[1]));
      if (text.length > 5) items.push(text);
    }
    if (items.length > 0 || normalizeSpace(stripHtml(sectionHtml)).length > 30) {
      sections.push({ heading: headings[i].text, items });
    }
  }

  const requirements = sections
    .filter((s) => /requisit|profil|competen|formazione|richied|skills|qualificat/i.test(s.heading))
    .flatMap((s) => s.items);

  return {
    title,
    description: description.length > 50 ? description : '',
    location: 'Barbengo',
    canton: HQ.canton,
    sections,
    requirements,
    sourceTextLength: description.length,
  };
}

/* ── Job builder ───────────────────────────────────────────── */

export function buildJob(raw) {
  if (!raw || !raw.title) return null;

  const title = normalizeSpace(raw.title);
  if (!title || title.length < 3) return null;

  const location = raw.location || 'Barbengo';
  const description = raw.description || `${title} presso Cerbios-Pharma SA, azienda farmaceutica CDMO con sede a Barbengo (Lugano, Ticino). Cerbios-Pharma è specializzata nello sviluppo e nella produzione di principi attivi farmaceutici (API) e coniugati anticorpo-farmaco (ADC), servendo clienti farmaceutici globali. L'azienda opera in un ambiente GMP certificato con tecnologie all'avanguardia.`;

  return {
    title,
    company: 'Cerbios-Pharma SA',
    companyKey: 'cerbios-pharma',
    url: raw.url || 'https://www.e-lavoro.ch/node/91',
    location,
    canton: HQ.canton,
    country: 'CH',
    addressLocality: 'Barbengo',
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    postalCode: HQ.postalCode,
    streetAddress: 'Via Figino 6',
    employmentType: inferEmploymentType(title, description),
    category: detectCategory(title, description),
    description,
    postedDate: raw.datePosted || new Date().toISOString().slice(0, 10),
    source: 'company-website',
    slug: slugify(`${title}-cerbios-pharma-${location}`),
    slugByLocale: {
      it: slugify(`${title}-cerbios-pharma-${location}`),
      en: slugify(`${title}-cerbios-pharma-${location}`),
      de: slugify(`${title}-cerbios-pharma-${location}`),
      fr: slugify(`${title}-cerbios-pharma-${location}`),
    },
    titleByLocale: { it: title, en: title, de: title, fr: title },
  };
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  if (/chimico|chemist|laborator|anali|quality|qualità|gmp|validat/i.test(combined)) return 'science';
  if (/produzion|manufactur|operator|operatore|process/i.test(combined)) return 'manufacturing';
  if (/ingegner|engineer|tecnic|techni|manutenzi/i.test(combined)) return 'engineering';
  if (/regolator|regulatory|farmacovig|pharmacovig|registration/i.test(combined)) return 'regulatory';
  if (/logistic|magazz|warehouse|supply chain|spedizion/i.test(combined)) return 'logistics';
  if (/it\b|software|informatica|system|digital/i.test(combined)) return 'technology';
  if (/amministra|administrat|hr\b|risorse umane|personal/i.test(combined)) return 'administration';
  if (/vendita|sales|commerci|business develop/i.test(combined)) return 'sales';
  if (/finanz|contabil|controlling/i.test(combined)) return 'finance';
  return 'science'; // Default for pharma CDMO
}

/**
 * Infer employment type from title, description and optional percentage field.
 * Swiss job postings commonly include percentage (e.g. "80-100%").
 * @param {string} title
 * @param {string} description
 * @param {string} percentage
 * @returns {string} FULL_TIME or PART_TIME
 */
export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}
