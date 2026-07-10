#!/usr/bin/env node
/**
 * OMEGA SA job parser — Swatch Group job-finder (Drupal, Lumesse TalentLink ATS).
 *
 * OMEGA SA is a Swatch Group subsidiary (luxury watches).
 *
 * WHY the Swatch Group portal and not omegawatches.com (#3843 item 1):
 * the brand's own career portal (https://www.omegawatches.com/careers/list)
 * sits behind an Akamai WAF that hard-blocks EVERY datacenter egress we can
 * use — GitHub Actions runners get HTTP 403 on the list page (verified in the
 * crawler-group-21 run logs), and the Jina Reader clean-IP pool gets Akamai
 * "Access Denied" (edgesuite reference) on every attempt. The SAME jobs are
 * published on the group-wide job finder at https://www.swatchgroup.com — a
 * server-rendered Drupal site (NOT a JS SPA) that serves full HTML and is
 * reachable through the sanctioned Jina egress proxy. Both portals front the
 * same Lumesse TalentLink ATS (identical apply URLs on
 * apply5.lumessetalentlink.com and the same country taxonomy id 40 for
 * Switzerland).
 *
 * List page: https://www.swatchgroup.com/en/job-finder?jf_country=40&page={N}
 *   - jf_country=40 = Switzerland (same taxonomy id the brand portal used)
 *   - Server-rendered cards, 10 per page; pager query param `page` (0-based)
 *   - Each card carries the brand logo (/sites/default/files/brands-logos/
 *     omega.png) — that logo is the ONLY brand discriminator, so we keep just
 *     the omega cards
 *   - Card link: /{lang}/job/{id} (the path locale IS the posting's language)
 *
 * Detail page structure (language-independent CSS hooks):
 *   - h1 .f-n-title                     — job title
 *   - .f-n-field-job-company-intro      — company intro
 *   - .f-n-body                         — job description
 *   - .f-n-field-job-profile            — candidate profile
 *   - .f-n-field-job-prof-requ          — professional requirements
 *   - .f-n-field-job-languages          — language requirements
 *   - .f-n-field-job-contact            — contact person
 *   - div#jl                            — job location (street / zip city (region) / country)
 *   - a[href*=lumessetalentlink.com]    — TalentLink apply URL
 *
 * Fetch strategy: direct fetch first (works if the runner IP is clean), then
 * the shared Jina Reader proxy fallback (scripts/lib/jina-proxy.mjs) — the
 * same sanctioned direct-then-Jina pattern as clinique-cic-job-parser.mjs.
 *
 * Exports the functions required by the crawler template:
 *   - fetchAllOmegaJobs()     — Fetch and parse all Swiss OMEGA jobs
 *   - isOmegaJob()            — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 * plus parseListPage()/parseDetailPage() for fixture tests.
 */
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { fetchHtmlViaJinaWithRetry, looksLikeAntiBotChallenge } from './jina-proxy.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const OMEGA_KEY = 'omega';
export const OMEGA_COMPANY_NAME = 'OMEGA SA';
export const OMEGA_COMPANY_DOMAIN = 'omegawatches.com';

const BASE_URL = 'https://www.swatchgroup.com';
// jf_country=40 = Switzerland in the shared Swatch Group / brand taxonomy.
const SWITZERLAND_COUNTRY_ID = '40';
const listUrl = (page) =>
  `${BASE_URL}/en/job-finder?jf_country=${SWITZERLAND_COUNTRY_ID}&page=${page}`;
// 92 Swiss jobs group-wide ≈ 10 pages today; hard cap so a pager regression
// can never turn into an unbounded crawl.
const MAX_LIST_PAGES = 30;
const DETAIL_DELAY_MS = 500;
// The brand logo on each card/detail is the only OMEGA discriminator on the
// group-wide portal.
const OMEGA_LOGO_MARKER = 'brands-logos/omega.png';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert HTML fragments to plain-text description.
 */
function htmlToText(html = '') {
  if (!html || !html.trim()) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#x20;/g, ' ')
    // Per-line trim of HORIZONTAL whitespace only — `\s` would also consume
    // the newlines themselves and glue adjacent lines together ("…96" +
    // "2502 Biel/Bienne" → "…962502 Biel/Bienne"), breaking the line-based
    // location parser and requirements splitting.
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse the #jl job-location block text into address parts.
 * Shape (all languages):
 *   Rue Jakob-Stämpfli - Jakob-Stämpfli-Strasse 96
 *   2502 Biel/Bienne (Bern)
 *   Switzerland | Suisse | Schweiz | Svizzera
 */
export function parseJobLocation(locationText = '') {
  const lines = String(locationText || '')
    .split('\n')
    .map((l) => normalizeSpace(l))
    .filter(Boolean);

  let street = '';
  let postalCode = '';
  let city = '';
  let region = '';

  for (let i = 0; i < lines.length; i++) {
    const zipCityMatch = lines[i].match(/^(\d{4})\s+(.+)$/);
    if (!zipCityMatch) continue;
    postalCode = zipCityMatch[1];
    let rest = zipCityMatch[2];
    const regionMatch = rest.match(/\(([^)]+)\)\s*$/);
    if (regionMatch) {
      region = regionMatch[1].trim();
      rest = rest.slice(0, regionMatch.index).trim();
    }
    city = rest;
    if (i > 0) street = lines[i - 1];
    break;
  }

  return { street, postalCode, city, region };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to OMEGA SA.
 * Used by the template to filter this company's jobs from the global dataset.
 * NOTE: a generic swatchgroup.com URL is deliberately NOT a match — the group
 * portal hosts every Swatch Group brand, so only jobs this parser tagged with
 * the omega companyKey/company (or brand-portal URLs) belong here.
 */
export function isOmegaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === OMEGA_KEY ||
    key.startsWith('omega') ||
    company.includes('omega sa') ||
    url.includes('omegawatches.com')
  );
}

/**
 * Validate that a URL belongs to OMEGA SA's trusted domains.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'omegawatches.com' ||
      host.endsWith('.omegawatches.com') ||
      host === 'swatchgroup.com' ||
      host.endsWith('.swatchgroup.com') ||
      host.includes('lumessetalentlink.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

export function detectCategory(title = '', domain = '') {
  const t = normalize(`${title} ${domain}`);
  if (/\b(verkauf|vente|vendita|sales|retail|boutique|representative)/.test(t)) return 'Commerciale';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|horlog|watchmak|uhrmach)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(logist|magazz|lager|warehouse|supply|stock|spare parts)/.test(t)) return 'Logistica';
  if (/\b(customer.?service|service.?client|kundendienst|care.?advisor)/.test(t)) return 'Servizio Clienti';
  if (/\b(it\b|software|develop|programm|crm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(director|direktor|dirett|manager|leiter|responsab)/.test(t)) return 'Management';
  if (/\b(r&d|research|forschung|ricerca)/.test(t)) return 'Ricerca e Sviluppo';
  return 'Altro';
}

export function detectExperienceLevel(title = '', text = '') {
  const t = normalize(`${title} ${text}`);
  // `intern` must be word-bounded on BOTH sides: a bare `\bintern` prefix
  // would also match "INTERNATIONAL …" titles.
  if (/\b(praktik|stage\b|stagiair|intern(ship)?s?\b|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|deputy|manager|management|cadre)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '', text = '') {
  const t = normalize(`${title} ${text}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel|\d{2}\s*%)/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

export function detectContractType(title = '', text = '') {
  const t = normalize(`${title} ${text}`);
  // `tempora` prefix covers temporary (en), temporaire (fr), temporaneo (it).
  if (/\b(befristet|determin|tempora|temporär|cdd|fixed.?term|interim)/.test(t)) return 'fixed-term';
  return 'permanent';
}

/* ── HTTP Client ───────────────────────────────────────────── */

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Percent-encode the query-string delimiters of a target URL for Jina Reader.
 *
 * Jina parses the OUTER request's query string as its own API parameters, so
 * an unencoded `...job-finder?jf_country=40&page=0` collides with Jina's own
 * `page` param (a 1-indexed PDF-page selector with a `>= 1` validator → our
 * 0-based pager gets an HTTP 400 ParamValidationError). Encoding `?`, `&`
 * and `=` makes the whole query part of the target URL path, which Jina
 * decodes and forwards verbatim (verified live: encoded and unencoded
 * `jf_country=40` return the identical filtered result set).
 */
export function jinaSafeUrl(url = '') {
  const i = String(url).indexOf('?');
  if (i === -1) return url;
  const query = String(url).slice(i + 1).replace(/&/g, '%26').replace(/=/g, '%3D');
  return `${String(url).slice(0, i)}%3F${query}`;
}

/**
 * Fetch a page: direct first, then through the shared Jina Reader proxy.
 *
 * swatchgroup.com sits behind the same Akamai WAF family as the brand portal
 * and may 403 / reset the connection on datacenter egress IPs (GitHub Actions
 * runners). The direct attempt is kept so nothing changes if the runner IP is
 * clean; on ANY direct failure (non-2xx, network/TLS error, or a
 * 200-with-challenge body) we re-fetch through Jina's clean-IP pool
 * (retried across its rotating egress IPs by fetchHtmlViaJinaWithRetry).
 */
async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  let directErr;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8,fr;q=0.7',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.text();
      if (!looksLikeAntiBotChallenge(body)) return body;
      directErr = new Error(`WAF challenge page from ${url}`);
    } else {
      directErr = new Error(`HTTP ${res.status} from ${url}`);
    }
  } catch (err) {
    clearTimeout(timer);
    directErr = err;
  }

  const viaJina = await fetchHtmlViaJinaWithRetry(jinaSafeUrl(url), { timeoutMs: Math.max(timeoutMs, 30000) });
  if (viaJina != null && !looksLikeAntiBotChallenge(viaJina)) return viaJina;
  throw directErr;
}

/* ── List Page Parser ─────────────────────────────────────── */

/**
 * Parse a job-finder list page.
 * Returns { listings, cardCount }:
 *   - cardCount: ALL brand cards on the page (pagination signal — a page with
 *     0 cards is past the end of the result set)
 *   - listings: only the OMEGA-brand cards, as { url, lang, jobId, title, teaser, domain }
 */
export function parseListPage(html = '') {
  const listings = [];

  const cardChunks = String(html || '').split('<div class="card h-100">').slice(1);
  for (const chunk of cardChunks) {
    // Card link: /{lang}/job/{id}
    const urlMatch = chunk.match(/href="\/(\w{2})\/job\/(\d+)"/);
    if (!urlMatch) continue;

    if (!chunk.includes(OMEGA_LOGO_MARKER)) continue; // other Swatch Group brand

    const lang = urlMatch[1];
    const jobId = urlMatch[2];
    const detailUrl = `${BASE_URL}/${lang}/job/${jobId}`;

    const titleMatch = chunk.match(/<h4 class="card-title">\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? normalizeSpace(htmlToText(titleMatch[1])) : '';

    const teaserMatch = chunk.match(/<p class="card__text">([\s\S]*?)<\/p>/);
    const teaser = teaserMatch ? htmlToText(teaserMatch[1]) : '';

    // The domain image alt ("Sales", "Engineering", …) is the only structured
    // category hint on the portal.
    const domainMatch = chunk.match(/<img[^>]*alt="([^"]*)"/);
    const domain = domainMatch ? normalizeSpace(domainMatch[1]) : '';

    listings.push({ url: detailUrl, lang, jobId, title, teaser, domain });
  }

  const cardCount = cardChunks.length;
  return { listings, cardCount };
}

/* ── Detail Page Parser ───────────────────────────────────── */

/**
 * Parse a job detail page (language-independent CSS hooks).
 */
export function parseDetailPage(html = '') {
  const src = String(html || '');
  const sections = {};

  // Named field sections: <div class="field f-n-<name> ..."><h2>Heading</h2>content</div>
  // (field bodies are flat h2/p/ul markup — no nested divs on this portal).
  const sectionPattern = /<div class="field f-n-((?:field-job-)?[\w-]+?) f-t-[\w-]+">([\s\S]*?)<\/div>/g;
  let secMatch;
  while ((secMatch = sectionPattern.exec(src)) !== null) {
    const rawName = secMatch[1].replace(/^field-job-/, '');
    let content = secMatch[2];
    const headingMatch = content.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const heading = headingMatch ? normalizeSpace(htmlToText(headingMatch[1])) : '';
    if (headingMatch) content = content.replace(headingMatch[0], '');
    const text = htmlToText(content);
    if (text) sections[rawName] = { heading, text };
  }

  // Title
  const h1Match = src.match(/<h1[^>]*>\s*<span class="field f-n-title[^"]*">([\s\S]*?)<\/span>/);
  const title = h1Match ? normalizeSpace(htmlToText(h1Match[1])) : '';

  // Job location block
  const jlMatch = src.match(/<div id="jl"[^>]*>([\s\S]*?)<\/div>/);
  let locationText = '';
  if (jlMatch) {
    locationText = htmlToText(jlMatch[1].replace(/<p[^>]*>[\s\S]*?<\/p>/, ''));
  }

  // TalentLink apply URL
  const applyMatch = src.match(/href="(https?:\/\/[^"]*lumessetalentlink\.com[^"]*)"/);
  const applyUrl = applyMatch ? applyMatch[1].replace(/&amp;/g, '&') : '';

  const isOmegaBrand = src.includes(OMEGA_LOGO_MARKER);

  return { title, sections, locationText, applyUrl, isOmegaBrand };
}

/**
 * Build a structured description from detail page sections, keeping the
 * page's own (localized) headings.
 */
function buildDescription(sections = {}, title = '', city = '') {
  const parts = [];
  for (const key of ['company-intro', 'body', 'profile', 'prof-requ', 'languages']) {
    const sec = sections[key];
    if (!sec?.text) continue;
    parts.push(sec.heading ? `## ${sec.heading}\n${sec.text}` : sec.text);
  }
  if (parts.length === 0) {
    return `${title} - OMEGA SA, ${city ? `${city}, ` : ''}Switzerland`;
  }
  return parts.join('\n\n');
}

/**
 * Extract requirement lines from profile / requirements / languages sections.
 */
function extractRequirements(sections = {}) {
  const reqs = [];
  for (const key of ['profile', 'prof-requ', 'languages']) {
    const text = sections[key]?.text || '';
    if (!text) continue;
    const lines = text.split('\n')
      .map((line) => line.replace(/^[•-]\s*/, '').trim())
      .filter((line) => line.length > 3);
    reqs.push(...lines);
  }
  return reqs;
}

/* ── Main Fetcher ─────────────────────────────────────────── */

/**
 * Fetch all OMEGA SA jobs in Switzerland from the Swatch Group job finder.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllOmegaJobs() {
  console.log(`🔍 Fetching OMEGA SA jobs`);
  console.log(`   Platform: Swatch Group job finder (Drupal, Lumesse TalentLink ATS)`);
  console.log(`   List URL: ${listUrl(0)}`);
  console.log(`   Filter: Switzerland (jf_country=${SWITZERLAND_COUNTRY_ID}) + OMEGA brand cards\n`);

  // Step 1: walk the paginated list, keeping only OMEGA-brand cards.
  const seen = new Set();
  const omegaListings = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    let html;
    try {
      html = await fetchPage(listUrl(page));
    } catch (err) {
      if (page === 0) {
        // Nothing collected yet — graceful early exit (prior data preserved).
        console.error(`  ❌ Failed to fetch list page: ${err?.message || err}`);
        console.warn('   The site may be blocking automated requests. Will retry next cycle.');
        return [];
      }
      // Mid-crawl failure: publishing a PARTIAL list would expire the jobs on
      // the unfetched pages, so bail out to the safe 0-job early exit instead.
      console.error(`  ❌ Failed to fetch list page ${page + 1}: ${err?.message || err}`);
      console.warn('   Aborting with no jobs (prior data preserved) — will retry next cycle.');
      return [];
    }

    const { listings, cardCount } = parseListPage(html);
    console.log(`  📄 List page ${page + 1}: ${cardCount} cards, ${listings.length} OMEGA`);
    if (cardCount === 0) break; // past the last page
    for (const listing of listings) {
      if (seen.has(listing.jobId)) continue;
      seen.add(listing.jobId);
      omegaListings.push(listing);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`  📦 Found ${omegaListings.length} OMEGA Switzerland jobs`);
  if (omegaListings.length === 0) {
    console.warn('⚠️ No OMEGA job listings found.');
    return [];
  }

  // Step 2: fetch each detail page for full information
  const jobs = [];
  for (const listing of omegaListings) {
    console.log(`  📄 Fetching detail: ${listing.title}`);

    let detail = { title: '', sections: {}, locationText: '', applyUrl: '', isOmegaBrand: true };
    try {
      const detailHtml = await fetchPage(listing.url);
      detail = parseDetailPage(detailHtml);
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS)); // Rate limiting
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail page for "${listing.title}": ${err?.message || err}`);
    }

    const title = normalizeSpace(detail.title || listing.title);
    if (!title || title.length < 3) continue;

    const address = parseJobLocation(detail.locationText);
    const city = address.city || '';
    const canton = normalizeCantonCode(address.region) || inferAnyCanton(city) || '';

    // Description from detail sections, falling back to the list teaser.
    const descriptionText = Object.keys(detail.sections).length > 0
      ? buildDescription(detail.sections, title, city)
      : (listing.teaser || buildDescription({}, title, city));
    const requirements = extractRequirements(detail.sections);

    // Source language: the card link's path locale, verified against content.
    const sourceLang = detectLang(descriptionText || title, listing.lang || 'en');

    const stableId = `omega-${listing.jobId}`;
    const jobSlug = slugify(`${title} omega ${city}`);
    const applyUrl = detail.applyUrl || listing.url;
    const detectionText = `${descriptionText}`.slice(0, 4000);

    const job = {
      // ── Required fields ──
      id: stableId,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: OMEGA_COMPANY_NAME,
      companyKey: OMEGA_KEY,
      companyDomain: OMEGA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: listing.url,
      source: 'OMEGA SA Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Location details ──
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      ...(address.postalCode ? { postalCode: address.postalCode } : {}),
      ...(address.street ? { streetAddress: address.street } : {}),

      // ── Job metadata ──
      category: detectCategory(title, listing.domain),
      contract: detectContractType(title, detectionText),
      employmentType: detectEmploymentType(title, detectionText),
      experienceLevel: detectExperienceLevel(title, ''),
      sector: 'Orologeria di lusso',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl,

      // ── Requirements ──
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    jobs.push(job);
    console.log(`  ✅ ${title} — ${city} (${canton})`);
  }

  console.log(`\n📋 Total OMEGA SA Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}

/**
 * Normalize canton code from region names.
 */
function normalizeCantonCode(regionName = '') {
  const lower = normalize(regionName);
  if (!lower) return '';
  if (['wallis', 'valais', 'vallese'].some((n) => lower.includes(n))) return 'VS';
  if (['tessin', 'ticino'].some((n) => lower.includes(n))) return 'TI';
  if (['graubünden', 'graubunden', 'grigioni', 'grisons'].some((n) => lower.includes(n))) return 'GR';
  if (['bern', 'berne', 'berna'].some((n) => lower.includes(n))) return 'BE';
  if (['zürich', 'zurich', 'zurigo'].some((n) => lower.includes(n))) return 'ZH';
  if (['solothurn', 'soletta', 'soleure'].some((n) => lower.includes(n))) return 'SO';
  if (['genève', 'geneve', 'geneva', 'ginevra', 'genf'].some((n) => lower.includes(n))) return 'GE';
  return inferAnyCanton(regionName) || '';
}

export { stripHtml };
