/**
 * Agroscope — Prospective.ch JSON API job parser
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1000626/jobs
 *   Query params: lang=it&offset=0&limit=100&f=verwaltungseinheit:1083812
 *   Returns JSON: { medium_id, offset, total, jobs: [...], filtercount }
 *   Each job: { id, hk_id, viewkey, title, attributes, szas, links, start_date, end_date, language }
 *
 * No detail page fetching needed — the API returns full descriptions in `szas.*`.
 *   szas.sza_tasks, szas.sza_requirements, szas.sza_benefits, szas.sza_apply_link,
 *   szas.sza_company_profil, szas.sza_contact, szas.sza_location.city, szas.sza_location.region
 *
 * Direct links: jobs.admin.ch/posti-vacanti/{slug}/{viewkey}
 * Apply links: career74.sapsf.eu/career?company=bundesamtf&...
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';
import { isTargetCanton } from './crawler-location-config.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
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
 * Parse the Prospective API response and extract job items.
 * @param {object} data - Parsed JSON from the API
 * @returns {{ items: Array, total: number }}
 */
export function parseAgroscopeApiResponse(data = {}) {
  const rawJobs = data.jobs || [];
  const items = rawJobs.map((j) => {
    const attrs = j.attributes || {};
    const szas = j.szas || {};
    const links = j.links || {};

    const locationRaw = (attrs.arbeitsort || [])[0] || '';
    const regionRaw = (attrs.region || [])[0] || '';
    const pensum = (attrs['75'] || [])[0] || '';
    const pensumMin = szas.sza_pensum_min || szas['sza_pensum.min'] || '';

    // Extract city from location (format: "6593 Cadenazzo")
    const cityMatch = locationRaw.match(/^\d{4}\s+(.+)$/);
    const city = cityMatch ? cityMatch[1].trim() : locationRaw;
    const postalCode = locationRaw.match(/^(\d{4})/)?.[1] || '';

    // Extract canton abbreviation from region (format: "Ticino (TI)")
    const cantonMatch = regionRaw.match(/\(([A-Z]{2})\)/);
    const canton = cantonMatch ? cantonMatch[1] : '';

    // Build description from szas fields
    const parts = [];
    if (szas.sza_tasks) parts.push(stripHtml(szas.sza_tasks));
    if (szas.sza_requirements) parts.push(stripHtml(szas.sza_requirements));
    const description = parts.join('\n\n');

    return {
      id: String(j.id || ''),
      viewkey: j.viewkey || '',
      title: normalizeSpace(j.title),
      city,
      postalCode,
      location: locationRaw,
      region: regionRaw,
      canton,
      pensum: pensum ? `${pensumMin || pensum}-${pensum}%` : '',
      pensumMax: pensum,
      pensumMin: pensumMin || pensum,
      description,
      applyUrl: szas.sza_apply_link || '',
      directLink: links.directlink || '',
      startDate: j.start_date || '',
      endDate: j.end_date || '',
      language: j.language || 'it',
      fieldOfActivity: szas.sza_field_of_activity || (attrs.taetigkeitsbereich || [])[0] || '',
      role: szas.sza_role || (attrs.funktion || [])[0] || '',
      benefits: szas.sza_benefits ? stripHtml(szas.sza_benefits) : '',
    };
  });

  return { items, total: data.total || items.length };
}

/**
 * Check if a job is in any target canton based on location and region.
 */
export function isAgroscopeTicinoRelevant(job = {}) {
  const canton = String(job.canton || '').toUpperCase();
  if (isTargetCanton(canton)) return true;
  const combined = `${job.city || ''} ${job.location || ''} ${job.region || ''}`;
  return isTargetSwissLocation(combined);
}

/**
 * Infer canton from job data via the BFS municipality dataset.
 */
export function inferAgroscopeCanton(job = {}) {
  const canton = String(job.canton || '').toUpperCase();
  if (isTargetCanton(canton)) return canton;
  return inferAnyCanton(`${job.city || ''} ${job.location || ''} ${job.region || ''}`);
}

/**
 * Map field of activity / role to a category.
 */
export function inferAgroscopeCategory(job = {}) {
  const haystack = `${job.fieldOfActivity || ''} ${job.title || ''} ${job.role || ''}`.toLowerCase();
  if (/scien|ricerca|research|forschung|dottoran|post-doc/i.test(haystack)) return 'science';
  if (/ingegner|engineer|techni|tecnico/i.test(haystack)) return 'engineering';
  if (/informatica|software|ict|it\b|digital/i.test(haystack)) return 'it';
  if (/apprendist|lehrstell|apprenti/i.test(haystack)) return 'apprenticeship';
  if (/dirigen|leader|responsabile|leiter|chef/i.test(haystack)) return 'management';
  if (/amministra|admin|sachbearbeit|segretari/i.test(haystack)) return 'admin';
  if (/agronomi|agricol|agrario|veterinar|zoolog|botanik/i.test(haystack)) return 'science';
  return 'science';
}

/**
 * Build localized content for an Agroscope job.
 */
export function buildAgroscopeLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const city = String(job.city || 'Switzerland').trim();
  const description = String(job.description || '').trim();

  const fallbackDesc = `Agroscope cerca ${title} con sede a ${city}. Centro di competenze della Confederazione per la ricerca nel settore agroalimentare. Candidati online su jobs.admin.ch.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: {
      it: description || fallbackDesc,
      en: description || fallbackDesc,
      de: description || fallbackDesc,
      fr: description || fallbackDesc,
    },
    slugByLocale: {
      it: slugify(`${title} agroscope ${city}`),
      en: slugify(`${title} agroscope ${city}`),
      de: slugify(`${title} agroscope ${city}`),
      fr: slugify(`${title} agroscope ${city}`),
    },
  };
}
