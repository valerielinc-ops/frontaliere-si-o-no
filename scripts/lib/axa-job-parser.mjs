import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * AXA Svizzera — Prospective.ch Career Center parser
 *
 * AXA Svizzera is a national insurer (HQ Winterthur), so the crawler collects
 * jobs CH-wide across all 26 cantons — NOT filtered to any region. Per-job
 * canton is inferred from the listing's clean `.place-of-work` city string via
 * inferAnyCanton; jobs whose canton does not resolve to a Swiss canton are
 * dropped upstream.
 *
 * Listing: https://jobs.axa.ch/?lang=it&offset=0&limit=500
 *   - No filter_20 facet → national (all regions) result set
 *   - Server-rendered HTML, paginated via offset/limit query params
 *   - Jobs in <a id="job-{numericId}" href="/posizioni-aperte/{slug}/{uuid}">
 *     - data-href → Umantis apply URL
 *     - title → job title
 *     - .job-meta1 p → short description
 *     - .job-meta2 .place-of-work → "City, NN %" (clean city signal for canton)
 *
 * Detail: https://jobs.axa.ch/posizioni-aperte/{slug}/{uuid}
 *   - <h1> → title
 *   - <h2 class="isLast"> → workload + location
 *   - <meta name="description"> → summary
 *   - <div class="multicolumn"> → responsibilities + requirements
 *   - .map a[href*=google.com/maps] → address
 *   - lang= attribute on <html> → language
 *
 * Lang slugs: it→posizioni-aperte, de→offene-stellen, fr→postes-vacants, en→open-positions
 */

import { JSDOM } from 'jsdom';
import { inferAnyCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import { extractJobPostingField } from './jobposting-jsonld.mjs';

const BASE_URL = 'https://jobs.axa.ch';

const LANG_SLUGS = {
  it: 'posizioni-aperte',
  de: 'offene-stellen',
  fr: 'postes-vacants',
  en: 'open-positions',
};

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
 * Build national listing URL (no region facet) with offset/limit pagination.
 * @param {'it'|'de'|'fr'|'en'} lang
 * @param {number} [offset=0]
 * @param {number} [limit=500]
 * @returns {string}
 */
export function buildListingUrl(lang = 'it', offset = 0, limit = 500) {
  return `${BASE_URL}/?lang=${lang}&offset=${offset}&limit=${limit}`;
}

/**
 * Parse the listing HTML to extract job summaries.
 * @param {string} html - Full HTML of the listing page
 * @returns {Array<{id: string, title: string, url: string, applyUrl: string, excerpt: string}>}
 */
export function parseAxaListingPage(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const jobs = [];

  const jobLinks = doc.querySelectorAll('a[id^="job-"]');
  for (const link of jobLinks) {
    const numericId = (link.id || '').replace('job-', '');
    const title = normalizeSpace(link.getAttribute('title') || '');
    const url = link.getAttribute('href') || '';
    const applyUrl = link.getAttribute('data-href') || '';

    const meta1 = link.querySelector('.job-meta1 p');
    const excerpt = normalizeSpace(meta1?.textContent || '');

    // Clean city signal from the listing: ".place-of-work" holds "City, NN %".
    // The city is the segment before the first comma — used ALONE (no region
    // string appended) for canton inference, since a combined "city + region"
    // string makes inferAnyCanton return the wrong canton.
    const powText = normalizeSpace(
      link.querySelector('.job-meta2 .place-of-work')?.textContent || '',
    );
    const listingCity = powText.split(',')[0].replace(/\d+\s*%.*$/, '').trim();

    if (!title || !url) continue;

    jobs.push({
      id: numericId,
      title,
      url: url.startsWith('http') ? url : `${BASE_URL}${url}`,
      applyUrl: applyUrl || '',
      excerpt,
      listingCity,
    });
  }

  return jobs;
}

/**
 * Parse a job detail page.
 * @param {string} html - Full HTML of the detail page
 * @param {string} pageUrl - URL of the page (for canonical reference)
 * @returns {object|null}
 */
export function parseAxaDetailPage(html, pageUrl = '') {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = normalizeSpace(doc.querySelector('h1')?.textContent || '');
  if (!title) return null;

  // Workload + location from <h2 class="isLast">
  const h2 = doc.querySelector('h2.isLast');
  const h2Text = normalizeSpace(h2?.innerHTML?.replace(/<br\s*\/?>/gi, ' | ') || '');
  const h2Clean = stripHtml(h2Text);

  // Extract workload percentage
  const workloadMatch = h2Clean.match(/(\d+[-–]\d+%|\d+%)/);
  const workload = workloadMatch ? workloadMatch[1] : '';

  // Extract location from h2 (after workload line)
  const locationParts = h2Clean.replace(/\d+[-–]?\d*%/g, '').replace(/\|/g, '').trim();
  let location = normalizeSpace(locationParts);

  // Also try Google Maps address
  const mapLink = doc.querySelector('.map a[href*="google.com/maps"]');
  const address = normalizeSpace(mapLink?.textContent || '');

  // Meta description
  const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';

  // Language from <html lang="">
  const htmlLang = (doc.documentElement.getAttribute('lang') || 'de').toLowerCase().slice(0, 2);

  // ── Intro text (p.intro paragraphs only — NOT parent .intro divs) ──
  const introTexts = [];
  for (const el of doc.querySelectorAll('p.intro')) {
    const text = normalizeSpace(el.textContent || '');
    if (text.length > 20 && !introTexts.includes(text)) introTexts.push(text);
  }

  // ── Main content blocks: .width-50 sections ──
  // These contain responsibilities, requirements, company info
  // Section headings use <div class="s2"> or <h3>
  const SKIP_HEADINGS = /^(candidati ora|hai domande|jetzt bewerben|hast du fragen|postulez|avez-vous|apply now|any questions)/i;
  const contentBlocks = [];
  for (const el of doc.querySelectorAll('.width-50')) {
    // Skip non-printable (apply buttons, contact info, process info)
    if (el.classList.contains('non-printable')) continue;

    const heading = normalizeSpace(
      (el.querySelector('.s2, h3, h2') || {}).textContent || ''
    );

    // Skip contact/apply blocks
    if (SKIP_HEADINGS.test(heading)) continue;
    const listItems = [...el.querySelectorAll('li')]
      .map((li) => normalizeSpace(li.textContent || ''))
      .filter((t) => t.length > 5);
    const paragraphs = [...el.querySelectorAll('p')]
      .map((p) => normalizeSpace(p.textContent || ''))
      .filter((t) => t.length > 15);

    if (heading && (listItems.length > 0 || paragraphs.length > 0)) {
      let blockText = `## ${heading}`;
      if (listItems.length > 0) {
        blockText += '\n' + listItems.map((item) => `- ${item}`).join('\n');
      }
      if (paragraphs.length > 0) {
        blockText += '\n' + paragraphs.join('\n');
      }
      contentBlocks.push(blockText);
    } else if (!heading && (listItems.length > 0 || paragraphs.length > 0)) {
      // Content without a heading — skip contact info blocks
      const allText = [...listItems, ...paragraphs].join(' ').toLowerCase();
      if (/domande|fragen|questions|e-mail|@axa\.ch/i.test(allText)) continue;
      if (listItems.length > 0) {
        contentBlocks.push(listItems.map((item) => `- ${item}`).join('\n'));
      }
      if (paragraphs.length > 0) {
        contentBlocks.push(paragraphs.join('\n'));
      }
    }
  }

  // ── Benefits from .content divs inside .benefits ──
  const benefitItems = [];
  for (const el of doc.querySelectorAll('.benefits .content, .benefits-slider .content')) {
    const benefitTitle = normalizeSpace(el.querySelector('h4, h3, strong')?.textContent || '');
    const bullets = [...el.querySelectorAll('li')]
      .map((li) => normalizeSpace(li.textContent || ''))
      .filter((t) => t.length > 5);
    if (benefitTitle && bullets.length > 0) {
      benefitItems.push(`**${benefitTitle}**: ${bullets.join('; ')}`);
    }
  }

  // ── Build full description ──
  const descParts = [];
  if (introTexts.length > 0) descParts.push(introTexts.join('\n\n'));
  if (contentBlocks.length > 0) descParts.push(contentBlocks.join('\n\n'));
  if (benefitItems.length > 0) {
    descParts.push('## Benefits\n' + benefitItems.map((b) => `- ${b}`).join('\n'));
  }
  const description = descParts.join('\n\n').trim() || stripHtml(metaDesc);

  // Apply URL
  const applyLink = doc.querySelector('a[href*="/apply/"]');
  const applyUrl = applyLink?.getAttribute('href') || '';

  return {
    title,
    location: location || address.split(',')[0] || '',
    address,
    workload,
    description,
    metaDescription: normalizeSpace(metaDesc),
    lang: htmlLang,
    applyUrl: applyUrl.startsWith('http') ? applyUrl : (applyUrl ? `${BASE_URL}${applyUrl}` : ''),
  };
}

/**
 * Resolve a job's Swiss canton from the cleanest single city signal.
 *
 * Tries the listing `.place-of-work` city first (cleanest), then the detail
 * location, then the post-postal-code city segment of the address. Each
 * candidate is passed to inferAnyCanton ALONE — never a combined
 * "city + region" string, which would make inferAnyCanton return the wrong
 * canton due to TARGET_CANTONS array order. Returns '' when no candidate
 * resolves to one of the 26 Swiss cantons (foreign / unresolved → dropped
 * upstream, never defaulted to TI).
 *
 * @param {string} listingCity - clean city from listing .place-of-work
 * @param {string} location - detail-page location
 * @param {string} address - detail-page address (Swiss "Street N, PostalCode City")
 * @returns {string} 2-letter canton code or ''
 */
export function inferAxaCanton(listingCity = '', location = '', address = '') {
  const addressCity = String(address || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop() // last segment = "PostalCode City"
    ?.replace(/^\d{4}\s*/, '')
    .trim() || '';
  for (const candidate of [listingCity, location, addressCity]) {
    const clean = String(candidate || '').trim();
    if (!clean) continue;
    const canton = inferAnyCanton(clean);
    if (canton) return canton;
  }
  return '';
}

/**
 * Infer job category from title + description.
 */
export function inferAxaCategory(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();
  if (/\b(it|software|developer|devops|engineer|informatik|informatica)\b/i.test(text)) return 'informatica';
  if (/\b(market|comunicat|kommunik|digital|online|seo)\b/i.test(text)) return 'marketing';
  if (/\b(hr|human|risorse umane|personale|talent)\b/i.test(text)) return 'risorse-umane';
  if (/\b(finan[zc]|contabil|buchhalt|accounting|risk|actuari|attuari)\b/i.test(text)) return 'finanza';
  if (/\b(consulent|berat|advisor|sales|vendita|verkauf)\b/i.test(text)) return 'vendita';
  if (/\b(underwriting|assicurat|versicher|insurance)\b/i.test(text)) return 'assicurazioni';
  if (/\b(recht|legal|giuridic|compliance|legale)\b/i.test(text)) return 'legale';
  if (/\b(logist|einkauf|acquist|procurement)\b/i.test(text)) return 'logistica';
  if (/\b(direzione|management|leadership|führung|leitung)\b/i.test(text)) return 'direzione';
  if (/\b(innendienst|backoffice|admin|segretari|kaufm)\b/i.test(text)) return 'amministrazione';
  if (/\b(schaden|sinistri|claims)\b/i.test(text)) return 'sinistri';
  if (/\b(rechtsschutz|protezione giuridica)\b/i.test(text)) return 'protezione-giuridica';
  return 'assicurazioni'; // Default for AXA
}

/**
 * Build localized content object for a job.
 */
export function buildAxaLocalizedContent(detail, listingExcerpt = '') {
  const lang = detail.lang || 'it';
  const content = {};

  content[lang] = {
    title: detail.title,
    description: detail.description,
    excerpt: detail.metaDescription || listingExcerpt || detail.description.slice(0, 300),
    requirements: '',
    location: detail.location || detail.address || '',
  };

  return content;
}

/**
 * Build the detail page URL for a given UUID and language.
 */
export function buildDetailUrl(uuid, lang = 'it') {
  const slug = LANG_SLUGS[lang] || LANG_SLUGS.it;
  return `${BASE_URL}/${slug}/${uuid}`;
}

/**
 * Extract UUID from a job URL.
 */
export function extractUuidFromUrl(url = '') {
  const match = url.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : '';
}

/* ── careers.axa.com (AXA Group Jibe portal) ─────────────────────────────
 *
 * jobs.axa.ch answers 301 to https://careers.axa.com/careers-home/jobs since
 * AXA Switzerland moved to the group career portal: the old Prospective
 * listing rendered «no results» from 2026-07 on and the crawler kept its last
 * 3 postings (dead links) while the new portal listed 158 Swiss openings on
 * 2026-09-29. The portal is a Jibe site:
 *   - listing API: /api/jobs?country=Switzerland&page=N&limit=100 → JSON with
 *     `jobs[].data` {req_id, title, language, city, postal_code,
 *     street_address, country_code, description (flat text), apply_url, …};
 *   - detail page: /careers-home/jobs/{req_id}?lang={language} with a
 *     schema.org JobPosting whose `description` is the full HTML ad;
 *   - robots.txt: `Allow: /`, `crawl-delay: 5`.
 */
export const AXA_CAREERS_BASE_URL = 'https://careers.axa.com';

// Named and numeric entities, case-preserving («&Uuml;ber» → «Über»): the
// portal's JSON-LD HTML encodes every umlaut.
let entityDecoder = null;
function decodeHtmlEntities(text = '') {
  if (!entityDecoder) entityDecoder = new JSDOM('').window.document.createElement('textarea');
  entityDecoder.innerHTML = String(text || '');
  return entityDecoder.value;
}
export const AXA_CAREERS_CRAWL_DELAY_MS = 5000;

export function buildAxaJibeListingUrl(page = 1, limit = 100) {
  return `${AXA_CAREERS_BASE_URL}/api/jobs?country=Switzerland&page=${page}&limit=${limit}`;
}

export function buildAxaJibeDetailUrl(reqId = '', language = 'de-de') {
  return `${AXA_CAREERS_BASE_URL}/careers-home/jobs/${encodeURIComponent(String(reqId))}?lang=${encodeURIComponent(language || 'de-de')}`;
}

export function extractAxaJibeJobId(url = '') {
  const match = String(url || '').match(/careers\.axa\.com\/careers-home\/jobs\/(\d+)/i);
  return match ? match[1] : '';
}

function titleCaseCity(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/(^|[\s\-/(.])(\p{L})/gu, (all, sep, letter) => `${sep}${letter.toUpperCase()}`)
    .trim();
}

/**
 * Swiss postings of one listing-API page. The locality comes from the
 * geocoded postal address Google Jobs derived for the posting («Bern»), and
 * falls back to the portal's upper-cased `city` («BERN») in title case.
 *
 * @returns {{ total: number, rows: Array<object> }}
 */
export function parseAxaJibeListing(json) {
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  const rows = [];
  for (const entry of jobs) {
    const data = entry?.data || {};
    if (String(data.country_code || '').toUpperCase() !== 'CH') continue;
    const reqId = String(data.req_id || data.slug || '').trim();
    const title = normalizeSpace(decodeHtmlEntities(String(data.title || '')));
    if (!reqId || !title) continue;
    const postal = data.meta_data?.googlejobs?.derivedInfo?.locations?.[0]?.postalAddress || {};
    // The portal's own city is what the detail page states («PFÄFFIKON»);
    // the geocoded locality is the municipality («Freienbach») and is used
    // only when it names the same place («RÜTI ZH» → «Rüti»). The canton
    // comes from the geocoded address, which resolves the homonyms the city
    // alone cannot (Pfäffikon SZ, Oberwil BL, Kirchberg BE).
    const portalCity = titleCaseCity(String(data.city || '').replace(/\s+[A-Za-z]{2}$/, ''));
    const geocodedCity = normalizeSpace(postal.locality || '');
    const locality = geocodedCity && geocodedCity.toLowerCase() === portalCity.toLowerCase()
      ? geocodedCity
      : (portalCity || geocodedCity);
    const cantonHint = normalizeCantonCode(String(postal.administrativeArea || '')) || '';
    const postalCode = String(data.postal_code || postal.postalCode || '').trim();
    const street = normalizeSpace(data.street_address || '');
    const language = String(data.language || 'de-de');
    const detailUrl = buildAxaJibeDetailUrl(reqId, language);
    rows.push({
      id: reqId,
      reqId,
      title,
      url: detailUrl,
      detailUrl,
      applyUrl: String(data.apply_url || '').trim(),
      excerpt: normalizeSpace(String(data.description || '')).slice(0, 300),
      // The listing carries the whole ad as flat text: the fallback when the
      // detail page cannot be read is the same ad, not a teaser.
      listingDescription: normalizeSpace(decodeHtmlEntities(String(data.description || ''))),
      listingCity: locality,
      cantonHint,
      street,
      address: [street, [postalCode, locality].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      postalCode,
      lang: language.slice(0, 2).toLowerCase(),
      postedDate: String(data.posted_date || '').slice(0, 10),
    });
  }
  return { total: Number(json?.totalCount) || 0, rows };
}

/**
 * The ad from the JSON-LD JobPosting of a careers.axa.com detail page. The
 * body is the posting's own HTML: paragraphs and lists become lines and
 * «• » bullets. The first line of every AXA ad states the workload and the
 * workplace («100%, Arbeitsort Bern»).
 */
export function parseAxaJibeDetailPage(html = '') {
  const descriptionHtml = String(extractJobPostingField(html, 'description') || '');
  const description = decodeHtmlEntities(stripHtml(descriptionHtml))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/•\n+/g, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const title = normalizeSpace(decodeHtmlEntities(String(extractJobPostingField(html, 'title') || '')));
  const workloadMatch = description.match(/^\s*(\d{1,3}(?:\s*[-–]\s*\d{1,3})?\s*%)/);
  return {
    title,
    description,
    workload: workloadMatch ? workloadMatch[1].replace(/\s+/g, '') : '',
  };
}

export { LANG_SLUGS, BASE_URL };
