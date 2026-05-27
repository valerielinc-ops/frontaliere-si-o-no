import { JSDOM } from 'jsdom';
import {  isTargetSwissLocation, inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

function compact(text = '') {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
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

const ALTEN_TITLE_TRANSLATIONS = {
  'full stack .net developer': {
    it: 'Sviluppatore Full Stack .NET',
    de: 'Full-Stack-.NET-Entwickler',
    fr: 'Developpeur Full Stack .NET',
  },
  'cloud engineer – google cloud platform': {
    it: 'Ingegnere Cloud - Google Cloud Platform',
    de: 'Cloud-Ingenieur - Google Cloud Platform',
    fr: 'Ingenieur Cloud - Google Cloud Platform',
  },
  'cloud engineer - google cloud platform': {
    it: 'Ingegnere Cloud - Google Cloud Platform',
    de: 'Cloud-Ingenieur - Google Cloud Platform',
    fr: 'Ingenieur Cloud - Google Cloud Platform',
  },
  'senior java developer (full-stack)': {
    it: 'Sviluppatore Java Senior (Full Stack)',
    de: 'Senior Java Entwickler (Full-Stack)',
    fr: 'Developpeur Java Senior (Full Stack)',
  },
};

export function isAltenTicinoLocation(location = '') {
  return isTargetSwissLocation(compact(location));
}

export function inferAltenCategory(title = '', description = '') {
  const haystack = `${compact(title)} ${compact(description)}`.toLowerCase();
  if (/(developer|engineer|cloud|java|\.net|software|devops|full stack|full-stack)/i.test(haystack)) return 'engineering';
  if (/(business analyst|program manager|project manager|test manager|test engineer|crm)/i.test(haystack)) return 'it';
  return 'other';
}

export function parseAltenListingHtml(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  return Array.from(document.querySelectorAll('.wp-block-webfactory-card .card-inner.offer-item'))
    .map((card) => {
      const anchor = card.querySelector('a.card-title[href*="/jobs/"]');
      const title = compact(anchor?.textContent || '');
      const href = anchor?.getAttribute('href') || '';
      const location = compact(card.querySelector('.card-location .location-list')?.textContent || '');
      const postedDate = compact(card.querySelector('.card-date .mx-2')?.textContent || '');
      return { title, href, location, postedDate };
    })
    .filter((item) => item.title && item.href && isAltenTicinoLocation(item.location));
}

export function parseAltenDetailHtml(html = '', pageUrl = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const root = document.querySelector('.wp-block-jobboard-offer') || document.querySelector('.entry-content') || document.body;
  const title = compact(document.querySelector('h1')?.textContent || document.querySelector('h2.wp-block-post-title')?.textContent || '');
  const applyUrl = document.querySelector('a[href$="/apply"]')?.getAttribute('href') || '';
  // Strip the leading "Location" label and ANY trailing prose:
  //   1. `[class*="location"]` selector (loose) sometimes matches the
  //      requirements <p> when ALTEN inlines "Location: Ticino, Switzerland."
  //      mid-paragraph (no newline before the next sentence). Without a
  //      sentence-boundary cut, the previous parser took the entire trailing
  //      paragraph as the city ("Ticino, Switzerland.Availability to work
  //      on-site is required. What we offer you…", 450 char). That broken
  //      field then leaked into addressLocality, the SEO slug, and the
  //      <title> downstream — caught 2026-04-28 on the
  //      java-software-ingegnere-alten-switzerland-… page.
  //   2. The label can be `Location:Ticino` (no space) → strip the optional
  //      colon explicitly so we don't keep a leading `:` in the value.
  //   3. Cut at the first sentence boundary (`.`, `;`, newline) so a
  //      compact city string survives even when the surrounding markup
  //      runs prose into the same node.
  const rawLocationNode = compact(
    Array.from(document.querySelectorAll('.block--inner, .wp-block-jobboard-offer-sidebar, .card-location, [class*="location"]'))
      .map((el) => compact(el.textContent || ''))
      .find((text) => /Location/i.test(text) && isTargetSwissLocation(text)) || ''
  );
  const location = rawLocationNode
    .replace(/^.*?Location\s*[:.]?\s*/i, '')
    .split(/[\n.;]/)[0]
    .trim();
  const postedDate =
    compact(
      Array.from(document.querySelectorAll('.block--inner, .card-date, [class*="date"]'))
        .map((el) => compact(el.textContent || ''))
        .find((text) => /\b\d{2}\/\d{2}\/\d{4}\b/.test(text)) || ''
    ).match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || '';

  const sections = Array.from(root.querySelectorAll('.wp-block-jobboard-offer-meta .block--inner'))
    .map((block) => ({
      titleAttr: compact(block.getAttribute('title') || ''),
      body: compact(block.textContent || ''),
    }))
    .filter((section) => section.body);

  const descriptionParts = [];
  for (const section of sections) {
    const heading = section.titleAttr
      ? section.titleAttr.charAt(0).toUpperCase() + section.titleAttr.slice(1)
      : '';
    if (heading && !new RegExp(`^${heading}\\b`, 'i').test(section.body)) {
      descriptionParts.push(`## ${heading}\n${section.body}`);
    } else {
      descriptionParts.push(section.body);
    }
  }

  const description = descriptionParts.join('\n\n').trim();
  const overrides = ALTEN_TITLE_TRANSLATIONS[compact(title).toLowerCase()] || {};
  const titleByLocale = {
    it: overrides.it || title,
    en: title,
    de: overrides.de || title,
    fr: overrides.fr || title,
  };
  const descriptionByLocale = description ? { en: description } : {};
  const regionFallback = inferSwissTargetCanton(location) === 'GR' ? 'Graubunden' : 'Ticino';
  const slugByLocale = {
    it: slugify(`${titleByLocale.it} Alten Switzerland ${location || regionFallback}`),
    en: slugify(`${titleByLocale.en} Alten Switzerland ${location || regionFallback}`),
    de: slugify(`${titleByLocale.de} Alten Switzerland ${location || regionFallback}`),
    fr: slugify(`${titleByLocale.fr} Alten Switzerland ${location || regionFallback}`),
  };

  return {
    title,
    slug: slugByLocale.it,
    pageUrl,
    applyUrl,
    location: location || regionFallback,
    postedDate,
    description,
    titleByLocale,
    descriptionByLocale,
    slugByLocale,
  };
}
