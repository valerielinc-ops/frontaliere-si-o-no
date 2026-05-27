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
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
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
    .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(?:p|div|li)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
    );
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

export function parseSkyguideListings(html = '') {
  const document = new JSDOM(html).window.document;
  return [...document.querySelectorAll('#searchresults tr.data-row')]
    .map((row) => {
      const link = row.querySelector('a.jobTitle-link');
      return {
        href: String(link?.getAttribute('href') || '').trim(),
        title: normalizeSpace(link?.textContent || ''),
        location: normalizeSpace(row.querySelector('.colLocation .jobLocation, .jobdetail-phone .jobLocation')?.textContent || ''),
        department: normalizeSpace(row.querySelector('.colDepartment .jobDepartment, .jobdetail-phone .jobFacility')?.textContent || ''),
      };
    })
    .filter((row) => row.href && row.title);
}

export function isSkyguideTargetLocation(raw = '') {
  return isTargetSwissLocation(raw, { includeGrigioni: true });
}

export function inferSkyguideCanton(raw = '') {
  return inferAnyCanton(raw) || 'TI';
}

export function parseSkyguideJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  const title = normalizeSpace(document.querySelector('[itemprop="title"]')?.textContent || '');
  const location = normalizeSpace(document.querySelector('[itemprop="streetAddress"]')?.getAttribute('content') || '');
  const datePostedRaw = normalizeSpace(document.querySelector('[itemprop="datePosted"]')?.getAttribute('content') || '');
  const applyPath = normalizeSpace(document.querySelector('a.apply.dialogApplyBtn')?.getAttribute('href') || '');
  const intro = htmlFragmentToMarkdown(document.querySelector('.customPlugin .inner')?.innerHTML || '');
  const descriptionHtml = document.querySelector('span.jobdescription')?.innerHTML || '';
  let description = htmlFragmentToMarkdown(descriptionHtml);
  description = description
    .replace(/\bDescrizione:\s*/i, '## Descrizione\n\n')
    .replace(/\bRequisiti:\s*/i, '\n\n## Requisiti\n\n')
    .replace(/\bLuogo di lavoro:\s*/i, '\n\n## Luogo di lavoro\n\n')
    .replace(/\bGrado di occupazione:\s*/i, '\n\n## Grado di occupazione\n\n')
    .replace(/\bInizio della formazione:\s*/i, '\n\n## Inizio della formazione\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const fullDescription = [intro, description].filter(Boolean).join('\n\n');
  return {
    title,
    location,
    datePostedRaw,
    applyPath,
    intro,
    description: fullDescription,
  };
}

export function buildSkyguideLocalizedContent(detail = {}, companyName = 'Skyguide') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Ticino';
  const description = String(detail.description || '').trim();
  return {
    titleByLocale: {
      it: title,
    },
    descriptionByLocale: {
      it: description,
    },
    slugByLocale: {
      it: slugify(`${title} ${companyName} ${location}`),
    },
  };
}
