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

  for (const node of [...body.children]) {
    const tag = node.tagName?.toLowerCase() || '';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
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
    const text = normalizeSpace(
      (node.innerHTML || '')
        .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(?:p|div|li)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
    );
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

export function parseZucchettiListings(html = '') {
  const document = new JSDOM(html).window.document;
  return [...document.querySelectorAll('a.item-job-list')]
    .map((anchor) => {
      const infos = [...anchor.querySelectorAll('.info-job span')].map((node) => normalizeSpace(node.textContent || ''));
      return {
        href: String(anchor.getAttribute('href') || '').trim(),
        title: normalizeSpace(anchor.querySelector('.name-job')?.textContent || ''),
        teaser: normalizeSpace(anchor.querySelector('.description-job')?.textContent || ''),
        location: infos[0] || '',
        category: infos[1] || '',
      };
    })
    .filter((row) => row.href && row.title);
}

export function isZucchettiTargetLocation(raw = '') {
  return isTargetSwissLocation(raw, { includeGrigioni: true });
}

export function inferZucchettiCanton(raw = '') {
  return inferAnyCanton(raw) || 'TI';
}

export function parseZucchettiJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  const title = normalizeSpace(document.querySelector('#description__vacancy-title')?.textContent || '');
  const subtitleInfos = [...document.querySelectorAll('#description__subtitle .subtitle__informations')].map((node) =>
    normalizeSpace(node.textContent || '')
  );
  const location = subtitleInfos[0] || '';
  const category = subtitleInfos[1] || '';

  const sections = [];
  const headings = [...document.querySelectorAll('#description__body .body__headings')];
  for (const heading of headings) {
    const next = heading.nextElementSibling;
    if (!next || !next.classList.contains('body__text')) continue;
    const sectionTitle = normalizeSpace(heading.textContent || '');
    const sectionBody = htmlFragmentToMarkdown(next.innerHTML || '');
    if (!sectionBody) continue;
    sections.push(`## ${sectionTitle}\n\n${sectionBody}`);
  }

  const shareUrl = normalizeSpace(document.querySelector('.share__hidden')?.textContent || '');
  return {
    title,
    location,
    category,
    shareUrl,
    description: sections.join('\n\n').trim(),
  };
}

export function buildZucchettiLocalizedContent(detail = {}, companyName = 'Zucchetti Switzerland SA') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Mendrisio';
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
