import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
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

function htmlFragmentToMarkdown(html = '') {
  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;
  const parts = [];

  for (const node of [...body.childNodes]) {
    if (node.nodeType === 3) {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(text);
      continue;
    }
    if (!node.tagName) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') {
      parts.push('');
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(`## ${text}`);
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = [...node.querySelectorAll('li')]
        .map((li) => normalizeSpace(li.textContent || ''))
        .filter(Boolean)
        .map((text) => `- ${text}`);
      if (items.length) parts.push(items.join('\n'));
      continue;
    }
    if (tag === 'p' || tag === 'div') {
      const inner = normalizeSpace(
        (node.innerHTML || '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(?:p|div|li)>/gi, '\n')
          .replace(/<li[^>]*>/gi, '- ')
          .replace(/<[^>]+>/g, ' ')
      );
      if (inner) parts.push(inner);
      continue;
    }
    const text = normalizeSpace(node.textContent || '');
    if (text) parts.push(text);
  }

  return parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readJsonLd(document) {
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')]) {
    const raw = normalizeSpace(script.textContent || '');
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed['@type'] === 'JobPosting') return parsed;
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  }
  return null;
}

function extractTextAfterIcon(container, selector) {
  const node = container?.querySelector(selector);
  return normalizeSpace(node?.textContent || '');
}

export function parseBoardListings(html = '') {
  const document = new JSDOM(html).window.document;

  // Primary: ApplyToJob ATS listing structure (li.list-group-item)
  const atsItems = [...document.querySelectorAll('li.list-group-item')];
  if (atsItems.length) {
    return atsItems
      .map((li) => {
        const anchor = li.querySelector('h3.list-group-item-heading a');
        if (!anchor) return null;
        const title = normalizeSpace(anchor.textContent || '');
        const href = String(anchor.getAttribute('href') || '').trim();
        const locationLi = li.querySelector('ul.list-group-item-text li');
        const location = normalizeSpace(locationLi?.textContent || '');
        return { title, location, href };
      })
      .filter((row) => row && row.title && row.location && row.href);
  }

  // Fallback: board.com card layout (legacy)
  return [...document.querySelectorAll('article.card--career')]
    .map((article) => ({
      title: normalizeSpace(article.querySelector('.card-title')?.textContent || ''),
      location: normalizeSpace(article.querySelector('.location-with-pin strong')?.textContent || ''),
      href: String(article.querySelector('a.btn-link--primary')?.getAttribute('href') || '').trim(),
    }))
    .filter((row) => row.title && row.location && row.href);
}

export function isBoardTargetLocation(raw = '') {
  return isTargetSwissLocation(raw, { includeGrigioni: true });
}

export function inferBoardCanton(raw = '') {
  return inferAnyCanton(raw) || 'TI';
}

export function parseBoardJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  const jobPosting = readJsonLd(document);
  const header = document.querySelector('.job-header');
  const descriptionNode =
    document.querySelector('#job-description') ||
    document.querySelector('.job-description');
  const canonicalUrl = String(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '').trim();

  return {
    title:
      normalizeSpace(header?.querySelector('h2')?.textContent || '') ||
      normalizeSpace(document.querySelector('h2')?.textContent || '') ||
      normalizeSpace(jobPosting?.title || ''),
    location:
      extractTextAfterIcon(header, '.job-attributes-container div[title="Location"]') ||
      normalizeSpace(jobPosting?.jobLocation?.address?.addressLocality || ''),
    region: normalizeSpace(jobPosting?.jobLocation?.address?.addressRegion || ''),
    employmentType:
      extractTextAfterIcon(header, '#resumator-job-employment') ||
      normalizeSpace(jobPosting?.employmentType || ''),
    department:
      extractTextAfterIcon(header, '.job-attributes-container div[title="Department"]') || '',
    experience:
      extractTextAfterIcon(header, '#resumator-job-experience') ||
      normalizeSpace(jobPosting?.experienceRequirements || ''),
    postedDate: normalizeSpace(jobPosting?.datePosted || ''),
    validThrough: normalizeSpace(jobPosting?.validThrough || ''),
    description: htmlFragmentToMarkdown(descriptionNode?.innerHTML || ''),
    canonicalUrl,
  };
}

export function inferBoardCategory(title = '', detail = {}) {
  const haystack = normalizeSpace(`${title} ${detail.department || ''} ${detail.description || ''}`).toLowerCase();
  if (/(engineer|developer|ux|ai|product|platform|software|designer)/.test(haystack)) return 'tech';
  if (/(consultant|account manager|sales)/.test(haystack)) return 'sales';
  if (/(financial|consolidation|finance)/.test(haystack)) return 'finance';
  return 'tech';
}

export function buildBoardLocalizedContent(detail = {}, companyName = 'Board International') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Chiasso';
  return {
    titleByLocale: {
      en: title,
    },
    descriptionByLocale: {
      en: detail.description || '',
    },
    slugByLocale: {
      en: slugify(`${title} ${companyName} ${location}`),
    },
  };
}
