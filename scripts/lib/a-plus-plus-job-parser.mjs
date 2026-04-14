import { JSDOM } from 'jsdom';

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
        .replace(/<\/(?:p|div|li)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
    );
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

/**
 * Try to extract a JobPosting JSON-LD block from the page HTML.
 */
function extractJobPostingJsonLd(html = '') {
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'JobPosting') return item;
      }
    } catch {
      // malformed JSON — skip
    }
  }
  return null;
}

/**
 * Parse the InRecruiting A++ Group career listing page.
 *
 * The direct portal at inrecruiting.intervieweb.it/a2plus/en/career uses the
 * standard InRecruiting `div.vacancy__render` card structure.  Each card
 * contains a title anchor, optional subtitle spans, and a description excerpt.
 */
export function parseAplusListings(html = '') {
  const document = new JSDOM(html).window.document;

  const cards = [...document.querySelectorAll('div.vacancy__render')];

  return cards
    .map((card) => {
      const titleAnchor =
        card.querySelector('.vacancy__title h3 a') ||
        card.querySelector('.vacancy__title a') ||
        card.querySelector('h3 a') ||
        card.querySelector('a[href*="/jobs/"]');

      const href = String(titleAnchor?.getAttribute('href') || '').trim();
      const title = normalizeSpace(titleAnchor?.textContent || '');

      // InRecruiting uses title attributes on subtitle spans in Italian/English UIs
      const locationSpan =
        card.querySelector('.subtitle__informations[title="Sede"]') ||
        card.querySelector('.subtitle__informations[title="Location"]') ||
        card.querySelector('.subtitle__informations');

      const rawLoc = normalizeSpace(locationSpan?.textContent || '');
      const location = rawLoc;
      const teaser = normalizeSpace(card.querySelector('.vacancy__description')?.textContent || '');

      return { href, title, location, teaser };
    })
    .filter((row) => row.href && row.title);
}

/**
 * Parse an InRecruiting detail page.
 *
 * Prefers JobPosting JSON-LD when present (InRecruiting embeds it on most
 * tenant portals).  Falls back to the standard InRecruiting HTML structure
 * shared by Pizzarotti and Zucchetti parsers.
 */
export function parseAplusJobDetail(html = '', pageUrl = '') {
  const jsonLd = extractJobPostingJsonLd(html);
  if (jsonLd?.title) {
    const rawLocality = normalizeSpace(
      jsonLd.jobLocation?.address?.addressLocality ||
      jsonLd.jobLocation?.address?.addressRegion ||
      ''
    );
    // If the locality is purely numeric (a postal code, not a city name),
    // discard it — the crawler will fall back to listing location or HQ default.
    // Also strip country suffixes (e.g. "Chiasso Svizzera" → "Chiasso").
    const cleaned = rawLocality
      .replace(/\s+(?:svizzera|suisse|schweiz|switzerland|italia|italy|italien|italie)\s*$/i, '').trim();
    const addressLocality = /^\d+$/.test(cleaned) ? '' : cleaned;
    const description = typeof jsonLd.description === 'string'
      ? htmlFragmentToMarkdown(jsonLd.description)
      : '';
    return {
      title: normalizeSpace(jsonLd.title),
      location: addressLocality,
      description,
      shareUrl: jsonLd.url || pageUrl,
    };
  }

  // HTML fallback — same structure used across InRecruiting tenants
  const document = new JSDOM(html).window.document;
  const title = normalizeSpace(document.querySelector('#description__vacancy-title')?.textContent || '');
  const subtitleInfos = [
    ...document.querySelectorAll('#description__subtitle .subtitle__informations'),
  ].map((node) => normalizeSpace(node.textContent || ''));
  const location = subtitleInfos[0] || '';

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

  const shareUrl = normalizeSpace(document.querySelector('.share__hidden')?.textContent || '') || pageUrl;

  return {
    title,
    location,
    description: sections.join('\n\n').trim(),
    shareUrl,
  };
}

/**
 * Return true if the raw location string corresponds to a Swiss location.
 * A++ Group operates in TI/GR but may have other Swiss positions.
 */
export function isAplusSwissLocation(raw = '') {
  const lower = normalizeSpace(raw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  return /svizzera|suisse|schweiz|switzerland|swiss|ticino|tessin|grigioni|graubunden|grisons|massagno|lugano|chiasso|bellinzona|locarno|mendrisio|ascona|muralto|chur|davos/.test(
    lower,
  );
}

/**
 * Infer the Swiss canton abbreviation from a raw location string.
 * Defaults to 'TI' because A++ Group headquarters is in Massagno (TI).
 */
export function inferAplusCanton(raw = '') {
  const lower = normalizeSpace(raw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/grigioni|graubunden|grisons|chur|davos/.test(lower)) return 'GR';
  if (/ticino|tessin|massagno|lugano|chiasso|bellinzona|locarno|mendrisio|ascona|muralto/.test(lower)) return 'TI';
  // Generic CH markers — not enough to confidently assign TI
  if (/svizzera|suisse|schweiz|switzerland|swiss/.test(lower)) return '';
  return '';
}

/**
 * Build stub localised content from a parsed detail.
 * The AI translation pipeline will fill in the remaining locales.
 */
export function buildAplusLocalizedContent(detail = {}) {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || 'Massagno').trim();
  const slug = slugify(`${title} a-plus-plus group ${location}`);
  return {
    titleByLocale: { it: title },
    descriptionByLocale: { it: detail.description || '' },
    slugByLocale: { it: slug, en: slug },
  };
}
