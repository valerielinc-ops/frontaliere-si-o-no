/**
 * PwC Switzerland — Prospective.ch JSON API job parser
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1000311/jobs
 *   Query params: lang=en&offset=0&limit=500
 *   Returns JSON: { medium_id, offset, total, jobs: [...], filtercount }
 *   Each job: { id, hk_id, viewkey, title, attributes, szas, links, start_date, end_date, language }
 *
 * No detail page fetching needed — the API returns full descriptions in `szas.*`.
 *   szas.sza_tasks, szas.sza_requirements, szas.sza_introduction,
 *   szas.sza_company_profil, szas.sza_contact, szas.sza_apply_link,
 *   szas.sza_location.city, szas.sza_location.zip, szas.sza_location.street,
 *   szas.sza_location.region, szas.sza_location.country,
 *   szas.sza_employment_type, szas.sza_pensum, szas.sza_pensum.min, szas.sza_pensum.max,
 *   szas.sza_reference_code
 *
 * Direct links: links.directlink (canonical detail URL)
 * Apply links: szas.sza_apply_link
 *
 * Attributes keyed by ID:
 *   10 = experience, 20 = location, 30 = line of service,
 *   40 = time type, 50 = specialism
 */

import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags and decode common entities to plain text.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html = '') {
  if (!html) return '';
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
  const base = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(base, 180);
}

/**
 * Build a clean description from Prospective szas fields.
 * Combines introduction + tasks + requirements, stripping HTML tags.
 * @param {object} szas - The szas object from the API response
 * @returns {string}
 */
export function buildPwcDescription(szas = {}) {
  if (!szas) return '';
  const parts = [];

  const intro = stripHtml(szas.sza_introduction || '');
  if (intro) parts.push(intro);

  const tasks = stripHtml(szas.sza_tasks || '');
  if (tasks) parts.push(tasks);

  const requirements = stripHtml(szas.sza_requirements || '');
  if (requirements) parts.push(requirements);

  return parts.join('\n\n');
}

/**
 * Extract location city from structured szas.sza_location fields.
 * Falls back through city -> region -> 'Switzerland'.
 * @param {object} szas - The szas object from the API response
 * @returns {string}
 */
export function inferPwcLocation(szas = {}) {
  if (!szas) return 'Switzerland';
  const loc = szas['sza_location'] || {};
  // sza_location can be an object with nested fields, or szas can have flat keys
  const city = normalizeSpace(loc.city || szas['sza_location.city'] || '');
  if (city) return city;

  const region = normalizeSpace(loc.region || szas['sza_location.region'] || '');
  if (region) return region;

  return 'Switzerland';
}

/**
 * Extract postal code from structured szas.sza_location fields.
 * @param {object} szas
 * @returns {string}
 */
export function inferPwcPostalCode(szas = {}) {
  if (!szas) return '';
  const loc = szas['sza_location'] || {};
  return normalizeSpace(loc.zip || szas['sza_location.zip'] || '');
}

/**
 * Map pensum/employment type from szas fields to our format.
 * @param {object} szas
 * @returns {string} 'full-time' | 'part-time'
 */
export function mapPwcEmploymentType(szas = {}) {
  if (!szas) return 'full-time';
  const empType = normalizeSpace(szas.sza_employment_type || '').toLowerCase();
  if (empType.includes('part') || empType.includes('teilzeit')) return 'part-time';
  if (empType.includes('full') || empType.includes('vollzeit')) return 'full-time';

  // Check pensum fields
  const pensumMax = Number(szas['sza_pensum.max'] || szas.sza_pensum || 0);
  const pensumMin = Number(szas['sza_pensum.min'] || 0);

  if (pensumMax > 0 && pensumMax < 100) return 'part-time';
  if (pensumMin > 0 && pensumMin < 80) return 'part-time';

  return 'full-time';
}

/**
 * Infer job category from title and description.
 * @param {string} title
 * @param {string} description
 * @returns {string}
 */
export function inferPwcCategory(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();

  if (/(audit|revisione|prüfung|wirtschaftsprüf)/i.test(text)) return 'audit';
  if (/(tax|steu|fiscal|imposte|tva|mwst)/i.test(text)) return 'tax';
  if (/(advisory|consulen|consult|beratung|strateg|deal|transaction|m&a)/i.test(text)) return 'consulting';
  if (/(software|developer|engineer|devops|cloud|cyber|security|data\s*scien|machine\s*learn|artificial|ai\b|sap\b|digital|tech)/i.test(text)) return 'tech';
  if (/(legal|juridique|rechts|compliance|regulat)/i.test(text)) return 'legal';
  if (/(marketing|communicat|kommunikation|brand)/i.test(text)) return 'marketing';
  if (/(human\s*resource|hr\b|talent|recruit|people|personale)/i.test(text)) return 'hr';
  if (/(finance|finanz|contabil|buchhalt|accounting|controller)/i.test(text)) return 'finance';
  if (/(admin|assist|segretari|office|reception)/i.test(text)) return 'admin';
  if (/(apprendist|apprenti|lehrling|praktik|intern|stage|trainee)/i.test(text)) return 'apprenticeship';

  return 'consulting';
}

/**
 * Parse the Prospective API response and extract PwC job items.
 * @param {object} data - Parsed JSON from the API
 * @returns {{ items: Array, total: number }}
 */
export function parsePwcJobs(data = {}) {
  if (!data) return { items: [], total: 0 };
  const rawJobs = data.jobs || [];
  const items = rawJobs.map((j) => {
    const attrs = j.attributes || {};
    const szas = j.szas || {};
    const links = j.links || {};

    const locationAttrs = (attrs['20'] || []).map(normalizeSpace).filter(Boolean);
    const lineOfService = (attrs['30'] || [])[0] || '';
    const timeType = (attrs['40'] || [])[0] || '';
    const specialism = (attrs['50'] || [])[0] || '';

    const city = inferPwcLocation(szas);
    const postalCode = inferPwcPostalCode(szas);
    const description = buildPwcDescription(szas);
    const employmentType = mapPwcEmploymentType(szas);

    return {
      id: String(j.id || ''),
      viewkey: j.viewkey || '',
      title: normalizeSpace(j.title),
      city,
      postalCode,
      location: locationAttrs[0] || city,
      locationAttrs,
      region: normalizeSpace((szas['sza_location'] || {}).region || szas['sza_location.region'] || ''),
      lineOfService,
      specialism,
      timeType,
      description,
      applyUrl: szas.sza_apply_link || '',
      directLink: links.directlink || '',
      startDate: j.start_date || '',
      endDate: j.end_date || '',
      language: j.language || 'en',
      employmentType,
      referenceCode: szas.sza_reference_code || '',
    };
  });

  return { items, total: data.total || items.length };
}

/**
 * Build localized content for a PwC job.
 * @param {object} job - Parsed job item
 * @returns {{ titleByLocale, descriptionByLocale, slugByLocale }}
 */
export function buildPwcLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const city = String(job.city || 'Switzerland').trim();
  const description = String(job.description || '').trim();

  const fallbackDesc = `PwC Switzerland cerca ${title} con sede a ${city}. PwC e una delle principali societa di consulenza e revisione al mondo. Candidati online su pwc.ch.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: {
      it: description || fallbackDesc,
      en: description || fallbackDesc,
      de: description || fallbackDesc,
      fr: description || fallbackDesc,
    },
    slugByLocale: {
      it: slugify(`${title} pwc ${city}`),
      en: slugify(`${title} pwc ${city}`),
      de: slugify(`${title} pwc ${city}`),
      fr: slugify(`${title} pwc ${city}`),
    },
  };
}
