/**
 * Decathlon Suisse -- joinus.decathlon.ch job parser
 *
 * Decathlon uses Digital Recruiters (Cegid HR) as their ATS. The careers
 * page at joinus.decathlon.ch/it_CH/annonces is a Nuxt.js SPA backed by
 * the Digital Recruiters API.
 *
 * The page HTML includes an embedded Nuxt state object with:
 *   - jobAds: array of job ad objects (may be empty)
 *   - API base URLs for fetching more data
 *
 * When jobAds is empty in the state, there are no open positions.
 * When it contains entries, each has id, title, location, contract etc.
 *
 * This module provides:
 *   parseDecathlonListingPage(html) -- extract job links from listing/state
 *   parseDecathlonDetailPage(html)  -- extract job data from detail page
 *   isDecathlonTicinoJob(job)       -- filter for Ticino positions
 *   DECATHLON_API_BASE              -- Digital Recruiters API base URL
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';

export const DECATHLON_API_BASE = 'https://api.digitalrecruiters.com';

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
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

/**
 * Try to extract Nuxt state data from the HTML.
 * The page embeds state as: window.__NUXT__= or __NUXT_DATA__.
 * The jobAds array lives inside this state.
 */
function extractNuxtJobAds(html) {
  // Try to find jobAds JSON array in the embedded state
  const jobAdsMatch = html.match(/"jobAds"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  if (jobAdsMatch) {
    try {
      return JSON.parse(jobAdsMatch[1]);
    } catch { /* ignore parse errors */ }
  }
  return [];
}

/**
 * Extract job links from a Decathlon listing page HTML.
 *
 * Strategy 1: Parse embedded Nuxt state for jobAds array
 * Strategy 2: Look for job card links in rendered HTML
 * Strategy 3: Extract from annonce/annonces URL patterns
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string, location: string }[]}
 */
export function parseDecathlonListingPage(html = '') {
  if (!html) return [];

  const results = [];

  // Strategy 1: Extract from Nuxt embedded state
  const nuxtAds = extractNuxtJobAds(html);
  for (const ad of nuxtAds) {
    if (!ad) continue;
    const id = ad.id || ad.slug || '';
    const title = normalizeSpace(ad.title || ad.name || '');
    const location = normalizeSpace(ad.city || ad.location || '');
    if (id && title) {
      results.push({
        url: `https://joinus.decathlon.ch/it_CH/annonces/${id}`,
        title,
        location,
      });
    }
  }

  // Strategy 2: Look for /it_CH/annonces/{slug} links
  const linkPattern = /href="(\/it_CH\/annonces\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const relUrl = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (relUrl && rawTitle && rawTitle.length > 3) {
      results.push({
        url: `https://joinus.decathlon.ch${relUrl}`,
        title: rawTitle,
        location: '',
      });
    }
  }

  // Strategy 3: /annonce/ singular pattern
  const singularPattern = /href="(\/it_CH\/annonce\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = singularPattern.exec(html)) !== null) {
    const relUrl = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (relUrl && rawTitle && rawTitle.length > 3) {
      results.push({
        url: `https://joinus.decathlon.ch${relUrl}`,
        title: rawTitle,
        location: '',
      });
    }
  }

  // Deduplicate
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Extract job data from a Decathlon detail page.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string, contract: string } | null}
 */
export function parseDecathlonDetailPage(html = '') {
  if (!html) return null;

  // Title from h1 or JSON-LD
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Location from structured data or page content
  let location = '';
  const locationMatch = html.match(/addressLocality['"]\s*:\s*['"]([^'"]+)/i)
    || html.match(/location['"]\s*:\s*['"]([^'"]+)/i);
  if (locationMatch) {
    location = normalizeSpace(locationMatch[1]);
  }

  // Contract type
  let contract = '';
  const contractMatch = html.match(/employmentType['"]\s*:\s*['"]([^'"]+)/i);
  if (contractMatch) {
    contract = normalizeSpace(contractMatch[1]);
  }

  // Body from main content area
  let body = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (contentMatch) {
    body = normalizeSpace(stripHtml(contentMatch[1]));
  }

  if (!title && !body) return null;

  return { title, body, location, contract };
}

/**
 * Check if a Decathlon job is in Ticino.
 * @param {{ location?: string, canton?: string, city?: string }} job
 * @returns {boolean}
 */
export function isDecathlonTicinoJob(job) {
  if (!job) return false;
  const loc = String(job.location || job.city || '').toLowerCase();
  const canton = String(job.canton || '').toLowerCase();

  if (canton === 'ti' || canton === 'ticino' || canton === 'tessin') return true;

  return isTargetSwissLocation(loc);
}

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
