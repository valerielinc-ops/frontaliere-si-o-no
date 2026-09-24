/**
 * Giardino Group job parser — "Giardino Talents" static career microsite.
 *
 * Giardino Group operates luxury hotels in Switzerland:
 *   - Giardino Mountain (Champfèr / St. Moritz, GR)
 *   - Giardino Ascona (Ascona, TI)
 *   - Giardino Lago (Minusio / Locarno, TI)
 *
 * SOURCE MOVE (issue #6694, observed 2026-09-24). The vacancies used to be a
 * WordPress "jobs" post type read from /wp-json/wp/v2/jobs. That route now
 * answers `[]` with `X-WP-Total: 0` in every locale and the old career page
 * /en/giardino-group/jobs/ 301-redirects to the homepage, while the homepage's
 * career links point at a static microsite, /talents/, that lists the open
 * positions. Reading the empty REST route made every run abort on
 * `no-jobs-parsed` although the source was full.
 *
 * Listing (German = source locale, /talents/; English, /talents/en/):
 *   <!--JOBS-START-->
 *   <a class="job-card" data-job data-loc="ascona stmoritz" data-dep="service"
 *      href="job-restaurant-manager.html"> … <h3>TITLE (m/w)</h3> … </a>
 *   <!--JOBS-ENDE-->
 *   plus a rendered total: <strong id="jobs-count">N</strong>.
 *
 * Detail page (job-*.html): <h1>TITLE (m/w)</h1>, <p class="intro"> naming the
 * hotel, the same #aboutthejob / #aboutyou / #talentculture sections the
 * WordPress content used, and a JSON-LD JobPosting (datePosted). The JSON-LD
 * `title` is NOT unique (two different ads are both "Chef de Rang"), so the
 * title comes from the <h1>.
 *
 * Location is derived from the intro text ("Giardino {Mountain|Ascona|Lago}",
 * city mentions) and, failing that, from the card's `data-loc` keys.
 *
 * Source: https://giardinohotels.ch/talents/
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace, fetchHtml } from './crawler-template.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GIARDINO_KEY = 'giardino';
export const GIARDINO_COMPANY_NAME = 'Giardino Group';
export const GIARDINO_COMPANY_DOMAIN = 'giardinohotels.ch';

const SITE_BASE = 'https://giardinohotels.ch';
/** German (source-locale) board of the Giardino Talents microsite. */
export const TALENTS_URL = `${SITE_BASE}/talents/`;
// The English board lists the same ads under its own file names (the German
// `job-night-auditor.html` is `job-chef-de-partie-kopie.html` in English) —
// the only place the real English permalink can be read from.
// locale-segment-ok: sottocartella lingua del microsito ESTERNO giardinohotels.ch/talents, non un path per-locale nostro
export const TALENTS_EN_URL = `${SITE_BASE}/talents/en/`;

/* ── Hotel → location mapping ─────────────────────────────── */

/**
 * Giardino operates 3 hotels. The WP categories and content text
 * identify which hotel a job belongs to.
 */
const HOTEL_LOCATIONS = {
  mountain: { city: 'Champfèr', canton: 'GR', postalCode: '7512' },
  ascona:   { city: 'Ascona',   canton: 'TI', postalCode: '6612' },
  lago:     { city: 'Minusio',  canton: 'TI', postalCode: '6648' },
};

/** WordPress category IDs for resort locations */
const CATEGORY_RESORT = {
  674: 'ascona',   // Ascona
  676: 'lago',     // Locarno → Giardino Lago in Minusio
};

/* ── Helpers ───────────────────────────────────────────────── */


/**
 * Decode WordPress HTML entities in title.rendered.
 */
export function decodeWpEntities(raw = '') {
  return String(raw || '')
    .replace(/&#8211;/g, '\u2013')  // en-dash
    .replace(/&#8212;/g, '\u2014')  // em-dash
    .replace(/&#8216;/g, '\u2018')  // left single quote
    .replace(/&#8217;/g, '\u2019')  // right single quote
    .replace(/&#8220;/g, '\u201C')  // left double quote
    .replace(/&#8221;/g, '\u201D')  // right double quote
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\/g, '')
    .trim();
}

/* ── Hotel Detection ──────────────────────────────────────── */

/**
 * Detect which Giardino hotel a job belongs to from content text
 * and WordPress category IDs.
 *
 * Priority: content text mention > WP category > default (Champfèr).
 */
export function detectHotel(contentHtml = '', categoryIds = []) {
  const fromText = detectHotelFromText(contentHtml);
  if (fromText) return fromText;

  // Fallback to WordPress categories
  const cats = Array.isArray(categoryIds) ? categoryIds : [];
  for (const catId of cats) {
    const hotel = CATEGORY_RESORT[catId];
    if (hotel) return hotel;
  }

  // Default: company HQ in Champfèr
  return 'mountain';
}

/**
 * Hotel named by the text itself, or null when the text names none — unlike
 * detectHotel(), which always answers (default: Champfèr), so a caller can
 * still consult a second signal.
 */
export function detectHotelFromText(contentHtml = '') {
  const text = String(contentHtml || '').toLowerCase();

  // Check content text for hotel name patterns
  if (/giardino\s+mountain/i.test(text)) return 'mountain';
  if (/giardino\s+lago/i.test(text)) return 'lago';
  if (/giardino\s+ascona/i.test(text)) return 'ascona';

  // Check for city mentions in "suchen wir" context
  if (/in\s+champf[eè]r/i.test(text) || /st\.?\s*moritz/i.test(text)) return 'mountain';
  if (/in\s+minusio/i.test(text) || /minusio.?locarno/i.test(text)) return 'lago';
  if (/in\s+ascona/i.test(text)) return 'ascona';

  return null;
}

/** Talents-card `data-loc` keys → hotel. */
const LOC_KEY_HOTEL = {
  stmoritz: 'mountain',
  champfer: 'mountain',
  mountain: 'mountain',
  ascona: 'ascona',
  locarno: 'lago',
  minusio: 'lago',
  lago: 'lago',
};

/**
 * Hotel of a Talents ad: the detail page's intro text first (it names the
 * hotel, "…im Hotel Giardino Mountain in Champfèr-St.Moritz…"), then the
 * card's `data-loc` keys, then the company HQ.
 */
export function detectTalentsHotel(introText = '', locKeys = []) {
  const fromText = detectHotelFromText(introText);
  if (fromText) return fromText;
  for (const key of Array.isArray(locKeys) ? locKeys : []) {
    const hotel = LOC_KEY_HOTEL[String(key || '').toLowerCase()];
    if (hotel) return hotel;
  }
  return 'mountain';
}

/**
 * Get location details for a detected hotel.
 */
export function getHotelLocation(hotelKey) {
  return HOTEL_LOCATIONS[hotelKey] || HOTEL_LOCATIONS.mountain;
}

/* ── Content Parsing ──────────────────────────────────────── */

/**
 * Extract the clean job title from the <h1> inside content HTML.
 * WordPress title.rendered often includes "(m/w)" and hotel prefixes
 * like "gl-" or "ga-"; the <h1> in content has the clean title.
 */
export function extractH1Title(contentHtml = '') {
  const match = String(contentHtml || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? normalizeSpace(stripHtml(match[1])) : '';
}

/**
 * Parse the WordPress content HTML into structured sections.
 *
 * Returns { aboutJob, aboutYou, talentCulture } with plain text content.
 */
export function parseContentSections(contentHtml = '') {
  // The Talents microsite renders the hash as its own element inside an <h2>
  // (`<h2 class="detail-h"><span class="hash">#</span>aboutyou</h2>`), the
  // WordPress content as plain text in an <h3>. Fold the first shape into the
  // second so one set of section patterns reads both.
  const html = String(contentHtml || '')
    .replace(/<span[^>]*>\s*#\s*<\/span>\s*/gi, '#')
    .replace(/(#(?:aboutthejob|aboutyou|talentculture))\s*<\/h[1-6]>/gi, '$1</h3>');

  const sections = {
    aboutJob: '',
    aboutYou: [],
    talentCulture: [],
  };

  // Extract #aboutthejob section — text between #aboutthejob and next h3 or div
  const aboutJobMatch = html.match(
    /#aboutthejob<\/h3>\s*([\s\S]*?)(?=<h[23]|<\/div>)/i,
  );
  if (aboutJobMatch) {
    sections.aboutJob = normalizeSpace(stripHtml(aboutJobMatch[1]));
  }

  // Extract #aboutyou items — list items after #aboutyou
  const aboutYouMatch = html.match(
    /#aboutyou<\/h3>\s*([\s\S]*?)(?=<\/div>|<h[23])/i,
  );
  if (aboutYouMatch) {
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(aboutYouMatch[1])) !== null) {
      const text = normalizeDescriptionSpace(stripHtml(m[1]));
      if (text.length > 2) sections.aboutYou.push(text);
    }
  }

  // Extract #talentculture items — list items after #talentculture
  const cultureMatch = html.match(
    /#talentculture<\/h3>\s*([\s\S]*?)(?=<h[23]|<\/div>)/i,
  );
  if (cultureMatch) {
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(cultureMatch[1])) !== null) {
      const text = normalizeDescriptionSpace(stripHtml(m[1]));
      if (text.length > 2) sections.talentCulture.push(text);
    }
  }

  return sections;
}

/**
 * Build a structured markdown description from parsed sections.
 */
export function buildDescription(sections, title, hotelKey, city) {
  const hotelNames = {
    mountain: 'Giardino Mountain',
    ascona: 'Giardino Ascona',
    lago: 'Giardino Lago',
  };
  const hotelName = hotelNames[hotelKey] || 'Giardino Group';

  const parts = [];

  // Intro
  parts.push(
    `Giardino Group sucht für das ${hotelName} in ${city} eine/n ${title}. Die Giardino Hotels sind eine charaktervolle Schweizer Luxushotelgruppe mit Standorten in St. Moritz, Ascona und Locarno.`,
  );

  // Job description
  if (sections.aboutJob) {
    parts.push(`\n## Aufgaben\n${sections.aboutJob}`);
  }

  // Requirements
  if (sections.aboutYou.length > 0) {
    parts.push(
      `\n## Anforderungen\n${sections.aboutYou.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  // Benefits
  if (sections.talentCulture.length > 0) {
    parts.push(
      `\n## Benefits\n${sections.talentCulture.map((b) => `- ${b}`).join('\n')}`,
    );
  }

  return parts.join('\n').trim();
}

/* ── Category Detection (hospitality-specific) ────────────── */

function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(koch|küche|chef|partie|cuisine|cook|steward|kitchen)/.test(t)) return 'Cucina / Gastronomia';
  if (/\b(service|kellner|waiter|waitress|sommelier|barkeeper|bar)/.test(t)) return 'Servizio';
  if (/\b(rezeption|reception|front.?desk|concierge|guest.?relation)/.test(t)) return 'Reception';
  if (/\b(housekeep|zimmer|reinigung|clean|room.?attend|gouvernant)/.test(t)) return 'Housekeeping';
  if (/\b(spa|wellness|massage|therap|beauty|fitness)/.test(t)) return 'Spa / Wellness';
  if (/\b(child|kinder|betreu|nanny|animat)/.test(t)) return 'Kinderbetreuung';
  if (/\b(techni|haustechni|maintenance|facilit|engineer)/.test(t)) return 'Technik';
  if (/\b(admin|buchhalt|account|finanz|hr|personal)/.test(t)) return 'Amministrazione';
  if (/\b(market|sales|verkauf|event|revenue)/.test(t)) return 'Marketing / Vendite';
  return 'Ospitalità';
}

function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Giardino Group.
 */
export function isGiardinoJob(job) {
  if (!job) return false;
  const key = String(job?.companyKey || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').trim().toLowerCase();
  const url = String(job?.url || '').trim().toLowerCase();

  return (
    key === GIARDINO_KEY ||
    key.startsWith('giardino') ||
    company.includes('giardino group') ||
    company.includes('giardino hotel') ||
    url.includes('giardinohotels.ch')
  );
}

/**
 * Validate that a URL belongs to Giardino Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'giardinohotels.ch' || host.endsWith('.giardinohotels.ch');
  } catch {
    return false;
  }
}

/* ── English public URL ─────────────────────────────────── */

/**
 * Normalize a job title into a translation-agnostic match key.
 *
 * The German and English versions of the same post differ only in the gender
 * marker ("Steward (m/w)" vs "Steward (m/f)"), so that marker must not defeat
 * the match; everything else in these titles is already English.
 */
export function jobTitleKey(raw = '') {
  return decodeWpEntities(raw)
    .toLowerCase()
    .replace(/\(\s*[mwfd](?:\s*\/\s*[mwfd])*\s*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Index the English listing by slug and by title key, so a German listing can
 * find its own translation. Title keys that are not unique are dropped: two
 * jobs sharing a normalized title cannot be told apart, and a wrong apply link
 * is worse than a German one.
 *
 * The uniqueness check is BILATERAL, hence `deListings`. Slugs carry a hotel
 * prefix (`gm-steward`, `gl-steward-m-w`) but titles do not, so two GERMAN ads
 * for the same role in different hotels collapse onto one title key. If only
 * one of them is translated, both would match that single English link and the
 * apply link of the untranslated one would point at ANOTHER hotel's job — the
 * exact "wrong apply link" this index exists to avoid. A key ambiguous on
 * either side is dropped; the exact-slug lookup is unaffected.
 */
export function buildEnglishIndex(enListings = [], deListings = []) {
  const bySlug = new Map();
  const byTitle = new Map();
  const ambiguous = new Set();

  for (const item of Array.isArray(enListings) ? enListings : []) {
    const slug = String(item?.slug || '').trim();
    const link = String(item?.link || '').trim();
    if (!slug || !link || !isTrustedDomain(link)) continue;
    bySlug.set(slug, link);

    const key = jobTitleKey(item?.title?.rendered || '');
    if (!key) continue;
    if (byTitle.has(key)) ambiguous.add(key);
    else byTitle.set(key, link);
  }
  for (const key of ambiguous) byTitle.delete(key);

  // Lato tedesco: conta le occorrenze di ogni title-key e scarta quelle ripetute.
  const deCounts = new Map();
  for (const item of Array.isArray(deListings) ? deListings : []) {
    const key = jobTitleKey(item?.title?.rendered || '');
    if (!key) continue;
    deCounts.set(key, (deCounts.get(key) || 0) + 1);
  }
  for (const [key, count] of deCounts) {
    if (count > 1) byTitle.delete(key);
  }

  return { bySlug, byTitle };
}

/**
 * Resolve the public URL of a German listing: its English permalink when the
 * ad is translated, otherwise the German permalink the board itself linked
 * (always a real page). Never a German file name pasted into the English path.
 */
export function resolvePublicUrl(listing, enIndex) {
  const wpSlug = String(listing?.slug || '').trim();
  const bySlug = enIndex?.bySlug instanceof Map ? enIndex.bySlug : new Map();
  const byTitle = enIndex?.byTitle instanceof Map ? enIndex.byTitle : new Map();

  const bySlugHit = wpSlug ? bySlug.get(wpSlug) : '';
  if (bySlugHit) return bySlugHit;

  const byTitleHit = byTitle.get(jobTitleKey(listing?.title?.rendered || ''));
  if (byTitleHit) return byTitleHit;

  const deLink = String(listing?.link || '').trim();
  if (deLink && isTrustedDomain(deLink)) return deLink;
  // The German board is the microsite root: a file name resolves against it.
  return wpSlug ? new URL(wpSlug, TALENTS_URL).href : TALENTS_URL;
}

/* ── Talents microsite parsing ────────────────────────────── */

const JOB_FILE_RE = /^job-[a-z0-9][a-z0-9-]*\.html$/i;
const GENDER_MARKER_RE = /\(\s*[mwfd](?:\s*\/\s*[mwfd])*\s*\)/gi;

function readAttr(openTag = '', name = '') {
  const match = String(openTag).match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match ? match[1] : null;
}

/** Drop the gender marker ("(m/w)", "(m/f)", "(w/m/d)") from an ad title. */
export function stripGenderMarker(raw = '') {
  return normalizeSpace(String(raw || '').replace(GENDER_MARKER_RE, ' '));
}

/**
 * Parse a Talents board (German or English).
 *
 * `recognized` is true only when the page carries the JOBS-START/JOBS-END
 * block the board is rendered into: a page without it (a redirect to the
 * homepage, a redesign) is not a board and says nothing about the vacancies.
 * `declaredCount` is the rendered total (`id="jobs-count"`), or null.
 * `rawCardCount` counts every tag inside the JOBS block that LOOKS like a card
 * (a `job-card` class token, a `data-job` attribute or a `job-*.html` link),
 * whether or not it parsed: `cards` drops malformed ones, so an empty `cards`
 * alone cannot prove an empty board.
 *
 * @returns {{ recognized: boolean, declaredCount: number|null, rawCardCount: number,
 *   cards: Array<{ file: string, url: string, rawTitle: string, title: string,
 *   locKeys: string[], department: string }> }}
 */
export function parseTalentsListing(html = '', baseUrl = TALENTS_URL) {
  const page = String(html || '');
  const countMatch = page.match(/id="jobs-count"[^>]*>\s*(\d+)\s*</i);
  const declaredCount = countMatch ? Number(countMatch[1]) : null;

  const start = page.indexOf('<!--JOBS-START-->');
  const endMatch = start >= 0 ? /<!--\s*JOBS-END[A-Z]*\s*-->/i.exec(page.slice(start)) : null;
  if (start < 0 || !endMatch) return { recognized: false, declaredCount, rawCardCount: 0, cards: [] };

  const block = page.slice(start, start + endMatch.index);
  const rawCardCount = (
    block.match(/<[a-z][^>]*(?:\bjob-card\b|\sdata-job\b|href\s*=\s*"[^"]*job-[^"]*\.html)[^>]*>/gi) || []
  ).length;
  const cards = [];
  const seen = new Set();
  const cardRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = cardRe.exec(block)) !== null) {
    const openTag = match[1];
    const classes = String(readAttr(openTag, 'class') || '').split(/\s+/);
    if (!classes.includes('job-card')) continue;

    const file = String(readAttr(openTag, 'href') || '').trim();
    if (!JOB_FILE_RE.test(file) || seen.has(file)) continue;
    const url = new URL(file, baseUrl).href;
    if (!isTrustedDomain(url)) continue;

    const h3 = match[2].match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const rawTitle = h3 ? decodeWpEntities(normalizeSpace(stripHtml(h3[1]))) : '';
    const title = stripGenderMarker(rawTitle);
    if (!title || title.length < 3) continue;

    seen.add(file);
    cards.push({
      file,
      url,
      rawTitle,
      title,
      locKeys: String(readAttr(openTag, 'data-loc') || '').split(/\s+/).filter(Boolean),
      department: String(readAttr(openTag, 'data-dep') || '').trim(),
    });
  }
  return { recognized: true, declaredCount, rawCardCount, cards };
}

function findJobPosting(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findJobPosting(item);
      if (hit) return hit;
    }
    return null;
  }
  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
  return findJobPosting(node['@graph']);
}

/**
 * Parse a Talents job page. Returns null when the page carries no JobPosting
 * JSON-LD: an unknown job-*.html answers 301 to the board, and the board is
 * not an ad.
 *
 * @returns {null|{ title: string, intro: string, datePosted: string,
 *   sections: ReturnType<typeof parseContentSections> }}
 */
export function parseTalentsJobPage(html = '') {
  const page = String(html || '');
  let posting = null;
  const ldRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while (!posting && (match = ldRe.exec(page)) !== null) {
    try {
      posting = findJobPosting(JSON.parse(match[1]));
    } catch {
      // A malformed block is not proof of anything; keep looking.
    }
  }
  if (!posting) return null;

  const title = stripGenderMarker(decodeWpEntities(extractH1Title(page)))
    || stripGenderMarker(decodeWpEntities(String(posting.title || '')));
  const introMatch = page.match(/<p[^>]*class="[^"]*\bintro\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const datePosted = String(posting.datePosted || '').slice(0, 10);

  return {
    title,
    intro: introMatch ? normalizeSpace(stripHtml(introMatch[1])) : '',
    datePosted: /^\d{4}-\d{2}-\d{2}$/.test(datePosted) ? datePosted : '',
    sections: parseContentSections(page),
  };
}

/** A board card in the shape buildEnglishIndex()/resolvePublicUrl() read. */
function toIndexItem(card) {
  return { slug: card.file, link: card.url, title: { rendered: card.rawTitle } };
}

/** Thin-content floor (AGENTS.md non-negotiable #4: no indexed page under 50 words). */
export const MIN_DESCRIPTION_WORDS = 50;

function countWords(text = '') {
  return String(text || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/* ── Fetch ────────────────────────────────────────────────── */

function fetchTalentsPage(url) {
  return fetchHtml(url, { timeoutMs: Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000 });
}

/**
 * Fetch the English board, used only to resolve permalinks. A failure here
 * degrades the apply links to their German permalink — it must never fail the
 * crawl, since the German board is the source of truth for the jobs.
 */
async function fetchEnglishCards(fetchPage) {
  try {
    const listing = parseTalentsListing(await fetchPage(TALENTS_EN_URL), TALENTS_EN_URL);
    return listing.cards;
  } catch (err) {
    console.warn(`⚠️ English Talents board unavailable (${err?.message || err}) — falling back to German permalinks.`);
    return [];
  }
}

/* ── Main Fetch ───────────────────────────────────────────── */

/**
 * Fetch all Giardino Group jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * A zero is published only when the board itself proves it (rendered
 * `jobs-count` 0 and no card-like tag in the JOBS block): an unrecognised
 * page, or a board whose cards do not parse, returns a bare `[]` so the
 * pipeline keeps the previous slice and the health monitor keeps complaining.
 *
 * An ad is emitted only with its detail page read and a description of at
 * least MIN_DESCRIPTION_WORDS words. A card alone yields a thin page, so an ad
 * whose detail is unavailable is left out of this run: the pipeline's miss
 * grace keeps its previous record, and the other ads are still published.
 *
 * @param {{ fetchPage?: (url: string) => Promise<string> }} [options] page
 *   fetcher, injectable for tests; defaults to the shared fetchHtml().
 */
export async function fetchAllGiardinoJobs({ fetchPage = fetchTalentsPage } = {}) {
  console.log('🔍 Fetching Giardino Group jobs');
  console.log(`   Source: ${TALENTS_URL}\n`);

  const listing = parseTalentsListing(await fetchPage(TALENTS_URL), TALENTS_URL);
  if (!listing.recognized) {
    console.warn('⚠️ Giardino Talents board not recognised (no JOBS-START/JOBS-END block) — keeping the previous slice.');
    return [];
  }
  if (listing.cards.length === 0) {
    // Proven only when the rendered count is 0 AND the raw block holds no
    // card-like tag at all: a card the parser failed to read is not an empty
    // board, and publishing a zero on it would retire every live ad.
    if (listing.declaredCount === 0 && listing.rawCardCount === 0) {
      console.log('  📭 Giardino Talents board declares 0 open positions.');
      return markAuthoritativeEmptySnapshot(
        [],
        `Giardino Talents board ${TALENTS_URL}: jobs-count=0 and an empty JOBS-START/JOBS-END block`,
      );
    }
    console.warn(
      `⚠️ Giardino Talents board declares ${listing.declaredCount ?? 'an unknown number of'} positions`
      + ` (${listing.rawCardCount} card-like tags) but no job card parsed — keeping the previous slice.`,
    );
    return [];
  }

  console.log(`  📋 Talents job cards found: ${listing.cards.length}`);
  if (listing.declaredCount != null && listing.declaredCount !== listing.cards.length) {
    console.warn(`⚠️ Board declares ${listing.declaredCount} positions, parsed ${listing.cards.length} cards.`);
  }

  const enIndex = buildEnglishIndex((await fetchEnglishCards(fetchPage)).map(toIndexItem), listing.cards.map(toIndexItem));
  console.log(`  🌐 English permalinks available: ${enIndex.bySlug.size}`);

  const jobs = [];
  for (const card of listing.cards) {
    // Detail page — required: without it the ad would be a thin card-only
    // page. Skip it this run; miss grace keeps the previous record.
    let detail = null;
    try {
      detail = parseTalentsJobPage(await fetchPage(card.url));
    } catch (err) {
      console.warn(`⚠️ ${card.url}: detail page unavailable (${err?.message || err}).`);
    }
    if (!detail) {
      console.warn(`⚠️ ${card.url}: no JobPosting on the detail page — ad skipped this run.`);
      continue;
    }

    // Clean title from the detail <h1>, fallback to the card title
    const title = normalizeSpace(detail.title || card.title);
    if (!title || title.length < 3) continue;

    // Detect hotel and location
    const hotelKey = detectTalentsHotel(detail.intro, card.locKeys);
    const loc = getHotelLocation(hotelKey);
    const city = loc.city;
    const canton = loc.canton;
    const postalCode = loc.postalCode;

    // Parsed content sections
    const sections = detail.sections;

    // Build structured description
    const description = buildDescription(sections, title, hotelKey, city);
    if (countWords(description) < MIN_DESCRIPTION_WORDS) {
      console.warn(`⚠️ ${card.url}: description under ${MIN_DESCRIPTION_WORDS} words — ad skipped this run.`);
      continue;
    }

    // Public URL — English permalink when translated, German one otherwise
    const publicUrl = resolvePublicUrl(toIndexItem(card), enIndex);

    // Stable ID from the German file name — the board's only per-ad identifier
    const idHash = createHash('sha1')
      .update(`talents-${card.file}`)
      .digest('hex')
      .slice(0, 12);

    const sourceLang = 'de'; // Content is always in German
    const jobSlug = slugify(`${title} giardino-group ${city}`);

    // Posted date from the JobPosting JSON-LD
    const postedDate = detail.datePosted || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `giardino-${idHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GIARDINO_COMPANY_NAME,
      companyKey: GIARDINO_KEY,
      companyDomain: GIARDINO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Giardino Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      postalCode,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ospitalità / Hotellerie',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: sections.aboutYou,
      requirementsByLocale: { [sourceLang]: sections.aboutYou },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Giardino Group jobs discovered: ${jobs.length}`);
  return jobs;
}
