import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import { inferAnyCanton } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
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
    .replace(/<li[^>]*>/gi, '\n• ')
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

// Chrome that lives INSIDE role sections on jobs.ruag.ch: cookie-consent
// placeholders for the embedded YouTube/Maps players and the media nodes
// themselves. Everything else in the selected sections is vacancy content.
const RUAG_SKIP_SELECTOR = '.cookiemeldung, iframe, img, svg, script, style, noscript, button, .jobInfoVideoWrapper';

/**
 * Render a DOM subtree as the pipeline's markdown: `- ` bullets for list
 * items, blank-line separated paragraphs for block elements, headings left to
 * the caller. Language-agnostic by construction — it never matches on the
 * visible heading text, which differs per locale (DE/IT/FR/EN pages).
 */
function elementToMarkdown(root) {
  if (!root) return '';
  const blocks = [];
  let inline = '';
  const flush = () => {
    const text = normalizeSpace(inline);
    if (text) blocks.push(text);
    inline = '';
  };
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        inline += child.textContent || '';
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (child.matches?.(RUAG_SKIP_SELECTOR)) continue;
      const tag = child.nodeName.toLowerCase();
      if (tag === 'br') {
        flush();
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        flush();
        const items = [...child.querySelectorAll(':scope > li')]
          .map((li) => normalizeSpace(li.textContent || ''))
          .filter(Boolean)
          .map((text) => `- ${text}`);
        if (items.length) blocks.push(items.join('\n'));
        continue;
      }
      if (/^(?:p|div|section|h[1-6]|li|table|tr)$/.test(tag)) {
        flush();
        walk(child);
        flush();
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  flush();
  return blocks.join('\n\n').trim();
}

function sectionHeading(root, selector = 'h2') {
  return normalizeSpace(root?.querySelector(selector)?.textContent || '').replace(/:$/, '');
}

/**
 * Body of a section without its own heading element (rendered separately as
 * a `## ` markdown heading so the page's section titles survive verbatim).
 */
function sectionBody(root, headingSelector = 'h2') {
  if (!root) return '';
  const clone = root.cloneNode(true);
  clone.querySelector(headingSelector)?.remove();
  return elementToMarkdown(clone);
}

function withHeading(heading, body) {
  if (!body) return '';
  return heading ? `## ${heading}\n\n${body}` : body;
}

/**
 * The vacancy's role content on the current jobs.ruag.ch detail template, in
 * page order: introduction, every visible `.jobInfoList` (tasks, profile),
 * the encouragement/diversity note, the workplace address, the division
 * blurb ("Über den Bereich"), the benefit cards, the application notes and
 * the contact. The contact form, awards, map and "Weitere Stellen" teasers
 * are page chrome and stay out.
 *
 * Before this, the parser kept only the JSON-LD responsibilities and
 * qualifications plus two sections matched by Italian heading text — on the
 * German pages (66/68 jobs) that meant the intro, the division blurb and the
 * benefit cards were dropped, and the published text was 21-35 % of the
 * detail page (audit run 36528331656).
 */
function extractRuagRoleSections(document) {
  const sections = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !sections.includes(text)) sections.push(text);
  };

  push(elementToMarkdown(document.querySelector('section#introduction')));

  const wrapper = document.querySelector('#jobInfoWrapper');
  const contactName = normalizeSpace(document.querySelector('.contactInfoName')?.textContent || '');
  if (wrapper) {
    for (const child of [...wrapper.children]) {
      if (child.matches('.jobInfoList')) {
        const heading = sectionHeading(child, '.jobInfoListTitle');
        const body = elementToMarkdown(child.querySelector('.jobInfoListText'));
        // The print-only contact card repeats section#contact below.
        if (child.matches('.hiddenScreen') && contactName && body.includes(contactName)) continue;
        push(withHeading(heading, body));
        continue;
      }
      push(elementToMarkdown(child));
    }
  }

  const about = document.querySelector('section#about .contentTextWrapper');
  push(withHeading(sectionHeading(about), sectionBody(about)));

  const benefits = document.querySelector('section#benefits');
  if (benefits) {
    const intro = benefits.querySelector('.benefitIntroduction');
    const cards = [...benefits.querySelectorAll('.expectationInfos')]
      .map((card) => {
        const title = normalizeSpace(card.querySelector('h3, h4')?.textContent || '');
        const text = normalizeSpace(card.querySelector('p')?.textContent || '');
        if (!title && !text) return '';
        return `- ${[title, text].filter(Boolean).join(': ')}`;
      })
      .filter(Boolean);
    const body = [sectionBody(intro), cards.join('\n')].filter(Boolean).join('\n\n');
    push(withHeading(sectionHeading(intro), body));
  }

  const process = document.querySelector('section#applicationProcess .contentTextWrapper');
  if (process) {
    push(withHeading(sectionHeading(process), elementToMarkdown(process.querySelector('#applicationProcessText'))));
  }

  const contact = document.querySelector('section#contact');
  if (contact) {
    const lines = [
      contactName,
      ...[...contact.querySelectorAll('.contactInfoText p')].map((p) => normalizeSpace(p.textContent || '')),
      normalizeSpace(contact.querySelector('.contactInfoText a[href^="tel:"]')?.textContent || ''),
    ].filter(Boolean);
    if (lines.length) push(withHeading(sectionHeading(contact), [...new Set(lines)].join('\n')));
  }

  return sections;
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
  // The inline `#location` value is a listing/search label and can be a
  // nearby hub (the live Schattdorf vacancy exposes `Altdorf` there). The
  // JobPosting address is the vacancy's own structured workplace, so use it
  // first and retain the inline value only as a fallback for older pages.
  const location =
    normalizeRuagLocation(jobPosting?.jobLocation?.address?.addressLocality || '') ||
    normalizeRuagLocation(extractLocationFromInlineScript(html)) ||
    normalizeRuagLocation(document.querySelector('#location .placeList')?.textContent || '');
  const canonicalUrl = String(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || url).trim();
  const applyUrl = String(document.querySelector('a[href*="/apply/ats/"]')?.getAttribute('href') || '').trim();
  const company =
    normalizeSpace(jobPosting?.hiringOrganization?.name || '') ||
    normalizeSpace(document.querySelector('meta[name="author"]')?.getAttribute('content') || '') ||
    'RUAG AG';
  const roleSections = extractRuagRoleSections(document);
  const hasRoleLists = Boolean(document.querySelector('#jobInfoWrapper .jobInfoList'));
  const responsibilities = htmlFragmentToMarkdown(jobPosting?.responsibilities || '');
  const qualifications = htmlFragmentToMarkdown(jobPosting?.qualifications || '');
  if (!hasRoleLists) {
    // Older template without the `.jobInfoList` blocks: the JSON-LD
    // responsibilities/qualifications are the only per-vacancy lists. The
    // JSON-LD carries no headings for them, and none is invented (the old
    // "## Responsabilita"/"## Requisiti" labels sat in Italian over German
    // bodies on 61/68 jobs of slice 995a6583431).
    const fallback = [responsibilities, qualifications].filter(Boolean);
    roleSections.splice(Math.min(1, roleSections.length), 0, ...fallback);
  }

  return {
    title,
    canonicalUrl,
    applyUrl,
    company,
    location,
    canton: inferAnyCanton(location),
    description: roleSections.join('\n\n').trim(),
    // Role-only text for keyword classification: the full description now
    // carries the benefit cards ("Homeoffice-Optionen" on every page), which
    // must not turn every vacancy into an office job.
    roleText: [responsibilities, qualifications].filter(Boolean).join('\n'),
    postedDate: normalizeSpace(jobPosting?.datePosted || ''),
    validThrough: normalizeSpace(jobPosting?.validThrough || ''),
    employmentType: normalizeSpace(jobPosting?.employmentType || ''),
    similarLinks: extractSimilarLinks(html),
  };
}

export function isRuagTargetLocation(raw = '') {
  // Country-only labels prove Switzerland, not a concrete job locality.
  // Require a resolvable city/canton before emitting a Swiss JobPosting.
  return Boolean(inferAnyCanton(raw));
}

export function inferRuagCanton(raw = '') {
  // No fixed-canton default — RUAG is a national defence employer; leave blank
  // when unresolved so downstream hardening can derive the canton.
  return inferAnyCanton(raw) || '';
}

export function buildRuagLocalizedContent(detail = {}, companyName = 'RUAG AG', locale = 'it') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Svizzera';
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
