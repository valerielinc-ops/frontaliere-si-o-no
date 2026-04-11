import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('ksgr');

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeDate(raw = '') {
  const parsed = new Date(String(raw || '').trim());
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function pickLocation(job = {}) {
  const attrLocations = Array.isArray(job?.attributes?.['40']) ? job.attributes['40'] : [];
  const firstAttrLocation = attrLocations
    .map((value) => normalizeSpace(value))
    .find((value) => value && !/home office/i.test(value));
  if (firstAttrLocation) return firstAttrLocation;

  const rawAddress = String(job?.szas?.['sza_location.city'] || '').trim();
  if (!rawAddress) return '';
  const lines = rawAddress
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean);
  const postalCityLine = [...lines].reverse().find((line) => /\b\d{4}\s+/.test(line));
  if (postalCityLine) {
    return normalizeSpace(postalCityLine.replace(/^.*\b\d{4}\s+/, ''));
  }
  return lines[lines.length - 1] || '';
}

function pickPensum(job = {}) {
  const explicit = normalizeSpace(job?.szas?.sza_pensum || '');
  if (explicit) return explicit;
  const min = normalizeSpace(job?.szas?.['sza_pensum.min'] || job?.attributes?.['50']?.[0] || '');
  const max = normalizeSpace(job?.szas?.['sza_pensum.max'] || job?.attributes?.['60']?.[0] || '');
  if (min && max) return `${min} - ${max}%`;
  if (min) return `${min}%`;
  return '';
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildDescription(job = {}) {
  const szas = job?.szas || {};
  const parts = [];
  const intro = normalizeSpace(szas.sza_introduction || '');
  if (intro) parts.push(intro);
  const tasks = stripHtml(szas.sza_tasks || '');
  if (tasks) parts.push('Aufgaben:\n' + tasks);
  const reqs = stripHtml(szas.sza_requirements || '');
  if (reqs) parts.push('Anforderungen:\n' + reqs);
  const profile = stripHtml(szas.sza_company_profil || '');
  if (profile) parts.push(profile);
  return parts.join('\n\n');
}

function parseWorkplace(raw = '') {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const postalLine = lines.find((l) => /CH-\d{4}/.test(l));
  const postalMatch = postalLine?.match(/CH-(\d{4})\s+(.*)/);
  return {
    streetAddress: lines.find((l) => /strasse|weg|gasse|platz/i.test(l)) || '',
    postalCode: postalMatch ? postalMatch[1] : '',
    city: postalMatch ? postalMatch[2] : '',
  };
}

export function parseKsgrApiJob(job = {}) {
  const detailUrl = normalizeSpace(job?.links?.directlink || '');
  if (!detailUrl) return null;

  const szas = job?.szas || {};
  const workplace = parseWorkplace(szas.sza_workplace || '');

  return {
    id: normalizeSpace(job?.id || job?.viewkey || ''),
    title: decodeHtml(normalizeSpace(szas.sza_title || job?.title || '')),
    detailUrl,
    applyUrl: normalizeSpace(szas.sza_apply_link || ''),
    location: pickLocation(job),
    canton: HQ.canton,
    postedDate: normalizeDate(job?.start_date || job?.last_modification_timestamp || ''),
    employmentType: pickPensum(job),
    description: buildDescription(job),
    industry: normalizeSpace(szas.sza_industry || ''),
    streetAddress: workplace.streetAddress,
    postalCode: workplace.postalCode,
    region: normalizeSpace(szas['sza_location.region'] || ''),
    country: normalizeSpace(szas['sza_location.country'] || 'Schweiz'),
  };
}

export function parseKsgrJobsPage(payload = {}) {
  const jobs = Array.isArray(payload?.jobs)
    ? payload.jobs.map((job) => parseKsgrApiJob(job)).filter(Boolean)
    : [];
  const total = Number(payload?.total);
  return {
    total: Number.isFinite(total) ? total : jobs.length,
    jobs,
  };
}
