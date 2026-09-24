/**
 * Giardino Group job parser — microsito «Giardino Talents».
 *
 * Dal 2026-09 le offerte non sono più nel post type WordPress `jobs`
 * (`/wp-json/wp/v2/jobs` risponde `[]`, `/giardino-group/jobs/` reindirizza
 * alla home): vivono nel microsito statico https://giardinohotels.ch/talents/
 * — una `a.job-card` per vacancy nella sezione `#stellen`, e una pagina
 * `job-*.html` per vacancy con JSON-LD JobPosting e le sezioni #aboutthejob /
 * #aboutyou / #talentculture. Il crawler leggeva ancora l'API vuota e
 * pubblicava zero da tre run (crawler-health-monitor: giardino broken).
 * Le note sotto sul formato WordPress restano per gli helper ancora esportati.
 *
 * Giardino Group operates luxury hotels in Switzerland:
 *   - Giardino Mountain (Champfèr / St. Moritz, GR)
 *   - Giardino Ascona (Ascona, TI)
 *   - Giardino Lago (Minusio / Locarno, TI)
 *
 * Formato del vecchio post type WordPress (solo per gli helper WP esportati):
 * Content structure per job (German):
 *   <div id="introduction">
 *     <h3>#aboutus</h3>         — company boilerplate (skip)
 *     <p>...suchen wir...eine/n:</p>
 *     <h1>TITLE</h1>
 *     <h3>#aboutthejob</h3>     — role description
 *   </div>
 *   <div id="tasks">
 *     <h3>#aboutyou</h3>        — requirements list
 *   </div>
 *   <div id="benefits">
 *     <h3>#talentculture</h3>   — benefits list
 *     <h3>Kontakt</h3>          — contact (skip)
 *   </div>
 *
 * Source: https://giardinohotels.ch/talents/
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { fetchHtml } from './hospital-custom-html-helpers.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GIARDINO_KEY = 'giardino';
export const GIARDINO_COMPANY_NAME = 'Giardino Group';
export const GIARDINO_COMPANY_DOMAIN = 'giardinohotels.ch';

const SITE_BASE = 'https://giardinohotels.ch';
// Listing tedesco del microsito Talents: il tedesco è la lingua sorgente.
const TALENTS_URL = `${SITE_BASE}/talents/`;

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
  const text = String(contentHtml || '').toLowerCase();

  // Check content text for hotel name patterns
  if (/giardino\s+mountain/i.test(text)) return 'mountain';
  if (/giardino\s+lago/i.test(text)) return 'lago';
  if (/giardino\s+ascona/i.test(text)) return 'ascona';

  // Check for city mentions in "suchen wir" context
  if (/in\s+champf[eè]r/i.test(text) || /st\.?\s*moritz/i.test(text)) return 'mountain';
  if (/in\s+minusio/i.test(text) || /minusio.?locarno/i.test(text)) return 'lago';
  if (/in\s+ascona/i.test(text)) return 'ascona';

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
  const html = String(contentHtml || '');

  const sections = {
    aboutJob: '',
    aboutYou: [],
    talentCulture: [],
  };

  // Extract #aboutthejob section — text between #aboutthejob and next h3 or div
  const aboutJobMatch = html.match(
    /#aboutthejob<\/h3>\s*([\s\S]*?)(?=<h3|<\/div>)/i,
  );
  if (aboutJobMatch) {
    sections.aboutJob = normalizeSpace(stripHtml(aboutJobMatch[1]));
  }

  // Extract #aboutyou items — list items after #aboutyou
  const aboutYouMatch = html.match(
    /#aboutyou<\/h3>\s*([\s\S]*?)(?=<\/div>|<h3)/i,
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
    /#talentculture<\/h3>\s*([\s\S]*?)(?=<h3|<\/div>)/i,
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

/* ── Build English public URL ─────────────────────────────── */

/**
 * Build the English public URL for a job from its ENGLISH WordPress slug.
 *
 * Only safe with a slug that exists in the English listing: WPML gives each
 * translation its own slug (`staff-cook-m-w` in German, `staff-cook-m-f` in
 * English), and /en/jobs/{german-slug}/ answers 200 with the site HOMEPAGE,
 * not the job — a silently dead apply link. Use resolvePublicUrl().
 */
export function buildEnglishUrl(enSlug) {
  // locale-segment-ok: permalink WPML del sito esterno, lo slug stesso è quello della versione inglese
  return `${SITE_BASE}/en/jobs/${enSlug}/`;
}

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
 * post is translated, otherwise the German permalink the API itself returned
 * (always a real page). Never a slug pasted into the /en/ path.
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
  // locale-segment-ok: fallback al permalink TEDESCO del sito esterno, dove vive lo slug non tradotto
  return wpSlug ? `${SITE_BASE}/de/jobs/${wpSlug}/` : `${SITE_BASE}/de/jobs/`;
}

/* ── Microsito Talents ──────────────────────────────────────── */

/** `data-loc` delle job-card → hotel del gruppo. */
const TALENTS_LOC_HOTEL = {
  stmoritz: 'mountain',
  champfer: 'mountain',
  ascona: 'ascona',
  lago: 'lago',
  locarno: 'lago',
  minusio: 'lago',
};

/** Località pubblicata per hotel, come la fonte la scrive nel badge/JSON-LD. */
const TALENTS_HOTEL_LABEL_RX = {
  mountain: /moritz|champf/i,
  ascona: /ascona/i,
  lago: /locarno|minusio|lago/i,
};

function decodeHtmlText(value = '') {
  return normalizeSpace(decodeWpEntities(stripHtml(String(value || '')).replace(/&nbsp;|&#160;/g, ' ')));
}

/**
 * Job-card della sezione `#stellen` del listing Talents.
 *
 * @param {string} html
 * @param {string} [baseUrl]
 * @returns {{ title: string, url: string, slug: string, locKeys: string[], locationLabel: string, department: string }[]}
 */
export function parseTalentsListing(html = '', baseUrl = TALENTS_URL) {
  const out = [];
  const seen = new Set();
  const cardRx = /<a\b([^>]*\bclass="[^"]*\bjob-card\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = cardRx.exec(String(html || '')))) {
    const attrs = match[1];
    const body = match[2];
    const href = attrs.match(/\bhref="([^"]+)"/i)?.[1] || '';
    if (!/(?:^|\/)job-[^/]+\.html$/i.test(href)) continue;
    let url;
    try { url = new URL(href, baseUrl).href; } catch { continue; }
    if (!isTrustedDomain(url) || seen.has(url)) continue;
    const title = decodeHtmlText(body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || '');
    if (!title) continue;
    seen.add(url);
    out.push({
      title,
      url,
      slug: url.split('/').pop().replace(/\.html$/i, ''),
      locKeys: (attrs.match(/\bdata-loc="([^"]*)"/i)?.[1] || '').split(/\s+/).filter(Boolean),
      locationLabel: decodeHtmlText(body.match(/class="job-badge loc"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''),
      department: decodeHtmlText(body.match(/class="job-badge dep"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''),
    });
  }
  return out;
}

/** Testo del paragrafo/lista che segue l'intestazione `#<hash>` di una sezione. */
function talentsSection(html, hash) {
  const rx = new RegExp(`<span class="hash">#<\\/span>${hash}<\\/h2>([\\s\\S]*?)(?=<h2\\b|<\\/aside>|<\\/section>)`, 'i');
  return rx.exec(html)?.[1] || '';
}

function listItems(html = '') {
  const items = [];
  const liRx = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRx.exec(html))) {
    const text = normalizeDescriptionSpace(decodeHtmlText(m[1]));
    if (text.length > 2) items.push(text);
  }
  return items;
}

/**
 * Pagina `job-*.html` del microsito. Il titolo è l'H1: il JSON-LD della fonte
 * riusa a volte quello di un'altra vacancy (la pagina Night Auditor dichiara
 * «Chef de Partie», misurato il 2026-09-24), quindi dal JSON-LD si leggono solo
 * tipo d'impiego, data e località.
 *
 * @param {string} html
 */
export function parseTalentsDetail(html = '') {
  const src = String(html || '');
  let jsonLd = {};
  for (const block of src.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const node = JSON.parse(block[1]);
      if (node?.['@type'] === 'JobPosting') { jsonLd = node; break; }
    } catch { /* blocco non valido: si ignora */ }
  }
  return {
    title: decodeHtmlText(src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''),
    intro: decodeHtmlText(src.match(/<p class="intro"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ''),
    locationLabel: normalizeSpace(jsonLd?.jobLocation?.address?.addressLocality || '')
      || decodeHtmlText(src.match(/class="job-badge loc"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''),
    employmentType: normalizeSpace(jsonLd?.employmentType || '').toUpperCase(),
    postedDate: /^\d{4}-\d{2}-\d{2}/.test(String(jsonLd?.datePosted || '')) ? String(jsonLd.datePosted).slice(0, 10) : '',
    sections: {
      aboutJob: decodeHtmlText(talentsSection(src, 'aboutthejob')),
      aboutYou: listItems(talentsSection(src, 'aboutyou')),
      talentCulture: listItems(talentsSection(src, 'talentculture')),
    },
  };
}

/**
 * Hotel e località pubblicata di una vacancy Talents. Un solo hotel nella
 * card decide da sé; una vacancy stagionale su due hotel (`Ascona · St.
 * Moritz`) prende l'hotel della frase d'apertura («Für unser Power Retreat
 * Giardino Mountain in Champfèr-St.Moritz …»), dove si inizia. La località è
 * quella che la fonte scrive (`St. Moritz`, `Ascona`), non un default.
 */
export function resolveTalentsLocation(locKeys = [], locationLabel = '', intro = '') {
  const hotels = [...new Set(locKeys.map((key) => TALENTS_LOC_HOTEL[String(key).toLowerCase()]).filter(Boolean))];
  const detected = detectHotel(intro);
  const hotelKey = hotels.length === 1
    ? hotels[0]
    : (hotels.includes(detected) ? detected : (hotels[0] || detected));
  const labels = String(locationLabel || '').split(/\s*[·|,/]\s*/).map((part) => part.trim()).filter(Boolean);
  const city = labels.find((label) => TALENTS_HOTEL_LABEL_RX[hotelKey]?.test(label))
    || labels[0]
    || getHotelLocation(hotelKey).city;
  return { hotelKey, city, canton: inferAnyCanton(city) || getHotelLocation(hotelKey).canton };
}

/* ── Main Fetch ───────────────────────────────────────────── */

/**
 * Fetch all Giardino Group jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGiardinoJobs() {
  console.log('🔍 Fetching Giardino Group jobs');
  console.log(`   Source: ${TALENTS_URL}\n`);

  const listingHtml = await fetchHtml(TALENTS_URL);
  const listings = parseTalentsListing(listingHtml, TALENTS_URL);
  if (listings.length === 0) {
    console.warn('⚠️ No job cards found on the Giardino Talents listing.');
    return [];
  }
  console.log(`  📋 Talents job cards found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    let detail;
    try {
      detail = parseTalentsDetail(await fetchHtml(listing.url));
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
      continue;
    }
    const title = normalizeSpace(detail.title || listing.title);
    if (!title || title.length < 3) continue;

    const { hotelKey, city, canton } = resolveTalentsLocation(
      listing.locKeys,
      detail.locationLabel || listing.locationLabel,
      detail.intro,
    );
    if (!canton) {
      console.warn(`  ⏭️  ${title}: no Swiss canton for "${city}" — skipping`);
      continue;
    }
    const description = buildDescription(detail.sections, title, hotelKey, city);
    const idHash = createHash('sha1').update(`talents-${listing.slug}`).digest('hex').slice(0, 12);
    const sourceLang = 'de';
    const jobSlug = slugify(`${title} giardino-group ${city}`);
    const employmentType = ['FULL_TIME', 'PART_TIME', 'TEMPORARY', 'CONTRACTOR', 'INTERN'].includes(detail.employmentType)
      ? detail.employmentType
      : 'FULL_TIME';

    jobs.push({
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
      // La pagina tedesca: l'alternate EN della fonte può puntare a un'altra
      // vacancy (Night Auditor → `en/job-chef-de-partie-kopie.html`).
      url: listing.url,
      source: 'Giardino Group Dedicated Parser (Talents)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ospitalità / Hotellerie',
      currency: 'CHF',
      featured: false,
      postedDate: detail.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: listing.url,
      requirements: detail.sections.aboutYou,
      requirementsByLocale: { [sourceLang]: detail.sections.aboutYou },
    });
  }

  console.log(`\n📋 Total Giardino Group jobs discovered: ${jobs.length}`);
  return jobs;
}
