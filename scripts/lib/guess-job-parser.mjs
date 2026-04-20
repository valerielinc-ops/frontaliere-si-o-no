import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';

export const GUESS_WORKABLE_ACCOUNT_ID = '452934';
export const GUESS_WORKABLE_ACCOUNT_SLUG = 'guess-europe-sagl';

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
  const country = normalize(job.country || '');
  const signal = [job.city, job.state, job.department, job.country].filter(Boolean).join(' ');
  return (
    country === 'switzerland' &&
    Boolean(inferSwissTargetCanton(signal) || isTargetSwissLocation(signal))
  );
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
