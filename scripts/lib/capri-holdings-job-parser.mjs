/**
 * Capri Holdings (Michael Kors / Versace) — Workday ATS job parser
 *
 * Capri Holdings is a global luxury fashion group owning Michael Kors,
 * Versace, and Jimmy Choo. Their Mendrisio (TI) logistics hub employs
 * hundreds of workers, making their positions relevant for frontalieri.
 *
 * Workday API (tenant: "capri", changed from "capriholdings" 2026-03-25):
 *   Michael Kors: POST https://capri.wd1.myworkdayjobs.com/wday/cxs/capri/Michael_Kors/jobs
 *   Versace:      POST https://capri.wd1.myworkdayjobs.com/wday/cxs/capri/Versace/jobs
 *   Detail:       GET  https://capri.wd1.myworkdayjobs.com/wday/cxs/capri/{site}/job/{path}
 *
 * Public URL base:
 *   https://capri.wd1.myworkdayjobs.com/en-US/{site}/job/{path}
 *
 * Exports:
 *   parseCapriHoldingsDetailPage(html)  — extract job data from detail HTML
 *   isCapriHoldingsSwissJob(job)        — filter for Swiss/Ticino positions
 *   isCapriHoldingsJob(job)             — match Capri Holdings jobs in dataset
 *   CAPRI_WORKDAY_HOSTS                 — known Workday hostnames
 *   WORKDAY_API_BASE                    — Workday API base URL
 *   WORKDAY_SITES                       — brand site configurations
 */

/** Known Workday hosts for Capri Holdings brands */
export const CAPRI_WORKDAY_HOSTS = [
  'capri.wd1.myworkdayjobs.com',
  // Legacy hosts (may still appear in existing job URLs)
  'capriholdings.wd1.myworkdayjobs.com',
  'versace.wd5.myworkdayjobs.com',
  'michaelkors.wd5.myworkdayjobs.com',
];

/** Workday API base (tenant changed from "capriholdings" to "capri") */
export const WORKDAY_API_BASE = 'https://capri.wd1.myworkdayjobs.com/wday/cxs/capri';
export const WORKDAY_PUBLIC_BASE = 'https://capri.wd1.myworkdayjobs.com/en-US';

/** Brand sites within the "capri" Workday tenant */
export const WORKDAY_SITES = [
  { site: 'Michael_Kors', brand: 'Michael Kors' },
  { site: 'Versace', brand: 'Versace' },
];

import { isTargetSwissLocation } from './target-swiss-locations.mjs';

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
 * Extract job data from a Capri Holdings Workday detail page.
 * Workday SSR pages contain JSON-LD and structured HTML.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string, brand: string } | null}
 */
export function parseCapriHoldingsDetailPage(html = '') {
  if (!html) return null;

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*data-automation-id="jobPostingHeader"[^>]*>([\s\S]*?)<\/h2>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Location from JSON-LD or page content
  let location = '';
  const locationMatch = html.match(/addressLocality['"]\s*:\s*['"]([^'"]+)/i);
  if (locationMatch) {
    location = normalizeSpace(locationMatch[1]);
  }

  // Brand detection
  let brand = 'Capri Holdings';
  if (/versace/i.test(html)) brand = 'Versace';
  else if (/michael\s*kors/i.test(html)) brand = 'Michael Kors';
  else if (/jimmy\s*choo/i.test(html)) brand = 'Jimmy Choo';

  // Body from description containers
  let body = '';
  const contentMatch = html.match(/data-automation-id="jobPostingDescription"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  if (contentMatch) {
    body = stripHtml(contentMatch[1]);
  }

  if (!title && !body) return null;

  return { title, body, location, brand };
}

/**
 * Check if a Capri Holdings job is in Switzerland (Ticino area).
 * @param {{ location?: string, canton?: string, country?: string, addressCountry?: string }} job
 * @returns {boolean}
 */
export function isCapriHoldingsSwissJob(job) {
  if (!job) return false;
  const loc = String(job.location || '').toLowerCase();
  const canton = String(job.canton || '').toLowerCase();
  const country = String(job.country || job.addressCountry || '').toLowerCase();

  if (country === 'ch' || country === 'switzerland' || country === 'svizzera') return true;
  if (canton === 'ti') return true;

  return isTargetSwissLocation(loc);
}

/**
 * Check if a job belongs to Capri Holdings.
 * @param {object} job
 * @returns {boolean}
 */
export function isCapriHoldingsJob(job) {
  if (!job) return false;
  const key = String(job.companyKey || '').toLowerCase();
  const company = String(job.company || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();

  return (
    key === 'capri-holdings' ||
    key.includes('capri') ||
    key.includes('michael-kors') ||
    key.includes('versace') ||
    company.includes('capri') ||
    company.includes('michael kors') ||
    company.includes('versace') ||
    company.includes('jimmy choo') ||
    CAPRI_WORKDAY_HOSTS.some((h) => url.includes(h))
  );
}
