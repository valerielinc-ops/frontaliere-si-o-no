import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';
import { isChCountry } from './ch-country-guard.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

export const GUESS_WORKABLE_ACCOUNT_ID = '452934';
export const GUESS_WORKABLE_ACCOUNT_SLUG = 'guess-europe-sagl';

// HQ fallback — Bioggio, canton TI. Kept local (mirrors komax-group-job-parser.mjs's
// convention) so the canton resolvers below don't need it threaded in as a param.
const HQ = getCompanyDefaults('guess-europe') || { city: 'Bioggio', canton: 'TI', postalCode: '6934', addressRegion: 'TI' };

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
    .replace(/\u00a0/g, ' ');
}

export function parseGuessWidgetJsonp(jsonp = '') {
  const clean = String(jsonp || '').trim();
  const match = clean.match(/^(?:\/\*\*\/)?whrcallback\(([\s\S]*)\)\s*;?$/);
  if (!match) {
    throw new Error('Invalid Guess Workable widget JSONP payload');
  }
  return JSON.parse(match[1]);
}

export function isGuessTicinoWidgetJob(job = {}) {
  const signal = [job.city, job.state, job.department, job.country].filter(Boolean).join(' ');
  // Recognise CH across alias formats (CH / CHE / 756 / object) instead of a
  // strict `=== 'switzerland'`, which dropped valid CH rows (#2419, shared guard).
  return (
    isChCountry(job.country) &&
    Boolean(inferSwissTargetCanton(signal) || isTargetSwissLocation(signal))
  );
}

/**
 * Resolve the canton for a job, or signal (via null) that it should be
 * skipped.
 *
 * isGuessTicinoWidgetJob() actually admits ANY TARGET_CANTON job (via
 * inferSwissTargetCanton()/isTargetSwissLocation() over the combined
 * city+state+department+country signal), not just Ticino, despite this
 * crawler's Ticino-only docstring/intent — so a real, non-empty city text
 * that itself fails to resolve to a canton must never fabricate the
 * Bioggio HQ canton (TI) for a job that isn't verifiably there (AGENTS.md
 * Non-Negotiable #3, mirrors clariant/swisslog/debiopharm/komax/lindt-
 * spruengli). Only default to HQ.canton when there's no real city text at
 * all.
 */
export function resolveGuessCanton(city = '') {
  const cityText = String(city || '').trim();
  const inferredCanton = inferAnyCanton(cityText);
  if (inferredCanton) return inferredCanton;
  if (cityText) return null;
  return HQ.canton;
}

/**
 * Pure canton-backfill decision for update-guess-jobs.mjs's postProcessJobs()
 * (#3480, mirrors resolveDebiopharmBackfillCanton in
 * update-debiopharm-jobs.mjs). An already-published job is never dropped
 * here (AGENTS.md "never cut live pages without OK") — a real but
 * unresolvable location text only earns a `needsCantonReview` flag for
 * editorial triage; the safe-default canton itself is always still
 * written (Non-Negotiable #3).
 */
export function resolveGuessBackfillCanton(locationText = '') {
  const text = String(locationText || '').trim();
  const inferredCanton = inferAnyCanton(text);
  return {
    canton: inferredCanton || HQ.canton,
    needsCantonReview: Boolean(text && !inferredCanton),
  };
}

export function buildGuessDetailUrl(shortcode = '') {
  const code = String(shortcode || '').trim();
  if (!code) return '';
  return `https://apply.workable.com/${GUESS_WORKABLE_ACCOUNT_SLUG}/j/${code}/`;
}

export function buildGuessApplyUrl(shortcode = '') {
  const code = String(shortcode || '').trim();
  if (!code) return '';
  return `https://apply.workable.com/${GUESS_WORKABLE_ACCOUNT_SLUG}/j/${code}/apply/`;
}

export function normalizeGuessEmploymentType(value = '') {
  const normalized = normalize(value);
  if (normalized.includes('part')) return 'part-time';
  if (normalized.includes('temporary') || normalized.includes('fixed') || normalized.includes('contract')) return 'temporary';
  if (normalized.includes('intern')) return 'internship';
  return 'full-time';
}

export function stripGuessHtml(html = '') {
  return decodeHtml(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(?:p|li|div|h[1-6]|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
  ).trim();
}

export function parseGuessBullets(html = '') {
  const items = [];
  const source = String(html || '');
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match = null;
  while ((match = re.exec(source)) !== null) {
    const text = stripGuessHtml(match[1]);
    if (text.length >= 5) items.push(text);
  }
  return [...new Set(items)];
}

function htmlToParagraphs(html = '') {
  const dom = new JSDOM(`<body>${html || ''}</body>`);
  const paragraphs = [];
  for (const node of dom.window.document.body.querySelectorAll('p')) {
    const text = normalizeSpace(stripGuessHtml(node.innerHTML));
    if (text && text !== '&') paragraphs.push(text);
  }
  return [...new Set(paragraphs)];
}

export function parseGuessJobDetailPayload(detail = {}) {
  const descriptionParagraphs = htmlToParagraphs(detail.description || '');
  const requirements = parseGuessBullets(detail.requirements || '');
  const benefits = parseGuessBullets(detail.benefits || '');

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

  return {
    title: String(detail.title || '').trim(),
    locationDisplay: String(detail?.location?.display || '').trim(),
    city: String(detail?.location?.city || '').trim(),
    region: String(detail?.location?.region || '').trim(),
    countryCode: String(detail?.location?.countryCode || 'CH').trim() || 'CH',
    description: parts.join('\n\n').trim(),
    requirements,
    benefits,
    department: Array.isArray(detail.department) ? detail.department.filter(Boolean) : [],
    employmentType: normalizeGuessEmploymentType(detail.type || ''),
    sourceLanguage: String(detail.language || 'en').trim() || 'en',
    publishedDate: String(detail.published || '').trim(),
  };
}
