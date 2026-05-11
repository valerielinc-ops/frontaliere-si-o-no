/**
 * Vir Biotechnology (Humabs BioMed) — Greenhouse API job parser
 *
 * Vir Biotechnology acquired Humabs BioMed SA, which has R&D operations
 * in Bellinzona, Canton Ticino. Vir uses Greenhouse as their ATS.
 *
 * Greenhouse API endpoint:
 *   https://boards-api.greenhouse.io/v1/boards/virbiotechnologyinc/jobs?content=true
 *
 * The API returns all jobs globally. We filter for Switzerland/Bellinzona positions.
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('vir-biotechnology');

export const GREENHOUSE_BOARD = 'virbiotechnologyinc';
export const GREENHOUSE_API = `https://boards-api.greenhouse.io/v1/boards/${GREENHOUSE_BOARD}/jobs?content=true`;

export const SWISS_LOCATION_KEYWORDS = [
  'bellinzona', 'switzerland', 'swiss', 'ticino', 'lugano',
  'manno', 'zurich', 'zürich', 'basel', 'bern', 'geneva', 'genève',
];

/**
 * Normalize whitespace in a string.
 */
export function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags and decode common entities.
 */
export function htmlToText(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Slugify a text string.
 */
export function slugify(value = '', suffix = '') {
  let s = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 200);
}

/**
 * Check if a Greenhouse job location matches Switzerland/Ticino.
 */
export function isSwissLocation(locationName = '') {
  return isTargetSwissLocation(locationName);
}

/**
 * Infer canton from a Greenhouse location string.
 */
export function inferCanton(location = '') {
  const loc = String(location || '').toLowerCase();
  if (loc.includes('bellinzona')) return 'TI';
  if (loc.includes('lugano')) return 'TI';
  if (loc.includes('manno')) return 'TI';
  if (loc.includes('ticino')) return 'TI';
  if (loc.includes('zurich') || loc.includes('zürich')) return 'ZH';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('geneva') || loc.includes('genève')) return 'GE';
  return '';
}

/**
 * Parse city name from Greenhouse location string.
 * Example: "Bellinzona, Switzerland" → "Bellinzona"
 */
export function parseCity(location = '') {
  const parts = String(location || '').split(',').map((s) => s.trim());
  // Typically: "City, State/Country" or "City, State, Country"
  return parts[0] || '';
}

/**
 * Parse jobs from the Greenhouse API JSON response.
 * Filters to Swiss locations only.
 *
 * @param {object} apiResponse - Parsed JSON from Greenhouse API
 * @returns {Array<{title: string, description: string, url: string, location: string, city: string, canton: string, department: string, datePosted: string, greenhouseId: number}>}
 */
export function parseGreenhouseJobs(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.jobs)) return [];

  const results = [];
  const seen = new Set();

  for (const job of apiResponse.jobs) {
    if (!job.title || !job.id) continue;

    // Check if any office/location is in Switzerland
    const offices = job.offices || [];
    const locationObj = job.location || {};
    const locationName = locationObj.name || '';

    const allLocations = [
      locationName,
      ...offices.map((o) => o.name || ''),
    ];

    const swissLocation = allLocations.find((loc) => isSwissLocation(loc));
    if (!swissLocation) continue;

    // Deduplicate
    if (seen.has(job.id)) continue;
    seen.add(job.id);

    const title = normalizeSpace(job.title);
    const descriptionHtml = job.content || '';
    const description = normalizeSpace(htmlToText(descriptionHtml));
    const url = job.absolute_url || '';
    const city = parseCity(swissLocation);
    const canton = inferCanton(swissLocation);

    const departments = (job.departments || []).map((d) => d.name || '').filter(Boolean);
    const department = departments.join(', ') || '';

    const datePosted = job.first_published
      ? job.first_published.split('T')[0]
      : job.updated_at
        ? job.updated_at.split('T')[0]
        : new Date().toISOString().split('T')[0];

    results.push({
      title,
      description,
      url,
      location: swissLocation,
      city: city || 'Bellinzona',
      canton: canton || HQ.canton,
      department,
      datePosted,
      greenhouseId: job.id,
    });
  }

  return results;
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
