/**
 * MKS PAMP — Teamtailor career page parser
 *
 * RSS feed: https://careers.mkspamp.com/jobs.rss
 *   Contains all job titles, links, pubDate, and HTML descriptions.
 *
 * Detail pages: https://careers.mkspamp.com/jobs/{id}-{slug}
 *   JSON-LD JobPosting with full description, location (addressLocality, addressCountry),
 *   employmentType, datePosted.
 *
 * MKS PAMP SA is a precious metals refinery headquartered in Castel San Pietro, TI.
 * Global offices in Geneva, Barcelona, New York, Kuala Lumpur, Hong Kong, Shanghai, Dubai.
 * We filter for Ticino-relevant positions (Castel San Pietro).
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';

const RSS_URL = 'https://careers.mkspamp.com/jobs.rss';

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
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch all jobs from the RSS feed.
 * Returns array of { title, link, pubDate, descriptionHtml }.
 */
export async function fetchMksPampRss(timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(RSS_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const items = [];
    const itemRegex = /<item>(.*?)<\/item>/gs;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]>/s) || block.match(/<title>(.*?)<\/title>/s) || [])[1] || '';
      const link = (block.match(/<link>(.*?)<\/link>/s) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/s) || [])[1] || '';
      const descHtml = (block.match(/<description><!\[CDATA\[(.*?)\]\]>/s) || block.match(/<description>(.*?)<\/description>/s) || [])[1] || '';

      items.push({
        title: normalizeSpace(title),
        link: normalizeSpace(link),
        pubDate: normalizeSpace(pubDate),
        descriptionHtml: descHtml.trim(),
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a detail page and extract location + full description from embedded JSON-LD.
 * Returns { city, country, postalCode, street, description } or null.
 */
export async function fetchMksPampDetailLocation(url, timeoutMs = 15000) {
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

    let result = { city: '', country: '', postalCode: '', street: '', description: '' };

    // Try JSON-LD for both location AND description
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(ldMatch[1]);
        if (data['@type'] === 'JobPosting' || data.title) {
          const loc = data.jobLocation || {};
          const addr = (typeof loc === 'object' && !Array.isArray(loc)) ? (loc.address || {}) : {};
          result.city = normalizeSpace(addr.addressLocality || result.city);
          result.country = normalizeSpace(addr.addressCountry || result.country);
          result.postalCode = normalizeSpace(addr.postalCode || result.postalCode);
          result.street = normalizeSpace(addr.streetAddress || result.street);

          // Extract description from JSON-LD — this is the full job description
          if (data.description) {
            const desc = stripHtml(data.description);
            if (desc.split(/\s+/).length >= 50) {
              result.description = desc;
            }
          }
        }
      } catch { /* ignore malformed JSON */ }
    }

    // Fallback: extract PostalAddress from embedded JSON
    if (!result.city) {
      const addrMatch = html.match(/\{[^{}]*"streetAddress"[^{}]*"addressCountry"[^{}]*\}/);
      if (addrMatch) {
        try {
          const addr = JSON.parse(addrMatch[0]);
          result.city = normalizeSpace(addr.addressLocality || '');
          result.country = normalizeSpace(addr.addressCountry || '');
          result.postalCode = normalizeSpace(addr.postalCode || '');
          result.street = normalizeSpace(addr.streetAddress || '');
        } catch { /* ignore */ }
      }
    }

    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if a location is Ticino-relevant.
 */
export function isMksPampTicinoRelevant(location = {}) {
  const city = normalizeSpace(location.city || '').toLowerCase();
  const country = normalizeSpace(location.country || '').toUpperCase();

  // Must be in Switzerland
  if (country && country !== 'CH' && country !== 'SWITZERLAND') return false;

  // If no city info, assume Castel San Pietro (HQ)
  if (!city) return true;

  return isTargetSwissLocation(city);
}

/**
 * Build localized content for an MKS PAMP job.
 */
export function buildMksPampLocalizedContent(job = {}) {
  const title = normalizeSpace(job.title);
  const city = normalizeSpace(job.city) || 'Castel San Pietro';

  // Prefer full detail description from JSON-LD, then RSS excerpt, then fallback
  // Safety: always strip HTML in case raw tags leak through
  const detailDesc = stripHtml(normalizeSpace(job.detailDescription || ''));
  const rssDesc = stripHtml(job.descriptionHtml || '');

  const MIN_WORDS = 50;

  let description = '';
  if (detailDesc && detailDesc.split(/\s+/).length >= MIN_WORDS) {
    description = `${title} — MKS PAMP SA, ${city} (TI).\n\n${detailDesc}`;
  } else if (rssDesc && rssDesc.split(/\s+/).length >= MIN_WORDS) {
    description = `${title} — MKS PAMP SA, ${city} (TI).\n\n${rssDesc}`;
  } else {
    // Rich fallback with job-specific and company context (always >= 50 words)
    description = [
      `MKS PAMP SA, leader mondiale nella raffinazione di metalli preziosi con sede a ${city}, cerca un profilo ${title}.`,
      `Fondata nel 1979, MKS PAMP SA è parte del gruppo MKS PAMP GROUP, uno dei principali operatori globali nel settore dei metalli preziosi, con circa 350 collaboratori.`,
      `L'azienda offre un ambiente di lavoro internazionale, multiculturale e dinamico, con una cultura aziendale basata sulla sua storia familiare e valori di eccellenza operativa.`,
      `La sede principale si trova a Castel San Pietro, nel Canton Ticino, con uffici anche a Ginevra, Barcellona, New York, Kuala Lumpur, Hong Kong, Shanghai e Dubai.`,
      `I settori di attività includono raffinazione, trading, coniazione e tecnologie per metalli preziosi.`,
      `Candidati tramite il portale ufficiale careers.mkspamp.com.`,
    ].join(' ');
  }

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: description, en: description, de: description, fr: description },
    slugByLocale: {
      it: slugify(`${title} mks-pamp ${city}`),
      en: slugify(`${title} mks-pamp ${city}`),
      de: slugify(`${title} mks-pamp ${city}`),
      fr: slugify(`${title} mks-pamp ${city}`),
    },
  };
}
