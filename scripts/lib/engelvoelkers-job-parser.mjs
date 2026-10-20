import { decode as decodeHTML } from 'html-entities';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * Engel & Völkers Switzerland — careers page parser
 *
 * Listing page: https://www.engelvoelkers.com/ch/it/azienda/carriera/offerte-di-lavoro
 *   - Next.js SSR app, jobs rendered as <div> cards with <h2> titles
 *   - Links: /ch/it/azienda/carriera/offerte-di-lavoro/{UUID}
 *   - Pagination: client-side buttons (2 pages currently)
 *
 * Detail page: same base URL + /{UUID}
 *   - Rich HTML description in the main content area
 *   - Meta tags: og:title, og:description
 *   - Company, department, employment type in span elements
 */

import { JSDOM } from 'jsdom';
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { isSwissLocationText, inferAnyCanton } from './target-swiss-locations.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { dropFabricatedDescription } from './drop-fabricated-description.mjs';
import { sourceLangOfBody, sourceSlotTitleAndSlug } from './source-locale-slots.mjs';

const BASE_URL = 'https://www.engelvoelkers.com';
const LISTING_PATH = '/ch/it/azienda/carriera/offerte-di-lavoro';
const UUID_RE = /\/offerte-di-lavoro\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value = '') {
  return decodeHTML(String(value || ''), { scope: 'strict' }).replaceAll('\u00a0', ' ');
}

function stripHtml(html = '') {
  return decodeEntities(String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\u00b7/g, '·')
    .replace(/\u2013/g, '–')
    .replace(/\u2019/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractNextDataPayload(html = '') {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractPostingFromNextData(html = '') {
  return extractNextDataPayload(html)?.props?.pageProps?.data?.details?.posting || null;
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

/**
 * Parse the listing page HTML and return an array of job summaries.
 * Strategy: find all <a> links matching the UUID URL pattern, then
 * walk up to the card container to extract title, location, company info.
 */
export function parseEngelvoelkersListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const results = [];
  const seen = new Set();

  // Find all h2 elements — each represents a job title in a card
  const headings = [...document.querySelectorAll('h2')];

  for (const h2 of headings) {
    const title = normalizeSpace(h2.textContent || '');
    if (!title) continue;

    // Walk up to find the card container that has the link
    let container = h2.parentElement;
    let anchor = null;
    let depth = 0;
    while (container && depth < 6) {
      anchor = container.querySelector(`a[href*="/offerte-di-lavoro/"]`);
      if (anchor) break;
      container = container.parentElement;
      depth++;
    }
    if (!anchor) continue;

    const href = String(anchor.getAttribute('href') || '').trim();
    const match = href.match(UUID_RE);
    if (!match) continue;

    const uuid = match[1].toLowerCase();
    if (seen.has(uuid)) continue;
    seen.add(uuid);

    // Extract location — it's in a div before the h2, typically the first text div in the card
    let location = '';
    const cardRoot = container;
    if (cardRoot) {
      // Location is usually in a div that contains a city and country.
      const allDivs = [...cardRoot.querySelectorAll('div')];
      for (const div of allDivs) {
        const text = normalizeSpace(div.textContent || '');
        if (text && /switzerland|schweiz|svizzera|suisse/i.test(text) && text.length < 80) {
          location = text;
          break;
        }
      }
    }

    // Extract company, department, employment type from span siblings
    let company = '';
    let department = '';
    let employmentType = '';
    if (cardRoot) {
      const spans = [...cardRoot.querySelectorAll('span')];
      const metaSpans = spans
        .map((s) => normalizeSpace(s.textContent || ''))
        .filter((t) => t && t.length > 2 && t.length < 120);

      // Heuristic: first span = company, second = department, third = employment type
      if (metaSpans.length >= 1) company = metaSpans[0];
      if (metaSpans.length >= 2) department = metaSpans[1];
      if (metaSpans.length >= 3) employmentType = metaSpans[2];
    }

    const detailUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

    results.push({
      title,
      uuid,
      detailUrl,
      location,
      company,
      department,
      employmentType,
    });
  }

  return results;
}

/**
 * Parse a detail page and extract the job description + metadata.
 * Uses a combination of meta tags and HTML content parsing.
 */
export function parseEngelvoelkersDetailPage(html = '', fallbackTitle = '') {
  const posting = extractPostingFromNextData(html);
  const document = new JSDOM(html).window.document;

  const ogTitle = (document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '');
  const metaTitle = (document.querySelector('title')?.textContent || '');
  const h1 = document.querySelector('h1');

  const title = normalizeSpace(
    posting?.text ||
    ogTitle.replace(/\s*\|\s*Engel\s*&\s*Völkers.*$/i, '') ||
    metaTitle.replace(/\s*\|\s*Engel\s*&\s*Völkers.*$/i, '') ||
    h1?.textContent ||
    fallbackTitle,
  );

  // crawler-template.stripHtml converts <li>→"\n• " and <p>→"\n" so list
  // structure survives. Previously we wrapped it in normalizeSpace() which
  // collapsed all the newlines back into spaces — the audit then flagged
  // every E&V job as flat prose.
  // The posting is a Lever payload: `descriptionHtml` is only the opening
  // paragraph, the role itself lives in `lists` (one entry per section —
  // «Ihre Aufgaben», «Ihr Profil», «Unser Angebot», each a heading `text` and
  // an HTML `content` list) and the application note in `closingHtml`.
  // Reading only `descriptionHtml` published the licensee's company intro for
  // every posting: the Senior (5+ years) and the Junior (2-5 years) broker in
  // Schaffhausen carried the same 930-char body (issue 5253).
  const content = posting?.content || {};
  const sections = [stripHtml(content.descriptionHtml || content.description || '')];
  for (const list of Array.isArray(content.lists) ? content.lists : []) {
    const body = stripHtml(list?.content || '');
    if (!body) continue;
    const heading = normalizeSpace(decodeEntities(list?.text || ''));
    sections.push(heading ? `${heading}\n${body}` : body);
  }
  sections.push(stripHtml(content.closingHtml || content.closing || ''));
  const nextDescription = sections
    .filter(Boolean)
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    // `<li><p>…</p></li>` leaves the marker alone on its line.
    .replace(/•\n+/g, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const metaDesc = (document.querySelector('meta[name="description"]')?.getAttribute('content') || '');
  let richDesc = nextDescription;

  if (!richDesc) {
    const allElements = document.querySelectorAll('p, ul, div > span');
    const descParts = [];
    let inContent = false;

    for (const el of allElements) {
      // For <ul>, expand each <li> on its own line so list structure is
      // preserved for the audit and Schema.org JobPosting.description.
      let text;
      if (el.tagName === 'UL') {
        const items = Array.from(el.querySelectorAll('li'))
          .map((li) => normalizeSpace(li.textContent || ''))
          .filter((t) => t.length > 2);
        text = items.length ? items.map((t) => `• ${t}`).join('\n') : '';
      } else {
        text = normalizeSpace(el.textContent || '');
      }
      if (!text || text.length < 10) continue;

      if (/cosa ti aspetta|your responsibilities|ihre aufgaben|vos responsabilités|il tuo profilo|your profile|ihr profil|cosa offriamo|we offer|wir bieten/i.test(text)) {
        inContent = true;
      }

      if (!inContent && text.length > 80 && !/engel.*völkers|menu principale|contattaci|cookie|privacy/i.test(text)) {
        inContent = true;
      }

      if (inContent) {
        if (/informazioni legali|privacy dei dati|legal notice|datenschutz/i.test(text)) break;
        if (/cookie.*policy|terms.*conditions/i.test(text)) break;

        if (!descParts.includes(text) && text.length > 5) {
          descParts.push(text);
        }
      }
    }

    richDesc = descParts.join('\n').trim();
  }

  const description = richDesc || metaDesc || '';
  // This parser has no source publication timestamp; collection time is not one.
  const datePosted = '';

  return { title, description, datePosted };
}

/**
 * Build the source-language content of an Engel & Völkers job.
 *
 * Only the posting's own text is published, in its own language: the
 * translation step fills the other locales. The builder used to append a
 * synthesized "Dettagli della posizione / Position highlights / Eckdaten der
 * Stelle / Détails du poste" bullet block to the SAME source text in all four
 * locales — written to satisfy the audit's structure check, not taken from the
 * posting (10/10 jobs) — and, without a body, an invented sentence ("… cerca
 * personale per la posizione …"). A body under the 50-word source floor gives
 * no description: the runner keeps the stored source text or leaves the job
 * out (issue 5253). Slugs are filed under the source slot; the
 * locale-preserving merge keeps every slug already published under another
 * key.
 */
export function buildEngelvoelkersLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').replace(/,?\s*Switzerland$/i, '').trim();
  const description = String(job.description || '').trim();
  const sourceLang = sourceLangOfBody(description, String(job.sourceLang || 'it'));
  const slug = slugify(`${title} engel-voelkers ${location}`);
  return {
    sourceLang,
    ...sourceSlotTitleAndSlug(title, slug, sourceLang),
    descriptionByLocale: meetsSourceBodyFloor(description) ? { [sourceLang]: description } : {},
  };
}

// First line of the synthesized block the retired builder appended, in each
// locale. A stored slot that contains one is not source text.
const LEGACY_DETAILS_BLOCK_RE = /\n*(?:Dettagli della posizione:|Position highlights:|Eckdaten der Stelle:|Détails du poste :)\n[\s\S]*$/;
const LEGACY_INVENTED_SENTENCE_RE = /cerca personale per la posizione|is hiring for the .+ position based in|sucht derzeit für die Position|recrute pour le poste .+ basé à/;

/** True when a stored slot was written by the retired builder. */
export function isEngelvoelkersLegacyText(text = '') {
  const value = String(text || '');
  return LEGACY_DETAILS_BLOCK_RE.test(value) || LEGACY_INVENTED_SENTENCE_RE.test(value);
}

/**
 * The source body a job may be published with: this run's body, else the
 * stored source slot stripped of the retired details block when that is real
 * source text over the 50-word floor, else null (not published this run).
 */
export function engelvoelkersPublishableBody(job = {}, prev = null) {
  const lang = job.sourceLang || 'it';
  const fresh = String(job.descriptionByLocale?.[lang] || '');
  if (meetsSourceBodyFloor(fresh)) return { sourceLang: lang, body: fresh };
  const storedLang = prev?.sourceLang || lang;
  const stored = String(prev?.descriptionByLocale?.[storedLang] || '').replace(LEGACY_DETAILS_BLOCK_RE, '').trim();
  if (stored && !LEGACY_INVENTED_SENTENCE_RE.test(stored) && meetsSourceBodyFloor(stored)) {
    return { sourceLang: storedLang, body: stored };
  }
  return null;
}

/**
 * The retired builder's own text in a stored slot: its synthesized block or its
 * invented sentence. Shared cleanup: `dropFabricatedDescription`
 * (drop-fabricated-description.mjs) removes the matching slots, the
 * translations made from them and the flat description.
 */
export const ENGELVOELKERS_FABRICATED_DESCRIPTION_RE = new RegExp(
  `${LEGACY_DETAILS_BLOCK_RE.source.replace(/^\\n\*/, '')}|${LEGACY_INVENTED_SENTENCE_RE.source}`,
);

/**
 * Drop the retired builder's output from a stored record before the merge:
 * the description slots it wrote (shared cleanup, see above) and the copies of
 * the source title it wrote into the other locales. Returns a cleaned copy.
 */
export function scrubEngelvoelkersLegacySlots(prev = {}) {
  if (!prev || typeof prev !== 'object') return prev;
  const job = {
    ...prev,
    descriptionByLocale: { ...(prev.descriptionByLocale || {}) },
    titleByLocale: { ...(prev.titleByLocale || {}) },
  };
  let changed = dropFabricatedDescription(job, ENGELVOELKERS_FABRICATED_DESCRIPTION_RE);
  const sourceTitle = String(job.titleByLocale[job.sourceLang] || job.title || '').trim();
  for (const [locale, text] of Object.entries(job.titleByLocale)) {
    if (locale !== job.sourceLang && sourceTitle && String(text || '').trim() === sourceTitle) {
      delete job.titleByLocale[locale];
      changed = true;
    }
  }
  if (!changed) return prev;
  return { ...job, needsRetranslation: true };
}

/**
 * Check whether a location string belongs to any Swiss canton.
 */
export function isEngelvoelkersSwissRelevant(location = '') {
  const loc = normalizeSpace(location);
  if (!loc) return false;
  return !isLocationExplicitlyForeign(loc) && isSwissLocationText(loc);
}

/** Infer the Swiss canton from the posting's own location text. */
export function inferEngelvoelkersCanton(location = '') {
  return inferAnyCanton(location);
}
