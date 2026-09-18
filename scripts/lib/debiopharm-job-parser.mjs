import { JSDOM } from 'jsdom';
import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';
import { coerceCountryField, isChCountry } from './ch-country-guard.mjs';

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
  if (/\bintern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])/.test(normalized)) return 'internship';
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
 * A zero-result careers page is authoritative only when the source itself
 * renders its explicit empty-state marker and no Workable job link. A blank
 * parser result without that evidence is a source/parser failure, not a
 * valid empty snapshot.
 */
export function isVerifiedEmptyDebiopharmCareersSource(html = '') {
  const source = String(html || '');
  const hasWorkableJobLink = /apply\.workable\.com\/debiopharm\/j\/[A-Z0-9]+/i.test(source);
  const hasEmptyState = /u-section-open-position-list__list-no-result|There are currently no positions matching your criteria\./i.test(source);
  return !hasWorkableJobLink && hasEmptyState;
}

function locationCandidateList(detail = {}) {
  const candidates = [];
  if (detail?.location && typeof detail.location === 'object') candidates.push(detail.location);
  if (Array.isArray(detail?.locations)) candidates.push(...detail.locations.filter((loc) => loc && typeof loc === 'object'));
  return candidates;
}

function candidateLocationText(candidate = {}, fallbackLocation = '') {
  const city = String(candidate?.city || '').trim();
  const region = String(candidate?.region || '').trim();
  const sourceText = [city, region].filter(Boolean).join(', ');
  if (sourceText) return sourceText;
  return String(fallbackLocation || '').trim();
}

function fallbackLocationParts(fallbackLocation = '') {
  const parts = String(fallbackLocation || '')
    .split(',')
    .map((part) => normalizeSpace(part))
    .filter(Boolean);
  return { city: parts[0] || '', region: parts[1] || '' };
}

function hasConcreteSwissSourceLocation(candidate = {}, fallbackLocation = '') {
  const country = candidate?.countryCode ?? candidate?.country ?? '';
  const locationText = candidateLocationText(candidate, fallbackLocation);
  return isChCountry(country)
    && Boolean(locationText)
    && isTargetSwissLocation(locationText, { includeBorderProximity: false });
}

/**
 * Filter for source-backed Swiss jobs across all 26 cantons. The Workable
 * country field is necessary but not sufficient: a CH country code paired
 * with a foreign or unknown city must not inherit a Swiss HQ location.
 *
 * A country code alone is not a source-backed workplace. Every caller uses
 * the same concrete-locality predicate so a country-only response cannot
 * enter the authoritative job snapshot or derive a canton/address.
 */
export function isDebiopharmSwissJob(
  detail = {},
  fallbackLocation = '',
) {
  return locationCandidateList(detail).some((candidate) =>
    hasConcreteSwissSourceLocation(candidate, fallbackLocation));
}

/**
 * Classifies the source evidence before the crawler decides whether to skip
 * or fail closed. A non-CH country on every location candidate is explicit
 * foreign evidence; an absent/ambiguous locality remains unresolved.
 */
export function classifyDebiopharmSourceLocation(detail = {}, fallbackLocation = '') {
  const candidates = locationCandidateList(detail);
  if (candidates.some((candidate) => hasConcreteSwissSourceLocation(candidate, fallbackLocation))) {
    return 'swiss';
  }
  if (candidates.length > 0 && candidates.every((candidate) => {
    const country = coerceCountryField(candidate?.countryCode ?? candidate?.country);
    return Boolean(country) && !isChCountry(country);
  })) {
    return 'foreign';
  }
  return 'unresolved';
}

export function parseDebiopharmJobDetailPayload(detail = {}, fallbackLocation = '') {
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

  const candidates = locationCandidateList(detail);
  const selected = candidates.find((candidate) => hasConcreteSwissSourceLocation(candidate, fallbackLocation)) || {};
  const fallback = fallbackLocationParts(fallbackLocation);
  const city = String(selected.city || '').trim() || fallback.city;
  const region = String(selected.region || '').trim() || fallback.region;
  const country = selected.countryCode ?? selected.country ?? '';
  const countryCode = isChCountry(country) ? 'CH' : String(country || '').toUpperCase();
  const locationText = [city, region].filter(Boolean).join(', ');
  const inferredCanton = isTargetSwissLocation(locationText, { includeBorderProximity: false })
    ? inferAnyCanton(locationText)
    : '';
  const address = selected?.address && typeof selected.address === 'object' ? selected.address : {};
  const postalCode = String(selected.postalCode || selected.zipCode || address.postalCode || '').trim();
  const streetAddress = String(selected.streetAddress || selected.street || address.streetAddress || '').trim();

  return {
    title: String(detail.title || '').trim(),
    shortcode: String(detail.shortcode || '').trim(),
    city,
    region,
    countryCode,
    postalCode,
    streetAddress,
    description: parts.join('\n\n').trim(),
    requirements,
    benefits,
    department: Array.isArray(detail.department) ? detail.department.filter(Boolean) : [],
    employmentType: normalizeDebiopharmEmploymentType(detail.type || ''),
    sourceLanguage: String(detail.language || 'en').trim() || 'en',
    publishedDate: String(detail.published || '').trim(),
    inferredCanton: inferredCanton || null,
  };
}
