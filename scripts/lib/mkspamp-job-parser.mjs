import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
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
 * The active Swiss site is Castel San Pietro (TI); the crawler keeps Swiss
 * positions and does not treat the company's foreign offices as Swiss jobs.
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';
import { detectLanguage } from './detect-language.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

const RSS_URL = 'https://careers.mkspamp.com/jobs.rss';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
};

function decodeEntities(value = '') {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : entity;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? entity : named;
  });
}

/**
 * Teamtailor description HTML (JSON-LD `description`, entity-encoded, or the
 * RSS `<description>`) as markdown: `<h2>` → `## `, `<li>` → `- `, paragraphs
 * kept apart. A tag-stripping helper used to flatten it into one line, so 5/5 stored
 * jobs published their MISSION / RESPONSIBILITIES / PROFILE lists as prose,
 * and it deleted every numeric entity (`Manager&#39;s` → `Managers`).
 */
export function teamtailorHtmlToMarkdown(html = '') {
  let source = String(html || '');
  // JSON-LD carries the markup entity-encoded (`&lt;h2&gt;MISSION&lt;/h2&gt;`).
  if (!/<[a-z][^>]*>/i.test(source) && /&lt;[a-z]/i.test(source)) source = decodeEntities(source);
  const text = source
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, heading) => `\n\n## ${heading}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|ul|ol|section|blockquote)(?:\s[^>]*)?>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  const lines = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim());
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '-' || line === '##') {
      // `<li><p>text</p></li>`: the bullet and its text land on two lines.
      const next = lines.slice(i + 1).findIndex(Boolean);
      if (line === '-' && next >= 0 && !lines[i + 1 + next].startsWith('- ')) {
        lines[i + 1 + next] = `- ${lines[i + 1 + next]}`;
      }
      continue;
    }
    if (!line) {
      const prev = out[out.length - 1] || '';
      const nextLine = lines.slice(i + 1).find(Boolean) || '';
      if (prev.startsWith('- ') && (nextLine.startsWith('- ') || nextLine === '-')) continue;
      if (prev !== '') out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
            const desc = teamtailorHtmlToMarkdown(data.description);
            if (meetsSourceBodyFloor(desc)) {
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
 * Check if a location is relevant to the Swiss site.
 */
export function isMksPampSwissRelevant(location = {}) {
  const city = normalizeSpace(location.city || '').toLowerCase();
  const country = normalizeSpace(location.country || '').toUpperCase();

  // Must be in Switzerland
  if (country && country !== 'CH' && country !== 'SWITZERLAND') return false;

  // If no city info, assume Castel San Pietro (HQ)
  if (!city) return true;

  return isTargetSwissLocation(city);
}

/** @deprecated Use isMksPampSwissRelevant() instead. Kept for API compatibility. */
export const isMksPampTicinoRelevant = isMksPampSwissRelevant;

/**
 * Build localized content for an MKS PAMP job.
 */
export function buildMksPampLocalizedContent(job = {}) {
  const title = normalizeSpace(job.title);
  const city = normalizeSpace(job.city) || 'Castel San Pietro';

  // Detail description from JSON-LD first, then the RSS excerpt, as
  // markdown (lists and paragraphs), not a flattened line.
  const detailDesc = teamtailorHtmlToMarkdown(job.detailDescription || '');
  const rssDesc = teamtailorHtmlToMarkdown(job.descriptionHtml || '');

  // Source text only. Without MIN_SOURCE_BODY_WORDS words of posting (detail
  // JSON-LD or RSS) the description stays empty: the runner keeps the text a
  // previous run read from the source, or does not publish the job this run.
  // The company paragraph that used to stand in ("MKS PAMP SA, leader
  // mondiale … cerca un profilo …") was not the posting.
  const body = meetsSourceBodyFloor(detailDesc) ? detailDesc : (meetsSourceBodyFloor(rssDesc) ? rssDesc : '');
  const description = body ? `${title} — MKS PAMP SA, ${city} (TI).\n\n${body}` : '';
  // Only the slot of the language the posting is written in: a copy in the
  // other slots reads as "already localized" and the translation step
  // never runs (English postings sat untranslated in it/de/fr).
  const sourceLang = body ? detectLanguage(body, 'it') : '';

  return {
    sourceLang,
    description,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: description ? { [sourceLang]: description } : {},
    slugByLocale: {
      it: slugify(`${title} mks-pamp ${city}`),
      en: slugify(`${title} mks-pamp ${city}`),
      de: slugify(`${title} mks-pamp ${city}`),
      fr: slugify(`${title} mks-pamp ${city}`),
    },
  };
}

/**
 * The company paragraph earlier runs published instead of a missing posting
 * ("MKS PAMP SA, leader mondiale nella raffinazione … cerca un profilo …
 * Candidati tramite il portale ufficiale careers.mkspamp.com.") and its
 * translations, recognised by the portal sentence. Only used to clear stale
 * copies; it is never produced again.
 */
export function isMksPampInventedDescription(text = '') {
  const value = String(text || '');
  return /leader mondiale nella raffinazione di metalli preziosi[\s\S]*cerca un profilo/i.test(value)
    || /careers\.mkspamp\.com\.?\s*$/i.test(value.trim()) && !/\n/.test(value.trim());
}

/** Source text of a stored record (source-locale slot, then description), or null. */
export function storedMksPampSourceText(record) {
  if (!record) return null;
  const lang = String(record.sourceLang || '').trim();
  for (const candidate of [record.descriptionByLocale?.[lang], record.description]) {
    const text = String(candidate || '').trim();
    if (text && !isMksPampInventedDescription(text) && meetsSourceBodyFloor(text)) return { text, lang };
  }
  return null;
}

/**
 * Source-only rule for a job built without a body: the stored source text
 * of the same posting, or `null` (not published this run).
 */
export function resolveMksPampJobBody(job, prev) {
  if (meetsSourceBodyFloor(job?.description || '')) return job;
  const stored = storedMksPampSourceText(prev);
  if (!stored) return null;
  const lang = stored.lang || job.sourceLang;
  return { ...job, description: stored.text, sourceLang: lang, descriptionByLocale: { [lang]: stored.text } };
}

/** Remove stale company-paragraph copies from every locale slot (in place). */
export function clearMksPampInventedSlots(job) {
  let removed = 0;
  for (const [locale, text] of Object.entries(job?.descriptionByLocale || {})) {
    if (isMksPampInventedDescription(text)) {
      delete job.descriptionByLocale[locale];
      removed += 1;
    }
  }
  return removed;
}

function comparableText(text = '') {
  return String(text || '').replace(/[#*•\-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Remove, from every slot but the source one, stale copies of the source
 * text: identical once markdown and whitespace are ignored (older runs wrote
 * the source into all four slots), or still written in the source language
 * (a copy of an older version of it). Returns the number of slots cleared;
 * the caller marks the job for retranslation.
 */
export function clearMksPampSourceCopies(job) {
  const sourceLang = String(job?.sourceLang || '').trim();
  const byLocale = job?.descriptionByLocale || {};
  const source = comparableText(byLocale[sourceLang] || job?.description || '');
  if (!sourceLang || !source) return 0;
  let removed = 0;
  for (const [locale, text] of Object.entries(byLocale)) {
    if (locale === sourceLang || !String(text || '').trim()) continue;
    if (comparableText(text) === source || detectLanguage(String(text), locale) === sourceLang) {
      delete byLocale[locale];
      removed += 1;
    }
  }
  return removed;
}
