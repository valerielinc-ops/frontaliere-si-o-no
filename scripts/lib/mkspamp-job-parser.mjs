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

import { isTicinoRelevant, isGrigioniRelevant, isTargetSwissLocation } from './target-swiss-locations.mjs';

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
 * Fetch a detail page and extract location from embedded address JSON.
 * Returns { city, country, postalCode, street } or null.
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

    // Extract PostalAddress from embedded JSON
    const addrMatch = html.match(/\{[^{}]*"streetAddress"[^{}]*"addressCountry"[^{}]*\}/);
    if (addrMatch) {
      try {
        const addr = JSON.parse(addrMatch[0]);
        return {
          city: normalizeSpace(addr.addressLocality || ''),
          country: normalizeSpace(addr.addressCountry || ''),
          postalCode: normalizeSpace(addr.postalCode || ''),
          street: normalizeSpace(addr.streetAddress || ''),
        };
      } catch { /* ignore */ }
    }

    // Fallback: try JSON-LD
    const ldMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
    if (ldMatch) {
      try {
        const data = JSON.parse(ldMatch[1]);
        const loc = data.jobLocation || {};
        const addr = (typeof loc === 'object' && !Array.isArray(loc)) ? (loc.address || {}) : {};
        return {
          city: normalizeSpace(addr.addressLocality || ''),
          country: normalizeSpace(addr.addressCountry || ''),
          postalCode: normalizeSpace(addr.postalCode || ''),
          street: normalizeSpace(addr.streetAddress || ''),
        };
      } catch { /* ignore */ }
    }

    return null;
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

  return (
    isTicinoRelevant(city) ||
    isGrigioniRelevant(city) ||
    isTargetSwissLocation(city) ||
    /castel san pietro|giubiasco|minusio|locarno|bellinzona|lugano|mendrisio|chiasso|bioggio|manno|massagno/i.test(city)
  );
}

/**
 * Build localized content for an MKS PAMP job.
 */
export function buildMksPampLocalizedContent(job = {}) {
  const title = normalizeSpace(job.title);
  const city = normalizeSpace(job.city) || 'Castel San Pietro';
  const descText = stripHtml(job.descriptionHtml || '').slice(0, 280);

  const itDesc = descText || `MKS PAMP SA, leader mondiale nella raffinazione di metalli preziosi con sede a ${city}, cerca un profilo ${title}. L'azienda offre un ambiente internazionale e dinamico nel settore dei metalli preziosi. Candidati tramite il portale ufficiale.`;
  const enDesc = `MKS PAMP SA, a world leader in precious metals refining based in ${city}, is looking for a ${title}. The company offers an international and dynamic environment in the precious metals industry. Apply through the official portal.`;
  const deDesc = `MKS PAMP SA, ein weltweit führendes Unternehmen in der Edelmetallraffination mit Sitz in ${city}, sucht ein Profil als ${title}. Das Unternehmen bietet ein internationales und dynamisches Umfeld in der Edelmetallbranche. Bewirb dich über das offizielle Portal.`;
  const frDesc = `MKS PAMP SA, leader mondial du raffinage de métaux précieux basé à ${city}, recherche un profil ${title}. L'entreprise offre un environnement international et dynamique dans le secteur des métaux précieux. Postulez via le portail officiel.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} mks-pamp ${city}`),
      en: slugify(`${title} mks-pamp ${city}`),
      de: slugify(`${title} mks-pamp ${city}`),
      fr: slugify(`${title} mks-pamp ${city}`),
    },
  };
}
