import { decode as decodeHTML } from 'html-entities';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * Lombardi Group — careers page parser
 *
 * Listing: https://lombardi.group/eng/careers/open-positions
 *   Embedded `var _jobs = [...]` JSON array with all positions.
 *   Each entry has annuncioId, sedeId, titolo, descNazione, descrizione, occupMin/Max.
 *
 * Detail: https://lombardi.group/eng/careers/job?id={annuncioId}
 *   HTML page with full description, requirements, location, contacts.
 *
 * Sede mapping (Swiss offices):
 *   sedeId=1       → Giubiasco (TI)  ← local target office
 *   sedeId=12      → Fribourg
 *   sedeId=435302  → Rotkreuz
 *   sedeId=446348  → Urdorf
 *   sedeId=458683  → Lausanne
 */

import { detectLang } from './dedicated-crawler-common.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { fetchHtml, normalizeSpace, normalizeDescriptionSpace, stripScriptsAndStyles } from './crawler-template.mjs';

const LISTING_URL = 'https://lombardi.group/eng/careers/open-positions';
const DETAIL_URL = 'https://lombardi.group/eng/careers/job?id=';

// Local office sedeIds (Giubiasco)
const LOCAL_SEDE_IDS = new Set(['1']);


function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

function stripHtml(html = '') {
  return decodeHTML(String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' '), { scope: 'strict' })
    .replaceAll('\u00a0', ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the embedded `var _jobs = [...]` JSON array from listing-page HTML.
 *
 * Pure (no network) so the brittle source-shape contract is unit-testable: a
 * Lombardi site redesign that drops/renames the embedded `_jobs` block — the
 * real future break mode for this crawler — is caught immediately instead of
 * silently yielding zero jobs. Throws when the marker is absent (e.g. an
 * Internal-Server-Error page or a redesigned listing).
 *
 * @param {string} html  Raw listing-page HTML.
 * @returns {Array<object>} Parsed `_jobs` entries.
 */
export function extractLombardiJobsFromHtml(html) {
  const match = String(html || '').match(/var _jobs = (\[.*?\]);/s);
  if (!match) throw new Error('Could not find _jobs data in listing page');
  return JSON.parse(match[1]);
}

/**
 * Fetch and parse the listing page to extract the embedded _jobs JSON.
 */
export async function parseLombardiListingPage(timeoutMs = 20000) {
  const html = await fetchHtml(LISTING_URL, {
    timeoutMs,
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
    },
  });
  return extractLombardiJobsFromHtml(html);
}

/**
 * Extract list items from an HTML section (content between two h3 tags).
 */
function extractListItems(sectionHtml) {
  const items = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(sectionHtml)) !== null) {
    const text = stripHtml(m[1]);
    if (text.length > 2) items.push(text);
  }
  return items;
}

/**
 * Word-level overlap between two strings (0..1).
 */
export function titleOverlap(a, b) {
  if (!a || !b) return 0;
  const clean = (s) =>
    String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean);
  const wordsA = new Set(clean(a));
  const wordsB = new Set(clean(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.max(wordsA.size, wordsB.size);
}

// Section headings to extract content from (all site languages)
const CONTENT_HEADINGS = /Job Description|Descrizione dell.offerta|Requisiti|Requirements|Anforderungen|Profil|We offer|Offriamo|Wir bieten|Nous offrons/i;
// Section headings to skip
const SKIP_HEADINGS = /Contact|Contatti|Kontakt|Apply now|Candidati ora|Jetzt bewerben|Postuler|Thank you|Grazie/i;

/**
 * Parse a Lombardi detail page into structured markdown content.
 * Extracts title, intro, and all job-relevant sections (Job Description, Requirements, We offer).
 */
export function parseLombardiDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Parse actual markup before decoding captured text, so escaped tags stay text.
  const pageHtml = stripScriptsAndStyles(html);

  // Extract title from <h2 class="h1 intro__subtitle">
  const titleMatch = pageHtml.match(/<h2[^>]*class="[^"]*intro__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  const detailTitle = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Extract occupancy and city: "80%–100% | Giubiasco"
  const locationText = pageHtml.match(/>([^<>]*\d+%[^<>]*\|[^<>]*)</)?.[1] || '';
  const locMatch = stripHtml(locationText).match(/(\d+%\s*[–-]\s*\d+%)\s*\|\s*([^\n]+)/);
  const city = locMatch ? normalizeSpace(locMatch[2]) : '';
  const occupancy = locMatch ? normalizeSpace(locMatch[1]) : '';

  // Extract intro text from <div class="intro__rich-text">
  const introMatch = pageHtml.match(/<div[^>]*class="[^"]*intro__rich-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const introText = introMatch ? normalizeDescriptionSpace(stripHtml(introMatch[1])) : '';

  // Extract main content area (between <!-- Title END--> and the contact/form section)
  const mainMatch = pageHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const mainHtml = mainMatch ? mainMatch[1] : pageHtml;

  // Parse all h3 sections and their content
  const sections = [];
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const h3Matches = [];
  let m;
  while ((m = h3Re.exec(mainHtml)) !== null) {
    h3Matches.push({ heading: normalizeSpace(stripHtml(m[1])), index: m.index, length: m[0].length });
  }

  for (let i = 0; i < h3Matches.length; i++) {
    const { heading, index, length } = h3Matches[i];

    if (SKIP_HEADINGS.test(heading)) continue;
    if (!CONTENT_HEADINGS.test(heading)) continue;

    // Content between this h3 and the next h3 (or end of main)
    const start = index + length;
    const end = i + 1 < h3Matches.length ? h3Matches[i + 1].index : mainHtml.length;
    const sectionHtml = mainHtml.slice(start, end);

    const items = extractListItems(sectionHtml);
    if (items.length > 0) {
      // Map English headings to Italian for consistency
      let itHeading = heading;
      if (/Job Description|Descrizione/i.test(heading)) itHeading = 'Mansioni';
      else if (/Requirements|Requisiti|Anforderungen/i.test(heading)) itHeading = 'Requisiti';
      else if (/We offer|Offriamo|Wir bieten/i.test(heading)) itHeading = 'Offriamo';
      sections.push({ heading: itHeading, items });
    }
  }

  // Build markdown description
  const parts = [];
  if (introText) parts.push(introText);
  for (const sec of sections) {
    parts.push(`\n## ${sec.heading}\n${sec.items.map((it) => `- ${it}`).join('\n')}`);
  }
  const markdown = parts.join('\n').trim();
  const sectionCount = sections.length;

  return {
    detailTitle,
    city,
    occupancy,
    introText,
    sections,
    markdown,
    sectionCount,
    sourceTextLength: stripHtml(mainHtml).length,
  };
}

/**
 * Fetch a detail page and extract structured content.
 */
export async function parseLombardiDetailPage(annuncioId, timeoutMs = 15000) {
  const url = `${DETAIL_URL}${annuncioId}`;
  try {
    const html = await fetchHtml(url, {
      timeoutMs,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    return parseLombardiDetailHtml(html);
  } catch {
    return null;
  }
}

/**
 * Check whether a listing belongs to Lombardi's local Swiss office.
 * The source exposes several Swiss offices; this crawler intentionally keeps
 * only `sedeId=1` (Giubiasco), rather than expanding to every Swiss canton.
 */
export function isLombardiLocalJob(job = {}) {
  return LOCAL_SEDE_IDS.has(String(job.sedeId ?? ''));
}

/**
 * Build the source-language content of a Lombardi job from its detail page.
 *
 * Only the posting's own language is filled — title, description, slug — and
 * the translation step fills the other locales. The builder used to stamp an
 * invented Italian blurb ("Lombardi Group, studio di ingegneria con sede a …
 * Candidati tramite il portale ufficiale.") into the `it` slot of every job and
 * copy the source title into all four locales: an English posting showed the
 * blurb on the Italian page, and the title copies kept the translation step
 * from ever translating the title.
 *
 * Without a detail body — or with one under the shared word floor
 * (source-body-floor.mjs) — there is nothing from the source to publish:
 * returns null and the caller keeps an earlier source body or leaves the job
 * out.
 *
 * @returns {{ sourceLang: string, titleByLocale: object, descriptionByLocale: object, slugByLocale: object } | null}
 */
export function buildLombardiLocalizedContent(job = {}) {
  const title = normalizeSpace(job.title);
  const city = normalizeSpace(job.city) || 'Giubiasco';
  const detailDesc = String(job.detailMarkdown || '');
  if (!meetsSourceBodyFloor(detailDesc)) return null;
  const sourceLang = detectLang(detailDesc, 'it');
  return {
    sourceLang,
    titleByLocale: { [sourceLang]: title },
    descriptionByLocale: { [sourceLang]: detailDesc },
    slugByLocale: { [sourceLang]: slugify(`${title} lombardi ${city}`) },
  };
}

// The invented blurb the old builder wrote into the `it` slot. Pinned only to
// recognise and remove it from stored records.
const LEGACY_BLURB_RE = /^Lombardi Group, studio di ingegneria con sede a [\s\S]*Candidati tramite il portale ufficiale\.$/;

export function isLombardiLegacyBlurb(text = '') {
  return LEGACY_BLURB_RE.test(String(text || '').trim());
}

/**
 * True when the stored record carries a body read from the detail page (so it
 * can stay published on a run whose detail fetch failed).
 */
export function lombardiHasSourceBody(job = {}) {
  const body = String(job?.descriptionByLocale?.[job?.sourceLang] || job?.description || '').trim();
  return meetsSourceBodyFloor(body) && !isLombardiLegacyBlurb(body);
}

/**
 * Remove what the old builder left in a stored record: the invented blurb in
 * any description slot (and as base description), and in every non-source
 * locale that was never translated, the source title copied verbatim. The
 * translation step refills the emptied slots from the source text; a real
 * translation (description present in that locale) keeps its title.
 */
export function scrubLombardiLegacyLocaleCopies(job = {}) {
  const sourceLang = job.sourceLang;
  const descriptionByLocale = { ...(job.descriptionByLocale || {}) };
  for (const [locale, value] of Object.entries(descriptionByLocale)) {
    if (isLombardiLegacyBlurb(value)) delete descriptionByLocale[locale];
  }
  const sourceTitle = String(job.titleByLocale?.[sourceLang] || job.title || '').trim();
  const titleByLocale = { ...(job.titleByLocale || {}) };
  for (const [locale, value] of Object.entries(titleByLocale)) {
    if (locale === sourceLang) continue;
    if (String(value || '').trim() === sourceTitle && !descriptionByLocale[locale]) delete titleByLocale[locale];
  }
  const out = { ...job, titleByLocale, descriptionByLocale };
  if (isLombardiLegacyBlurb(out.description)) out.description = descriptionByLocale[sourceLang] || '';
  return out;
}
