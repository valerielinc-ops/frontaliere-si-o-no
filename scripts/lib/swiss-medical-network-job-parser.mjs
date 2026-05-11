/**
 * Swiss Medical Network — SmartRecruiters job parser
 *
 * Swiss Medical Network operates multiple clinics across Switzerland including:
 *   - Clinica Sant'Anna (Sorengo, TI)
 *   - Clinica Ars Medica (Gravesano, TI)
 *   - Centro Medico Blenio (Acquarossa, TI)
 *
 * Career page: https://www.swissmedical.net/en/career/job-offers
 * The page filters by region; Ticino region UUID: 7845726f-4952-4b7c-88da-8ff4f85e6afb
 *
 * Job application links go to jobs.smartrecruiters.com/SwissMedicalNetwork1/...
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';

export const TICINO_REGION_UUID = '7845726f-4952-4b7c-88da-8ff4f85e6afb';

export const TICINO_CLINICS = [
  { code: 'CSA', name: 'Clinica Sant\'Anna', city: 'Sorengo' },
  { code: 'CAM', name: 'Clinica Ars Medica', city: 'Gravesano' },
  { code: 'CMO', name: 'Clinica Moncucco', city: 'Lugano' },
  { code: 'SAC', name: 'Sana Cure Sagl', city: 'Lugano' },
  { code: '50-BL', name: 'Centro Medico Blenio', city: 'Acquarossa' },
];

export const TICINO_LOCATION_KEYWORDS = [
  'sorengo', 'gravesano', 'lugano', 'locarno', 'bellinzona',
  'mendrisio', 'chiasso', 'acquarossa', 'ticino', 'manno',
  'sant\'anna', 'ars medica', 'moncucco', 'blenio',
];

/**
 * Normalize whitespace.
 */
export function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags and decode entities.
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
 * Check if a location/clinic is in Ticino.
 */
export function isTicinoLocation(text = '') {
  if (isTargetSwissLocation(text)) return true;
  // Also check clinic names specific to Ticino
  const lower = String(text || '').toLowerCase();
  return TICINO_LOCATION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Infer city from clinic name or location string.
 */
export function inferCity(text = '') {
  const lower = String(text || '').toLowerCase();
  for (const clinic of TICINO_CLINICS) {
    if (lower.includes(clinic.name.toLowerCase()) || lower.includes(clinic.code.toLowerCase())) {
      return clinic.city;
    }
  }
  if (lower.includes('sorengo')) return 'Sorengo';
  if (lower.includes('gravesano')) return 'Gravesano';
  if (lower.includes('lugano')) return 'Lugano';
  if (lower.includes('locarno')) return 'Locarno';
  if (lower.includes('bellinzona')) return 'Bellinzona';
  if (lower.includes('mendrisio')) return 'Mendrisio';
  if (lower.includes('acquarossa')) return 'Acquarossa';
  return 'Lugano'; // Default Ticino city
}

/**
 * Parse job listings from the Swiss Medical Network HTML career page.
 *
 * Each job card typically contains:
 *   - Title (h3 or link text)
 *   - Clinic name
 *   - Location
 *   - Employment percentage
 *   - Start date
 *   - Link to SmartRecruiters application
 *
 * @param {string} html - Raw HTML of the job offers page (filtered for Ticino)
 * @returns {Array<{title: string, clinic: string, city: string, employmentRate: string, startDate: string, applyUrl: string, idx: number}>}
 */
export function parseSwissMedicalJobs(html = '') {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  let idx = 0;

  // Extract SmartRecruiters links and surrounding content
  const smartRecruiterRe = /href="(https?:\/\/jobs\.smartrecruiters\.com\/SwissMedicalNetwork[^"]*?)"/gi;
  const links = [];
  let linkMatch;
  while ((linkMatch = smartRecruiterRe.exec(html)) !== null) {
    links.push({ url: linkMatch[1], index: linkMatch.index });
  }

  // For each SR link, extract the surrounding job card context
  for (const link of links) {
    // Look backwards and forwards for the enclosing card/section
    const searchStart = Math.max(0, link.index - 2000);
    const searchEnd = Math.min(html.length, link.index + 2000);
    const context = html.slice(searchStart, searchEnd);

    // Extract title from headings or link text near the SR link
    const titleMatch = context.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i)
      || context.match(/<a[^>]*href="[^"]*smartrecruiters[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? normalizeSpace(htmlToText(titleMatch[1])) : '';
    if (!title || title.length < 3) continue;

    // Extract clinic name
    const clinicText = normalizeSpace(htmlToText(context));
    let clinic = '';
    for (const c of TICINO_CLINICS) {
      if (clinicText.toLowerCase().includes(c.name.toLowerCase())) {
        clinic = c.name;
        break;
      }
    }

    // Check if this is a Ticino position
    if (!isTicinoLocation(clinicText) && !isTicinoLocation(title)) continue;

    const city = inferCity(clinicText || title);

    // Extract employment rate (e.g., "100%", "80-100%")
    const rateMatch = clinicText.match(/(\d{1,3}(?:\s*-\s*\d{1,3})?\s*%)/);
    const employmentRate = rateMatch ? rateMatch[1] : '';

    // Extract start date
    const startMatch = clinicText.match(/(?:da\s+subito|ab\s+sofort|immediate|per\s+data|start[:\s]+[^.]+)/i);
    const startDate = startMatch ? normalizeSpace(startMatch[0]) : '';

    idx++;
    jobs.push({
      title,
      clinic: clinic || 'Swiss Medical Network',
      city,
      employmentRate,
      startDate,
      applyUrl: link.url,
      idx,
    });
  }

  // Deduplicate by URL
  const seen = new Set();
  return jobs.filter((j) => {
    if (seen.has(j.applyUrl)) return false;
    seen.add(j.applyUrl);
    return true;
  });
}

/**
 * Parse job listing links from Swiss Medical Network HTML.
 * These are the SmartRecruiters application URLs.
 *
 * @param {string} html - Raw HTML
 * @returns {string[]} Array of SmartRecruiters URLs
 */
export function parseSmartRecruiterLinks(html = '') {
  if (!html) return [];
  const re = /href="(https?:\/\/jobs\.smartrecruiters\.com\/SwissMedicalNetwork[^"]*?)"/gi;
  const urls = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Map clinic names to postal codes and addresses.
 */
export const CLINIC_ADDRESSES = {
  'Clinica Sant\'Anna': { postalCode: '6924', streetAddress: 'Via Sant\'Anna 1, 6924 Sorengo', city: 'Sorengo' },
  'Clinica Ars Medica': { postalCode: '6929', streetAddress: 'Via Cantonale 26, 6929 Gravesano', city: 'Gravesano' },
  'Clinica Moncucco': { postalCode: '6900', streetAddress: 'Via Moncucco 2, 6900 Lugano', city: 'Lugano' },
  'Sana Cure Sagl': { postalCode: '6900', streetAddress: 'Via Moncucco 2, 6900 Lugano', city: 'Lugano' },
  'Centro Medico Blenio': { postalCode: '6716', streetAddress: 'Via Campagna 6, 6716 Acquarossa', city: 'Acquarossa' },
  'Genolier Management & Services': { postalCode: '6830', streetAddress: 'Via Besso 23, 6830 Chiasso', city: 'Chiasso' },
};

/**
 * Get address data for a clinic name.
 */
export function getClinicAddress(clinicName = '', city = '') {
  for (const [name, data] of Object.entries(CLINIC_ADDRESSES)) {
    if (clinicName.toLowerCase().includes(name.toLowerCase())) return data;
  }
  // Try matching by city
  for (const data of Object.values(CLINIC_ADDRESSES)) {
    if (city && data.city.toLowerCase() === city.toLowerCase()) return data;
  }
  // Default to Lugano HQ
  return { postalCode: '6900', streetAddress: 'Via Moncucco 2, 6900 Lugano', city: 'Lugano' };
}

/**
 * Parse a SmartRecruiters detail page for full job description.
 *
 * SmartRecruiters pages typically have:
 *   - <h1> with job title
 *   - Job description in a section with rich text (responsibilities, requirements, etc.)
 *   - Location info in structured data or meta
 *
 * @param {string} html - Raw HTML of the SmartRecruiters detail page
 * @returns {{ title: string, description: string, location: string }}
 */
export function parseSmartRecruiterDetail(html = '') {
  if (!html || typeof html !== 'string') return { title: '', description: '', location: '' };

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(htmlToText(titleMatch[1])) : '';

  // Strategy 1: Look for the job description content section
  let contentHtml = '';
  // SmartRecruiters typically has a .job-description or [data-automation="jobDescription"] section
  const descSectionMatch = html.match(/<div[^>]*(?:class="[^"]*job-?desc[^"]*"|data-automation="jobDescription")[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<section[^>]*class="[^"]*(?:description|content)[^"]*"[^>]*>([\s\S]*?)<\/section>/i);

  if (descSectionMatch) {
    contentHtml = descSectionMatch[1];
  } else {
    // Strategy 2: Get main/article content
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
      || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (mainMatch) contentHtml = mainMatch[1];
    else {
      // Strategy 3: Get body content minus nav/header/footer
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) contentHtml = bodyMatch[1];
    }
  }

  // Clean up
  contentHtml = contentHtml
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  const description = normalizeSpace(htmlToText(contentHtml));

  // Try to extract location from structured data or meta
  const locMatch = html.match(/"jobLocation"[^}]*"addressLocality"\s*:\s*"([^"]+)"/i)
    || html.match(/<meta[^>]*name="geo\.placename"[^>]*content="([^"]+)"/i);
  const location = locMatch ? normalizeSpace(locMatch[1]) : '';

  return { title, description, location };
}
