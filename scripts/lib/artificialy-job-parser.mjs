/**
 * Artificialy — Career page HTML parser
 *
 * Source: https://www.artificialy.com/it/career
 *   Career page listing open positions (Lugano TI / Zurich).
 *   Site is behind Cloudflare managed challenge — may return 403.
 *   When accessible, page contains job cards with title, location, description, and apply links.
 *
 * Extraction strategies (tried in order):
 *   1. JSON-LD JobPosting structured data
 *   2. HTML job cards (common career page patterns)
 *   3. Link-based extraction (LinkedIn apply URLs with surrounding context)
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';

const BASE_URL = 'https://www.artificialy.com';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
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
 * Strategy 1: Extract jobs from JSON-LD JobPosting structured data.
 */
function extractJsonLdJobs(html) {
  const items = [];
  const scriptPattern = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const postings = Array.isArray(data) ? data : data['@type'] === 'JobPosting' ? [data] : [];
      for (const p of postings) {
        if (p['@type'] !== 'JobPosting') continue;
        const loc = p.jobLocation || {};
        const address = loc.address || {};
        items.push({
          title: normalizeSpace(p.title || p.name || ''),
          location: normalizeSpace(address.addressLocality || ''),
          region: normalizeSpace(address.addressRegion || ''),
          country: normalizeSpace(address.addressCountry || 'CH'),
          description: stripHtml(p.description || ''),
          applyUrl: p.url || p.directApply || '',
          employmentType: p.employmentType || 'FULL_TIME',
          datePosted: p.datePosted || '',
          validThrough: p.validThrough || '',
        });
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  return items;
}

/**
 * Strategy 2: Extract jobs from HTML job cards.
 * Looks for common career page patterns: sections/divs with job titles and locations.
 */
function extractHtmlJobCards(html) {
  const items = [];

  // Pattern: job card blocks — look for headings followed by location info
  // Common patterns: <h2/h3 class="...">Title</h2> ... <span>Location</span> ... <a href="...">Apply</a>
  const cardPatterns = [
    // Pattern A: heading + location in nearby span/p + link
    /<(?:h[2-4]|div)[^>]*class="[^"]*(?:job|position|role|opening|career)[^"]*"[^>]*>([\s\S]*?)<\/(?:h[2-4]|div)>/gi,
    // Pattern B: article or section blocks
    /<(?:article|section|div)[^>]*class="[^"]*(?:card|item|listing|vacancy)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|section|div)>/gi,
  ];

  for (const pattern of cardPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const block = match[1] || match[0];
      const titleMatch = block.match(/<(?:h[1-6])[^>]*>(.*?)<\/h[1-6]>/i);
      const title = titleMatch ? stripHtml(titleMatch[1]) : '';
      if (!title || title.length < 5) continue;

      // Extract location
      const locMatch = block.match(/(?:Lugano|Zurich|Zürich|Locarno|Bellinzona|Switzerland|Svizzera|Schweiz)/i);
      const location = locMatch ? locMatch[0] : '';

      // Extract link
      const linkMatch = block.match(/href="([^"]+)"/i);
      const url = linkMatch ? linkMatch[1] : '';

      // Extract description
      const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const description = descMatch ? stripHtml(descMatch[1]) : '';

      items.push({
        title,
        location,
        region: '',
        country: 'CH',
        description,
        applyUrl: url.startsWith('http') ? url : url.startsWith('/') ? `${BASE_URL}${url}` : '',
        employmentType: 'FULL_TIME',
        datePosted: '',
        validThrough: '',
      });
    }
  }

  return items;
}

/**
 * Strategy 3: Extract jobs from links with job-related context.
 * Looks for LinkedIn apply links or internal career links with surrounding text.
 */
function extractLinkBasedJobs(html) {
  const items = [];
  // Find all links that could be job application links
  const linkPattern = /<a[^>]*href="([^"]*(?:linkedin\.com\/jobs|linkedin\.com\/company|apply|career)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const url = match[1];
    const linkText = stripHtml(match[2]);
    if (!linkText || linkText.length < 3) continue;

    // Get surrounding context (300 chars before the link)
    const pos = match.index;
    const before = html.substring(Math.max(0, pos - 500), pos);

    // Look for a heading before the link
    const headingMatch = before.match(/<(?:h[1-6])[^>]*>(.*?)<\/h[1-6]>/gi);
    const lastHeading = headingMatch ? stripHtml(headingMatch[headingMatch.length - 1]) : '';

    // Look for location keywords
    const contextBlock = before + match[0];
    const locMatch = contextBlock.match(/(?:Lugano|Zurich|Zürich|Switzerland|Svizzera|Ticino|Tessin)/i);

    if (lastHeading && lastHeading.length > 5) {
      items.push({
        title: lastHeading,
        location: locMatch ? locMatch[0] : '',
        region: '',
        country: 'CH',
        description: '',
        applyUrl: url.startsWith('http') ? url : `${BASE_URL}${url}`,
        employmentType: 'FULL_TIME',
        datePosted: '',
        validThrough: '',
      });
    }
  }

  return items;
}

/**
 * Main parser: try all strategies and return deduplicated results.
 * @param {string} html - Raw HTML of the career page
 * @returns {{ items: Array }}
 */
export function parseArtificialyCareerPage(html = '') {
  if (!html || html.length < 200) return { items: [] };

  // Check for Cloudflare challenge page
  if (html.includes('Just a moment...') || html.includes('cf_chl_opt') || html.includes('challenge-platform')) {
    return { items: [], blocked: true };
  }

  // Try strategies in order of reliability
  let items = extractJsonLdJobs(html);
  if (items.length === 0) items = extractHtmlJobCards(html);
  if (items.length === 0) items = extractLinkBasedJobs(html);

  // Deduplicate by title
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return { items: unique, blocked: false };
}

/**
 * Check if a job is in any target canton.
 */
export function isArtificialyTicinoRelevant(job = {}) {
  return isTargetSwissLocation(`${job.location || ''} ${job.title || ''}`);
}

/**
 * Infer canton from job data via the BFS municipality dataset.
 */
export function inferArtificialyCanton(job = {}) {
  return inferAnyCanton(`${job.location || ''} ${job.region || ''}`);
}

/**
 * Map job title to a category.
 */
export function inferArtificialyCategory(title = '') {
  const haystack = title.toLowerCase();
  if (/machine learning|ml engineer|data scien|ai research/i.test(haystack)) return 'it';
  if (/software|developer|engineer|platform|devops|mlops|cloud|backend|frontend|full.?stack/i.test(haystack)) return 'it';
  if (/product|head of|director|cto|ceo|manager|lead/i.test(haystack)) return 'management';
  if (/hr|human resource|admin|amministra|segretari/i.test(haystack)) return 'admin';
  if (/design|ux|ui/i.test(haystack)) return 'it';
  if (/sales|marketing|business/i.test(haystack)) return 'sales';
  return 'it';
}

/**
 * Build localized content for an Artificialy job.
 */
export function buildArtificialyLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || 'Lugano').trim();
  const description = String(job.description || '').trim();

  const fallbackDesc = `Artificialy cerca ${title} con sede a ${location}. Azienda svizzera specializzata in intelligenza artificiale con sedi a Lugano e Zurigo. Candidati online su artificialy.com.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: {
      it: description || fallbackDesc,
      en: description || fallbackDesc,
      de: description || fallbackDesc,
      fr: description || fallbackDesc,
    },
    slugByLocale: {
      it: slugify(`${title} artificialy ${location}`),
      en: slugify(`${title} artificialy ${location}`),
      de: slugify(`${title} artificialy ${location}`),
      fr: slugify(`${title} artificialy ${location}`),
    },
  };
}
