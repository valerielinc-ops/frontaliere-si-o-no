import { JSDOM } from 'jsdom';
import {  isTargetSwissLocation, inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('damiani');

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

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
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isDamianiTicinoLocation(rawLocation = '') {
  return isTargetSwissLocation(rawLocation);
}

/** Infer canton (TI or GR) from location text. Falls back to HQ canton. */
export function inferDamianiCanton(rawLocation = '') {
  return inferAnyCanton(rawLocation) || HQ.canton;
}

export function localizeDamianiTitle(rawTitle = '', locale = 'it') {
  const title = String(rawTitle || '').trim();
  if (!title) return '';
  if (locale === 'it') {
    if (/^Treasury Specialist$/i.test(title)) return 'Specialista Tesoreria';
    if (/^Customer Service Specialist - Arabic or Russian Speaking$/i.test(title)) {
      return 'Specialista Customer Service - lingua araba o russa';
    }
    return title;
  }
  if (locale === 'de') {
    if (/^Treasury Specialist$/i.test(title)) return 'Treasury Specialist';
    if (/^Customer Service Specialist - Arabic or Russian Speaking$/i.test(title)) {
      return 'Customer Service Specialist - Arabisch oder Russisch';
    }
  }
  if (locale === 'fr') {
    if (/^Treasury Specialist$/i.test(title)) return 'Spécialiste Trésorerie';
    if (/^Customer Service Specialist - Arabic or Russian Speaking$/i.test(title)) {
      return 'Spécialiste service client - arabe ou russe';
    }
  }
  return title;
}

export function inferDamianiCategory(title = '', description = '') {
  const haystack = normalize(`${title} ${description}`);
  if (haystack.includes('treasury') || haystack.includes('tesoreria')) return 'finance';
  if (haystack.includes('customer service') || haystack.includes('after-sales')) return 'sales';
  return 'other';
}

export function parseDamianiSearchPage(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const rows = [...document.querySelectorAll('tr.data-row')];
  return rows.map((row) => {
    const link = row.querySelector('a.jobTitle-link');
    const title = normalizeSpace(link?.textContent || '');
    const href = link?.getAttribute('href') || '';
    const location = normalizeSpace(row.querySelector('td.colLocation .jobLocation')?.textContent || '');
    const postedDate = normalizeSpace(row.querySelector('td.colDate .jobDate')?.textContent || '');
    return { title, href, location, postedDate };
  }).filter((row) => row.title && row.href && row.location);
}

function bulletize(section) {
  const items = [...section.querySelectorAll('li')]
    .map((item) => normalizeSpace(item.textContent || ''))
    .filter(Boolean);
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '';
}

export function parseDamianiJobDetail(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const title = normalizeSpace(document.querySelector('span[itemprop="title"]')?.textContent || '');
  const location = normalizeSpace(document.querySelector('#job-location .jobGeoLocation')?.textContent || '');
  const postedDate = String(document.querySelector('meta[itemprop="datePosted"]')?.getAttribute('content') || '').trim();
  const validThrough = String(document.querySelector('meta[itemprop="validThrough"]')?.getAttribute('content') || '').trim();
  const applyHref = String(document.querySelector('a.apply.dialogApplyBtn')?.getAttribute('href') || '').trim();
  const body = document.querySelector('.jobdescription');
  const sections = [];
  if (body) {
    let currentHeading = '';
    let currentBlocks = [];
    const flush = () => {
      if (!currentHeading && currentBlocks.length === 0) return;
      const block = [];
      if (currentHeading) block.push(`## ${currentHeading}`);
      if (currentBlocks.length > 0) block.push(currentBlocks.join('\n\n'));
      sections.push(block.join('\n\n').trim());
      currentHeading = '';
      currentBlocks = [];
    };

    for (const node of [...body.children]) {
      const tag = node.tagName?.toLowerCase() || '';
      if (tag === 'h3' || tag === 'h2') {
        flush();
        currentHeading = normalizeSpace(node.textContent || '');
        continue;
      }
      if (tag === 'hr') {
        flush();
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        const bullets = bulletize(node);
        if (bullets) currentBlocks.push(bullets);
        continue;
      }
      const prose = normalizeSpace(htmlToText(node.outerHTML || node.textContent || ''));
      if (prose) currentBlocks.push(prose);
    }
    flush();
  }

  const description = sections.join('\n\n').trim();
  return {
    title,
    location,
    postedDate,
    validThrough,
    applyHref,
    description,
  };
}

export function buildDamianiLocalizedContent(detail = {}) {
  const sourceTitle = String(detail.title || '').trim();
  const location = String(detail.location || '').trim();
  const itTitle = localizeDamianiTitle(sourceTitle, 'it');
  const titles = {
    it: itTitle,
    en: sourceTitle,
    de: localizeDamianiTitle(sourceTitle, 'de'),
    fr: localizeDamianiTitle(sourceTitle, 'fr'),
  };
  return {
    titleByLocale: titles,
    slugByLocale: {
      it: slugify(`${titles.it} Damiani Group ${location}`),
      en: slugify(`${titles.en} Damiani Group ${location}`),
      de: slugify(`${titles.de} Damiani Group ${location}`),
      fr: slugify(`${titles.fr} Damiani Group ${location}`),
    },
    descriptionByLocale: {
      it: detail.description || '',
    },
  };
}
