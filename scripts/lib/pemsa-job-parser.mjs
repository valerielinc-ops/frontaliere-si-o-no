/**
 * PEMSA — WordPress career page parser
 *
 * Listing: https://www.pemsa.ch/it/le-nostre-offerte-di-lavoro/?_canton=125
 *   WordPress with WP Grid Builder. Pre-filtered for canton=Ticino (125).
 *   Job links in format: https://www.pemsa.ch/it/job/{slug}-{id}/
 *
 * Detail: https://www.pemsa.ch/it/job/{slug}-{id}/
 *   JSON-LD JobPosting with title, description, datePosted, validThrough,
 *   jobLocation (addressLocality, addressRegion, postalCode, addressCountry).
 *
 * PEMSA is a Swiss staffing agency for construction, civil engineering,
 * electrical, HVAC, and industrial trades. HQ in Geneva, branch in Ticino.
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';

const LISTING_URL = 'https://www.pemsa.ch/it/le-nostre-offerte-di-lavoro/?_canton=125';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decode HTML entities to get raw HTML, then convert to structured markdown.
 * The JSON-LD description from PEMSA contains HTML-encoded tags like
 * &lt;h2&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;strong&gt; etc.
 */
function decodeHtmlEntities(text = '') {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8216;/g, '\u2018')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8221;/g, '\u201D')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Parse the decoded HTML into structured markdown with sections and bullets.
 * Skips "contatto" / "persona di contatto" sections.
 *
 * Returns { text, sectionCount, sourceTextLength }.
 */
export function parseDescriptionToMarkdown(rawDescription = '') {
  if (!rawDescription) return { text: '', sectionCount: 0, sourceTextLength: 0 };

  const decoded = decodeHtmlEntities(rawDescription);
  const sourceTextLength = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;

  // Clean up: remove </br> self-closing breaks used as spacers
  let html = decoded.replace(/<\/br>/gi, '').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ');

  const sections = [];
  const skipHeadings = /contatto|persona di contatto|contact|Kontakt|votre interlocuteur/i;

  // Extract intro text before first heading
  const firstHeadingIdx = html.search(/<h[2-4][^>]*>/i);
  if (firstHeadingIdx > 0) {
    const introHtml = html.slice(0, firstHeadingIdx);
    const intro = introHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (intro.length > 30) sections.push(intro);
  }

  // Extract heading + content blocks
  const headingRegex = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*([\s\S]*?)(?=<h[2-4][^>]*>|$)/gi;
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    const heading = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!heading || skipHeadings.test(heading)) continue;

    const contentBlock = match[2];

    // Try <ul><li> extraction
    const ulMatch = contentBlock.match(/<ul>([\s\S]*?)<\/ul>/i);
    if (ulMatch) {
      const items = [];
      const liRegex = /<li>([\s\S]*?)<\/li>/gi;
      let li;
      while ((li = liRegex.exec(ulMatch[1])) !== null) {
        const text = li[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (text) items.push(text);
      }
      if (items.length > 0) {
        sections.push(`## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`);
        continue;
      }
    }

    // Try <p> content
    const pMatches = contentBlock.match(/<p>([\s\S]*?)<\/p>/gi);
    if (pMatches) {
      const lines = pMatches.map((p) =>
        p.replace(/<\/?p>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      ).filter(Boolean);
      if (lines.length > 0 && lines.join(' ').length > 20) {
        sections.push(`## ${heading}\n${lines.join('\n')}`);
        continue;
      }
    }

    // Plain text
    const plain = contentBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length > 20) {
      sections.push(`## ${heading}\n${plain}`);
    }
  }

  const text = sections.join('\n\n');
  const sectionCount = sections.filter((s) => s.startsWith('## ')).length;
  return { text, sectionCount, sourceTextLength };
}

/**
 * Fetch the listing page and extract all job URLs.
 */
export async function parsePemsaListingPage(timeoutMs = 20000) {
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

    const urls = new Set();
    const regex = /href="(https:\/\/www\.pemsa\.ch\/it\/job\/[^"]+)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      urls.add(match[1].replace(/\/$/, '') + '/');
    }
    return [...urls];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a detail page and extract JSON-LD JobPosting data.
 */
export async function parsePemsaDetailPage(url, timeoutMs = 15000) {
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

    const ldBlocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    for (const block of ldBlocks) {
      const jsonStr = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
      try {
        const data = JSON.parse(jsonStr);
        if (data?.['@type'] === 'JobPosting') {
          const loc = data.jobLocation?.address || {};
          const rawDesc = data.description || '';
          const parsed = parseDescriptionToMarkdown(rawDesc);
          return {
            title: normalizeSpace(data.title || ''),
            description: parsed.text,
            descriptionSectionCount: parsed.sectionCount,
            descriptionSourceLength: parsed.sourceTextLength,
            datePosted: normalizeSpace(data.datePosted || ''),
            validThrough: normalizeSpace(data.validThrough || ''),
            employmentType: normalizeSpace(data.employmentType || ''),
            city: normalizeSpace(loc.addressLocality || ''),
            region: normalizeSpace(loc.addressRegion || ''),
            postalCode: normalizeSpace(loc.postalCode || ''),
            country: normalizeSpace(loc.addressCountry || ''),
            company: normalizeSpace(data.hiringOrganization?.name || 'PEMSA'),
          };
        }
      } catch { /* skip invalid JSON-LD */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if a PEMSA job is Ticino-relevant.
 */
export function isPemsaTicinoRelevant(job = {}) {
  const region = normalizeSpace(job.region || '').toUpperCase();
  if (region === 'TI') return true;

  const city = normalizeSpace(job.city || '').toLowerCase();
  if (!city) return true; // Pre-filtered by canton=125
  return isTargetSwissLocation(city);
}

/**
 * Build localized content for a PEMSA job.
 * Uses the full parsed description from the detail page.
 */
export function buildPemsaLocalizedContent(job = {}) {
  const title = normalizeSpace(job.title);
  const city = normalizeSpace(job.city) || 'Ticino';
  const desc = job.description || '';
  const sectionCount = job.descriptionSectionCount || 0;
  const sourceLength = job.descriptionSourceLength || 0;
  const MIN_BODY_RATIO = 0.20;
  const MIN_SECTIONS = 2;

  // Quality guard: reject thin descriptions
  if (desc && sourceLength > 0) {
    const ratio = desc.length / sourceLength;
    if (ratio < MIN_BODY_RATIO) {
      console.warn(`  ⚠️ PEMSA body ratio too low for "${title}": ${(ratio * 100).toFixed(1)}% (need ≥${(MIN_BODY_RATIO * 100).toFixed(0)}%)`);
    }
    if (sectionCount < MIN_SECTIONS && sourceLength > 400) {
      console.warn(`  ⚠️ PEMSA too few sections for "${title}": ${sectionCount} (need ≥${MIN_SECTIONS})`);
    }
  }

  const itDesc = desc || `PEMSA, agenzia di reclutamento specializzata nel settore edile e tecnico, cerca un profilo ${title} a ${city}. PEMSA garantisce condizioni di lavoro ottimali e un supporto professionale durante tutto il processo. Candidati tramite il portale ufficiale.`;
  const enDesc = `PEMSA, a staffing agency specialised in construction and technical trades, is looking for a ${title} in ${city}. PEMSA ensures optimal working conditions and professional support. Apply through the official portal.`;
  const deDesc = `PEMSA, eine auf Bau und Technik spezialisierte Personalvermittlung, sucht ein Profil als ${title} in ${city}. PEMSA gewährleistet optimale Arbeitsbedingungen und professionelle Unterstützung. Bewirb dich über das offizielle Portal.`;
  const frDesc = `PEMSA, agence de recrutement spécialisée dans le bâtiment et la technique, recherche un profil ${title} à ${city}. PEMSA garantit des conditions de travail optimales et un accompagnement professionnel. Postulez via le portail officiel.`;

  return {
    titleByLocale: { it: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} pemsa ${city}`),
    },
  };
}
