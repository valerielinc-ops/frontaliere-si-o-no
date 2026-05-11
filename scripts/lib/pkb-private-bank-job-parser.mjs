/**
 * PKB Private Bank -- careers portal parser
 *
 * Main page: https://www.pkb.ch/en/about-us/work-with-us/
 * Careers portal: https://careers.pkb.ch/jobs.php
 *
 * The careers portal (careers.pkb.ch) is a JavaScript SPA that does
 * NOT return server-rendered HTML. Instead, it returns a JS tracking
 * snippet that redirects. Job listings are loaded client-side only.
 *
 * Strategy:
 *   1. Fetch the main PKB "work with us" page for career-related links
 *   2. Fetch the careers portal HTML and try multiple parsing strategies
 *   3. If the portal returns only JS (no parseable jobs), create a
 *      placeholder entry pointing to the careers portal URL so users
 *      can browse positions directly
 *
 * PKB is headquartered in Lugano with all positions in Ticino.
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';
import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';

const HQ = getCompanyDefaults('pkb-private-bank');

const CAREERS_URL = 'https://www.pkb.ch/en/about-us/work-with-us/';
const CAREERS_PORTAL = 'https://careers.pkb.ch/jobs.php?source=&lan=en&language=en';
const CAREERS_PORTAL_IT = 'https://careers.pkb.ch/jobs.php?source=&lan=it&language=it';
const CAREERS_BASE = 'https://careers.pkb.ch';
const PKB_MAIN = 'https://www.pkb.ch';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';


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

/**
 * Parse the PKB careers portal HTML for job listings.
 * The portal may use various HTML structures -- we try multiple patterns.
 */
export function parsePkbListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  // Quick check: if the HTML is just a JS redirect snippet (< 500 chars,
  // contains "document.referrer" or "window.location"), skip parsing
  if (html.length < 1000 && /document\.referrer|window\.location/i.test(html)) {
    return [];
  }

  const jobs = [];

  // Strategy 1: Look for job links with typical patterns
  const linkRe = /<a\s+[^>]*href="([^"]*(?:job[_-]?details|position|vacancy|offer)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (!rawTitle || rawTitle.length < 3) continue;

    const fullUrl = href.startsWith('http') ? href : new URL(href, CAREERS_BASE).href;
    const idMatch = href.match(/[?&]id=(\d+)/i) || href.match(/\/(\d+)\/?$/);
    const jobId = idMatch ? idMatch[1] : slugify(rawTitle).slice(0, 30);

    jobs.push({
      id: `pkb-private-bank-${jobId}`,
      title: rawTitle,
      url: fullUrl,
      jobId,
      location: 'Lugano',
      canton: HQ.canton,
    });
  }

  // Strategy 2: Look for table rows or list items with job-like content
  if (jobs.length === 0) {
    const rowRe = /<(?:tr|li|div)\s+[^>]*class="[^"]*(?:job|position|vacancy|offer|listing)[^"]*"[^>]*>([\s\S]*?)<\/(?:tr|li|div)>/gi;
    while ((match = rowRe.exec(html)) !== null) {
      const block = match[1];
      const titleMatch = block.match(/<(?:a|h[1-6]|strong|b)[^>]*>([\s\S]*?)<\/(?:a|h[1-6]|strong|b)>/i);
      if (!titleMatch) continue;

      const rawTitle = normalizeSpace(stripHtml(titleMatch[1]));
      if (!rawTitle || rawTitle.length < 3) continue;

      const linkMatch = block.match(/<a\s+[^>]*href="([^"]+)"/i);
      const url = linkMatch
        ? (linkMatch[1].startsWith('http') ? linkMatch[1] : new URL(linkMatch[1], CAREERS_BASE).href)
        : CAREERS_PORTAL;

      jobs.push({
        id: `pkb-private-bank-${slugify(rawTitle).slice(0, 40)}`,
        title: rawTitle,
        url,
        jobId: slugify(rawTitle).slice(0, 30),
        location: 'Lugano',
        canton: HQ.canton,
      });
    }
  }

  // Strategy 3: Fallback -- look for any links containing job-related keywords
  if (jobs.length === 0) {
    const allLinksRe = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = allLinksRe.exec(html)) !== null) {
      const href = match[1];
      const rawTitle = normalizeSpace(stripHtml(match[2]));

      if (!rawTitle || rawTitle.length < 10) continue;
      if (!/(?:analyst|manager|officer|director|specialist|associate|advisor|consultant|compliance|risk|wealth|portfolio|banking|relationship|intern|stage|assistant|developer|engineer)/i.test(rawTitle)) continue;

      const fullUrl = href.startsWith('http') ? href : new URL(href, CAREERS_BASE).href;

      jobs.push({
        id: `pkb-private-bank-${slugify(rawTitle).slice(0, 40)}`,
        title: rawTitle,
        url: fullUrl,
        jobId: slugify(rawTitle).slice(0, 30),
        location: 'Lugano',
        canton: HQ.canton,
      });
    }
  }

  // Deduplicate by title
  const seen = new Set();
  return jobs.filter((j) => {
    const key = j.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Fetch and parse the PKB careers portal.
 * Tries both the English and Italian portal URLs, plus the main PKB
 * "work with us" page for any embedded job links.
 */
export async function fetchPkbJobs(timeoutMs = 15000) {
  const allJobs = [];

  // Try multiple portal URLs
  const urlsToTry = [CAREERS_PORTAL, CAREERS_PORTAL_IT, CAREERS_URL];

  for (const url of urlsToTry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/html',
          'User-Agent': UA,
        },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      const jobs = parsePkbListingHtml(html);
      if (jobs.length > 0) {
        allJobs.push(...jobs);
        break; // Found jobs, no need to try other URLs
      }
    } catch (err) {
      clearTimeout(timer);
      console.warn(`\u26a0\ufe0f Failed to fetch ${url}: ${err.message}`);
    }
  }

  // Deduplicate
  const seen = new Set();
  return allJobs.filter((j) => {
    const key = j.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse a PKB job detail page for description.
 */
export function parsePkbDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract main content area
  const contentMatch = html.match(/<div[^>]*class="[^"]*(?:content|description|detail|body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const rawHtml = contentMatch ? contentMatch[1] : '';
  const description = stripHtml(rawHtml);

  // Extract requirements/bullets
  const bullets = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(rawHtml)) !== null) {
    const text = normalizeDescriptionSpace(stripHtml(m[1]));
    if (text.length > 5) bullets.push(text);
  }

  return {
    description: description || '',
    bullets,
  };
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
