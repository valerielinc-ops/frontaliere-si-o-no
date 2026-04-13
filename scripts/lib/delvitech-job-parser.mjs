import { JSDOM } from 'jsdom';
import {  isTargetSwissLocation, inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('delvitech');

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function htmlToText(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;/g, "'")
    .replace(/&#038;/g, '&')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeSectionHeading(text = '') {
  const value = normalizeSpace(text);
  if (!value || value.length > 70) return false;
  return /^[A-Z0-9&/ +()-]+$/.test(value);
}

function inferLocation(text = '') {
  const value = normalizeSpace(text);
  if (/germany/i.test(value)) return 'Germany';
  if (/mendrisio/i.test(value)) return 'Mendrisio';
  if (/ticino|tessin/i.test(value)) return 'Mendrisio';
  if (/switzerland/i.test(value)) return 'Mendrisio';
  return '';
}

export function parseDelvitechCareerPage(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const cards = [...document.querySelectorAll('.post-content a.fusion-column-anchor[href*="legacy.delvi.tech/"]')];
  const seen = new Set();
  const jobs = [];

  for (const anchor of cards) {
    const href = String(anchor.getAttribute('href') || '').trim();
    if (!href || href.includes('/career/')) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    const card = anchor.closest('.fusion-layout-column') || anchor.parentElement?.nextElementSibling || anchor.nextElementSibling;
    const title = normalizeSpace(card?.querySelector('h5')?.textContent || '');
    if (!title) continue;
    jobs.push({ href, title });
  }

  return jobs;
}

export function parseDelvitechJobDetail(html = '', url = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const root = document.querySelector('.post-content') || document.body;
  const title = normalizeSpace(root.querySelector('h1')?.textContent || '');
  const email = String(root.querySelector('a[href^="mailto:"]')?.getAttribute('href') || '')
    .replace(/^mailto:/i, '')
    .trim();

  const mainContainer = root.querySelector('.fusion-fullwidth') || root;
  const textBlocks = [...mainContainer.querySelectorAll('.fusion-text')];
  const sections = [];
  let currentHeading = '';
  let currentBody = [];

  const flush = () => {
    if (!currentHeading && currentBody.length === 0) return;
    const block = [];
    if (currentHeading) block.push(`## ${currentHeading}`);
    if (currentBody.length) block.push(currentBody.join('\n\n'));
    sections.push(block.join('\n\n').trim());
    currentHeading = '';
    currentBody = [];
  };

  for (const block of textBlocks) {
    const h = normalizeSpace(block.querySelector('h2,h3,h4,h5,strong')?.textContent || '');
    const listItems = [...block.querySelectorAll('li')]
      .map((item) => normalizeSpace(item.textContent || ''))
      .filter(Boolean);
    const prose = normalizeSpace(htmlToText(block.innerHTML || block.textContent || ''));
    const contentWithoutHeading = prose === h ? '' : prose;

    if (looksLikeSectionHeading(h)) {
      flush();
      currentHeading = h;
      if (listItems.length) currentBody.push(listItems.map((item) => `- ${item}`).join('\n'));
      else if (contentWithoutHeading) currentBody.push(contentWithoutHeading);
      continue;
    }

    if (listItems.length) {
      currentBody.push(listItems.map((item) => `- ${item}`).join('\n'));
    } else if (contentWithoutHeading) {
      currentBody.push(contentWithoutHeading);
    }
  }
  flush();

  const description = sections.join('\n\n').trim();
  const location = inferLocation(`${title}\n${description}\n${url}`);
  return {
    title,
    location,
    description,
    email,
  };
}

export function isDelvitechTicinoJob(detail = {}) {
  const title = normalizeSpace(detail.title || '');
  const location = normalizeSpace(detail.location || '');
  const description = normalizeSpace(detail.description || '');
  const combined = `${title} ${location} ${description}`;
  if (/germany/i.test(combined)) return false;
  return isTargetSwissLocation(combined) || /switzerland/i.test(combined);
}

export function inferDelvitechCategory(title = '', description = '') {
  const haystack = normalizeSpace(`${title} ${description}`).toLowerCase();
  if (/(sales|support|back office|customer)/.test(haystack)) return 'sales';
  if (/(project manager|office manager)/.test(haystack)) return 'admin';
  if (/(engineer|developer|firmware|software|devops|test)/.test(haystack)) return 'engineering';
  return 'other';
}

export function buildDelvitechLocalizedContent(detail = {}) {
  const sourceTitle = normalizeSpace(detail.title || '');
  const sourceDesc = String(detail.description || '').trim();
  const location = detail.location || 'Mendrisio';
  const baseSlug = slugify(`${sourceTitle} Delvitech ${location}`);
  return {
    titleByLocale: {
      en: sourceTitle,
    },
    descriptionByLocale: {
      en: sourceDesc,
    },
    slugByLocale: {
      en: baseSlug,
    },
  };
}

/** Infer canton (TI or GR) from location/detail text. Falls back to HQ canton. */
export function inferDelvitechCanton(detail = {}) {
  const combined = `${detail.title || ''} ${detail.location || ''} ${detail.description || ''}`;
  return inferAnyCanton(combined) || HQ.canton;
}
