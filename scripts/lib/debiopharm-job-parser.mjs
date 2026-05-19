import { JSDOM } from 'jsdom';
import { inferAnyCanton } from './target-swiss-locations.mjs';

export const DEBIOPHARM_WORKABLE_ACCOUNT_SLUG = 'debiopharm';
export const DEBIOPHARM_WORKABLE_ACCOUNT_UID = '0b48274e-6ab8-4036-83b2-fc59eb412891';
export const DEBIOPHARM_CAREERS_URL = 'https://www.debiopharm.com/careers/';
export const DEBIOPHARM_WORKABLE_DETAIL_API_BASE = `https://apply.workable.com/api/v2/accounts/${DEBIOPHARM_WORKABLE_ACCOUNT_SLUG}/jobs`;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/ /g, ' ');
}

export function buildDebiopharmDetailUrl(shortcode = '') {
  const code = String(shortcode || '').trim();
  if (!code) return '';
  return `https://apply.workable.com/${DEBIOPHARM_WORKABLE_ACCOUNT_SLUG}/j/${code}/`;
}

export function buildDebiopharmApplyUrl(shortcode = '') {
  const code = String(shortcode || '').trim();
  if (!code) return '';
  return `https://apply.workable.com/${DEBIOPHARM_WORKABLE_ACCOUNT_SLUG}/j/${code}/apply/`;
}

export function normalizeDebiopharmEmploymentType(value = '') {
  const normalized = normalize(value);
  if (normalized.includes('part') || normalized.includes('contract part')) return 'part-time';
  if (normalized.includes('temporary') || normalized.includes('fixed') || normalized.includes('contract')) return 'temporary';
  if (normalized.includes('intern')) return 'internship';
  return 'full-time';
}

export function stripDebiopharmHtml(html = '') {
  return decodeHtml(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(?:p|li|div|h[1-6]|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
  ).trim();
}

export function parseDebiopharmBullets(html = '') {
  const items = [];
  const source = String(html || '');
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match = null;
  while ((match = re.exec(source)) !== null) {
    const text = stripDebiopharmHtml(match[1]);
    if (text.length >= 5) items.push(text);
  }
  return [...new Set(items)];
}

function htmlToParagraphs(html = '') {
  const dom = new JSDOM(`<body>${html || ''}</body>`);
  const paragraphs = [];
  for (const node of dom.window.document.body.querySelectorAll('p, h1, h2, h3, h4')) {
    const text = normalizeSpace(stripDebiopharmHtml(node.innerHTML));
    if (text && text !== '&') paragraphs.push(text);
  }
  return [...new Set(paragraphs)];
}

/**
 * Parses the Debiopharm careers HTML page (SSR) and returns an array of
 * { shortcode, title, locationLabel, url } entries for every job link found.
 */
export function parseDebiopharmCareersHtml(html = '') {
  const dom = new JSDOM(String(html || ''));
  const doc = dom.window.document;
  const results = new Map();
  const anchors = doc.querySelectorAll('a[href*="apply.workable.com/debiopharm/j/"]');
  for (const anchor of anchors) {
    const href = String(anchor.getAttribute('href') || '').trim();
    const match = href.match(/apply\.workable\.com\/debiopharm\/j\/([A-Z0-9]+)/i);
    if (!match) continue;
    const shortcode = match[1].toUpperCase();
    if (results.has(shortcode)) continue;
    const title = normalizeSpace(anchor.textContent || '');
    if (!title) continue;
    // Find the wrapping <li> or <article> to extract location label
    let parent = anchor;
    let label = '';
    for (let i = 0; i < 6 && parent && parent.parentElement; i += 1) {
      parent = parent.parentElement;
      const labelNode = parent.querySelector ? parent.querySelector('.label, .location, .item-open-position__meta') : null;
      if (labelNode) {
        label = normalizeSpace(labelNode.textContent || '');
        break;
      }
    }
    results.set(shortcode, {
      shortcode,
      title,
      locationLabel: label,
      url: buildDebiopharmDetailUrl(shortcode),
    });
  }
  return [...results.values()];
}

/**
 * Filter for Switzerland-located jobs (Debiopharm HQ is Lausanne, VD).
 * Listing page may include rare non-CH entries, so filter on the v2 detail
 * payload's countryCode field rather than on the listing label.
 */
export function isDebiopharmSwissJob(detail = {}) {
  const cc = String(detail?.location?.countryCode || '').toUpperCase();
  if (cc === 'CH') return true;
  // Also accept multi-locations where any locations[].countryCode is CH
  if (Array.isArray(detail?.locations)) {
    for (const loc of detail.locations) {
      if (String(loc?.countryCode || '').toUpperCase() === 'CH') return true;
    }
  }
  return false;
}

export function parseDebiopharmJobDetailPayload(detail = {}) {
  const descriptionParagraphs = htmlToParagraphs(detail.description || '');
  const requirements = parseDebiopharmBullets(detail.requirements || '');
  const benefits = parseDebiopharmBullets(detail.benefits || '');

  const parts = [];
  if (descriptionParagraphs.length > 0) {
    parts.push(descriptionParagraphs.join('\n\n'));
  }
  if (requirements.length > 0) {
    parts.push(`## Requirements\n${requirements.map((item) => `- ${item}`).join('\n')}`);
  }
  if (benefits.length > 0) {
    parts.push(`## Benefits\n${benefits.map((item) => `- ${item}`).join('\n')}`);
  }

  const city = String(detail?.location?.city || '').trim() ||
    (Array.isArray(detail?.locations) ? String(detail.locations[0]?.city || '').trim() : '');
  const region = String(detail?.location?.region || '').trim() ||
    (Array.isArray(detail?.locations) ? String(detail.locations[0]?.region || '').trim() : '');
  const countryCode = String(detail?.location?.countryCode || '').toUpperCase() ||
    (Array.isArray(detail?.locations) ? String(detail.locations[0]?.countryCode || '').toUpperCase() : 'CH');

  return {
    title: String(detail.title || '').trim(),
    shortcode: String(detail.shortcode || '').trim(),
    city: city || 'Lausanne',
    region: region || 'Vaud',
    countryCode: countryCode || 'CH',
    description: parts.join('\n\n').trim(),
    requirements,
    benefits,
    department: Array.isArray(detail.department) ? detail.department.filter(Boolean) : [],
    employmentType: normalizeDebiopharmEmploymentType(detail.type || ''),
    sourceLanguage: String(detail.language || 'en').trim() || 'en',
    publishedDate: String(detail.published || '').trim(),
    inferredCanton: inferAnyCanton(`${city} ${region}`) || 'VD',
  };
}
