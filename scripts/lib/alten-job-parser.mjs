import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { getCantonDisplayName } from './crawler-location-config.mjs';
import { SWISS_LOCALITY_SENTENCE_SPLIT_RX } from './swiss-locality-sentence-split.mjs';

function compact(text = '') {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
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

// ALTEN Switzerland is a national engineering consultancy — collect jobs
// across all 26 cantons. A listing is kept iff its location string resolves
// to a Swiss canton (CH-wide via inferAnyCanton). Foreign or canton-less
// rows (e.g. a bare "Switzerland" with no city/region) stay unresolved and
// are dropped — we never default an unresolved job to a canton.
export function isAltenSwissLocation(location = '') {
  return Boolean(inferAnyCanton(compact(location)));
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
    .filter((item) => item.title && item.href && isAltenSwissLocation(item.location));
}

export function parseAltenDetailHtml(html = '', pageUrl = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const root = document.querySelector('.wp-block-jobboard-offer') || document.querySelector('.entry-content') || document.body;
  const title = compact(document.querySelector('h1')?.textContent || document.querySelector('h2.wp-block-post-title')?.textContent || '');
  const applyUrl = document.querySelector('a[href$="/apply"]')?.getAttribute('href') || '';
  // Strip the leading "Location" label and ANY trailing prose:
  //   1. `[class*="location"]` selector (loose) sometimes matches the
  //      requirements <p> when ALTEN inlines "Location: Zürich, Switzerland."
  //      mid-paragraph (no newline before the next sentence). Without a
  //      sentence-boundary cut, the previous parser took the entire trailing
  //      paragraph as the city ("Ticino, Switzerland.Availability to work
  //      on-site is required. What we offer you…", 450 char). That broken
  //      field then leaked into addressLocality, the SEO slug, and the
  //      <title> downstream — caught 2026-04-28 on the
  //      java-software-ingegnere-alten-switzerland-… page.
  //   2. The label can be `Location:Ticino` (no space) → strip the optional
  //      colon explicitly so we don't keep a leading `:` in the value.
  //   3. Cut at the first sentence boundary (`;`, newline, sentence-ending
  //      `.`) so a compact city string survives even when the surrounding
  //      markup runs prose into the same node — but preserve "St."/"Ste."
  //      abbreviation periods in Swiss city names (St. Moritz, St. Gallen,
  //      Ste. Croix), which a blanket "." split truncated to "St"/"Ste".
  const rawLocationNode = compact(
    Array.from(document.querySelectorAll('.block--inner, .wp-block-jobboard-offer-sidebar, .card-location, [class*="location"]'))
      .map((el) => compact(el.textContent || ''))
      .find((text) => /Location/i.test(text) && isAltenSwissLocation(text)) || ''
  );
  const location = rawLocationNode
    .replace(/^.*?Location\s*[:.]?\s*/i, '')
    // Shared cut with sanitizeJobLocationField in scripts/assemble-jobs-dataset.mjs:
    // negative lookbehind keeps the period after a "St"/"Ste" token (St. Moritz,
    // St. Gallen, Ste. Croix). See swiss-locality-sentence-split.mjs.
    .split(SWISS_LOCALITY_SENTENCE_SPLIT_RX)[0]
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
  // CH-wide fallback label for the slug when no city string was extracted:
  // use the resolved canton's display name (any of the 26 cantons), never a
  // hard-coded TI/GR default. If the canton cannot be resolved, fall back to
  // the neutral "Switzerland" rather than guessing a canton.
  const fallbackCanton = inferAnyCanton(location);
  const regionFallback = fallbackCanton
    ? getCantonDisplayName(fallbackCanton, 'en') || 'Switzerland'
    : 'Switzerland';
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
