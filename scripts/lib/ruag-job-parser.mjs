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
    const tag = node.nodeName?.toLowerCase?.() || '';
    if (tag === '#text') {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(text);
      continue;
    }
    if (!tag) continue;
    if (/^h[1-4]$/.test(tag)) {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(`## ${text.replace(/:$/, '')}`);
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
        .replace(/<\/(?:p|div|li)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#39;/g, '\'')
        .replace(/&amp;/g, '&')
      );
    if (text) parts.push(text);
  }

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readJobPosting(document) {
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')]) {
    const raw = normalizeSpace(script.textContent || '');
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.['@type'] === 'JobPosting') return parsed;
    } catch {
      // ignore invalid JSON
    }
  }
  return null;
}

function extractLocationFromInlineScript(html = '') {
  const match = html.match(/\#location \.placeList'\)\.html\('([^']+)'/i);
  return normalizeSpace(match?.[1] || '');
}

function extractTextByHeading(document, headingText) {
  const headings = [...document.querySelectorAll('h2, h3')];
  const heading = headings.find((node) => normalizeSpace(node.textContent || '').toLowerCase() === headingText.toLowerCase());
  if (!heading) return '';
  const wrapper = heading.closest('.contentTextWrapper, .jobInfoList, .benefitIntroduction, .sectionWrapper, .sectionBackgroundCorner');
  if (!wrapper) return '';
  return htmlFragmentToMarkdown(wrapper.innerHTML || '');
}

function extractSimilarLinks(html = '') {
  return [...html.matchAll(/id="otherJob-\d+"\s+href="([^"]+)"/g)]
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
}

function normalizeRuagLocation(raw = '') {
  const value = normalizeSpace(raw);
  if (!value) return '';
  if (/lugano agno/i.test(value)) return 'Lugano Agno';
  return value;
}

export function parseRuagListingLinks(html = '') {
  return [...html.matchAll(/https:\/\/jobs\.ruag\.ch\/(?:offene-stellen|open-vacancies|posizioni-aperte)\/[^"'<\s]+/g)]
    .map((match) => String(match[0] || '').trim())
    .filter(Boolean);
}

export function parseRuagJobDetail(html = '', url = '') {
  const document = new JSDOM(html).window.document;
  const jobPosting = readJobPosting(document);
  const title =
    normalizeSpace(document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '') ||
    normalizeSpace(document.querySelector('title')?.textContent || '') ||
    normalizeSpace(jobPosting?.title || '');
  const location =
    normalizeRuagLocation(extractLocationFromInlineScript(html)) ||
    normalizeRuagLocation(jobPosting?.jobLocation?.address?.addressLocality || '') ||
    normalizeRuagLocation(document.querySelector('#location .placeList')?.textContent || '');
  const canonicalUrl = String(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || url).trim();
  const applyUrl = String(document.querySelector('a[href*="/apply/ats/"]')?.getAttribute('href') || '').trim();
  const company =
    normalizeSpace(jobPosting?.hiringOrganization?.name || '') ||
    normalizeSpace(document.querySelector('meta[name="author"]')?.getAttribute('content') || '') ||
    'RUAG AG';
  const summary = extractTextByHeading(document, 'Il tuo ambito di lavoro')
    || extractTextByHeading(document, 'Dein Aufgabenbereich')
    || '';
  const responsibilities = htmlFragmentToMarkdown(jobPosting?.responsibilities || '');
  const qualifications = htmlFragmentToMarkdown(jobPosting?.qualifications || '');
  const benefits = extractTextByHeading(document, 'I tuoi vantaggi')
    || extractTextByHeading(document, 'Deine Vorteile')
    || '';
  const process = extractTextByHeading(document, 'Ecco come funziona il nostro processo di candidatura')
    || extractTextByHeading(document, 'So funktioniert unser Bewerbungsprozess')
    || '';
  const contactName = normalizeSpace(document.querySelector('.contactInfoName')?.textContent || '');
  const contactRole = normalizeSpace(document.querySelector('.contactInfoText p')?.textContent || '');
  const contactPhone = normalizeSpace(document.querySelector('.contactInfoText a[href^="tel:"]')?.textContent || '');
  const sections = [];
  if (summary) sections.push(`## Ambito di lavoro\n\n${summary}`);
  if (responsibilities) sections.push(`## Responsabilita\n\n${responsibilities}`);
  if (qualifications) sections.push(`## Requisiti\n\n${qualifications}`);
  if (benefits) sections.push(`## Vantaggi\n\n${benefits}`);
  if (process) sections.push(`## Processo di candidatura\n\n${process}`);
  if (contactName || contactRole || contactPhone) {
    sections.push(
      `## Contatto\n\n${[contactName, contactRole, contactPhone].filter(Boolean).join('\n')}`
    );
  }

  return {
    title,
    canonicalUrl,
    applyUrl,
    company,
    location,
    canton: inferAnyCanton(location),
    description: sections.join('\n\n').trim(),
    postedDate: normalizeSpace(jobPosting?.datePosted || ''),
    validThrough: normalizeSpace(jobPosting?.validThrough || ''),
    employmentType: normalizeSpace(jobPosting?.employmentType || ''),
    similarLinks: extractSimilarLinks(html),
  };
}

export function isRuagTargetLocation(raw = '') {
  return isTargetSwissLocation(raw, { includeGrigioni: true });
}

export function inferRuagCanton(raw = '') {
  return inferAnyCanton(raw) || 'TI';
}

export function buildRuagLocalizedContent(detail = {}, companyName = 'RUAG AG', locale = 'it') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Ticino';
  const description = String(detail.description || '').trim();
  return {
    titleByLocale: {
      [locale]: title,
    },
    descriptionByLocale: {
      [locale]: description,
    },
    slugByLocale: {
      [locale]: slugify(`${title} ${companyName} ${location}`),
    },
  };
}
