#!/usr/bin/env node
/**
 * Coopers Group AG job parser — Fetcher and job builder.
 *
 * Source: https://www.coopers.ch/en/about/join-us.php
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCoopersJobs()  — Fetch and parse all jobs
 *   - isCoopersJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
import { sourcePostingDateFields, mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import {
  slugify,
  stripHtml,
  normalizeDescriptionSpace,
  fetchHtml as fetchHtmlShared,
} from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';
import { decode as decodeEntities } from 'html-entities';

/* ── Constants ─────────────────────────────────────────────── */

export const COOPERS_KEY = 'coopers';
export const COOPERS_COMPANY_NAME = 'Coopers Group AG';
export const COOPERS_COMPANY_DOMAIN = 'coopers.ch';

const CAREER_URL = 'https://www.coopers.ch/en/about/join-us.php';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Coopers Group AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCoopersJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === COOPERS_KEY ||
    key.startsWith('coopers') ||
    company.includes('coopers group ag') ||
    url.includes('coopers.ch')
  );
}

/**
 * Validate that a URL belongs to Coopers Group AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'coopers.ch' || host.endsWith('.coopers.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Coopers Group AG is a pharma/life sciences staffing & services company
 * based in Visp (VS). Their career page is a PHP-based site at:
 *   https://www.coopers.ch/en/jobs/index.php
 *
 * The listing page is server-rendered HTML. Each job entry contains:
 *   - Title (in <h4><a>) with link to detail page
 *   - Location, contract type, hours, reference code, posted date
 *   - Detail URL pattern: /en/jobs/detail.php?refCode={CODE}
 *
 * All Swiss listings are included (nationwide crawl).
 *
 * Coopers is a staffing agency — jobs are placed at client companies
 * across Switzerland. The hiring org is Coopers as the recruiter.
 */

const COOPERS_BASE = 'https://www.coopers.ch';
const JOBS_URL = `${COOPERS_BASE}/en/jobs/index.php`;

/**
 * Fetch HTML via the shared `fetchHtml` (crawler-template.mjs) so the
 * 200-but-challenge → Jina rescue (#1469) and the connection-level Jina
 * fallback apply by-construction — this bespoke fetcher was outside that
 * shared chokepoint (#1473). Coopers' own Accept/User-Agent are passed through
 * `options.headers`; the shared helper merges them over its DEFAULT_UA so the
 * bespoke UA still wins, and it already wraps the GET in bounded-backoff retry.
 */
async function fetchHtml(url) {
  return fetchHtmlShared(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
        'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
    },
  });
}

/**
 * Parse the Coopers listing page HTML to extract job cards.
 * Each job card has: title, location, contractType, hours, refCode, url.
 */
function parseListingPage(html) {
  const listings = [];
  if (!html) return listings;

  // Job entries are blocks with an <h4><a href="/en/jobs/detail.php?refCode=XXX">Title</a></h4>
  // followed by metadata fields (location, type, hours, ref code, date, description)
  const jobBlockPattern = /<h4[^>]*>\s*<a\s+href="(\/en\/jobs\/detail\.php\?refCode=([^"]+))"[^>]*>([\s\S]*?)<\/a>\s*<\/h4>([\s\S]*?)(?=<h4[^>]*>\s*<a\s+href="\/en\/jobs\/detail\.php|$)/gi;
  let match;

  while ((match = jobBlockPattern.exec(html)) !== null) {
    const detailPath = match[1];
    const refCode = match[2];
    const titleHtml = match[3];
    const metaHtml = match[4];

    const title = stripHtml(titleHtml).trim();
    if (!title || title.length < 3) continue;

    // Extract metadata from surrounding text
    const metaText = stripHtml(metaHtml);

    // Location is typically the first identifiable field
    const locationMatch = metaText.match(/(?:Location|Ort|Lieu)[:\s]*([\w\s-]+?)(?:\n|$)/i) ||
      metaText.match(/^([\w\s-]+?)(?:\n|Contracting|Permanent|Full|Part)/m);
    const location = locationMatch ? normalizeSpace(locationMatch[1]) : '';

    // Contract type
    const contractMatch = metaText.match(/\b(Contracting|Permanent|Temporary)\b/i);
    const contractType = contractMatch ? contractMatch[1] : '';

    // Hours
    const hoursMatch = metaText.match(/\b(Full\s*Time|Part\s*Time|\d+\s*%)\b/i);
    const hours = hoursMatch ? hoursMatch[1] : 'Full Time';

    listings.push({
      title,
      location,
      contractType,
      hours,
      refCode,
      url: `${COOPERS_BASE}${detailPath}`,
    });
  }

  return listings;
}

/**
 * Inner HTML of the first element `<tag class="…">` whose class list satisfies
 * `classTest`, read to its matching close tag (nested same-name tags counted).
 */
function readFirstElementByClass(html, tag, classTest, fromIndex = 0) {
  const openings = new RegExp(`<${tag}\\b[^>]*\\bclass\\s*=\\s*["']([^"']*)["'][^>]*>`, 'gi');
  openings.lastIndex = fromIndex;
  let opening;
  while ((opening = openings.exec(html))) {
    if (!classTest(opening[1].split(/\s+/))) continue;
    const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    tags.lastIndex = openings.lastIndex;
    let depth = 1;
    let match;
    while ((match = tags.exec(html))) {
      if (match[0][1] === '/') {
        depth -= 1;
        if (depth === 0) return { content: html.slice(openings.lastIndex, match.index), end: tags.lastIndex };
      } else if (!/\/\s*>$/.test(match[0])) {
        depth += 1;
      }
    }
    return { content: html.slice(openings.lastIndex), end: html.length };
  }
  return null;
}

// coopers.ch writes umlauts as named entities (`F&uuml;r`) and wraps every
// `<li>` body in a `<p>`: decode the full entity set and keep each bullet on
// one line.
function htmlBlockToText(html = '') {
  return normalizeDescriptionSpace(decodeEntities(stripHtml(html)))
    .replace(/•[ \t]*\n+[ \t]*/g, '• ')
    .replace(/\n{2,}(?=• )/g, '\n');
}

function listItems(ulHtml = '') {
  return [...String(ulHtml).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => normalizeSpace(decodeEntities(stripHtml(match[1]))))
    .filter(Boolean);
}

/**
 * Vacancy body of a coopers.ch detail page, in page order:
 *   - the `div.lead` intro (client and role context),
 *   - the first `div.sx-wysiwyg-style` (tasks + profile, the JSON-LD body),
 *   - the "Job profile" facts (field, region, contract, workload, skills),
 *   - the "Job benefits" list.
 * The application boilerplate ("Das klingt nach einer spannenden Position?"),
 * the recruiter contact card, share buttons and the "Similar jobs"/blog rails
 * are page chrome and stay out. The former whole-page strip cut the text at
 * the first "Position" — which on German postings is the application blurb
 * AFTER the tasks — so the published description kept only that blurb (#5253).
 */
export function parseCoopersDetailDescription(html = '') {
  const source = String(html || '');
  const sections = [];
  const lead = readFirstElementByClass(source, 'div', (classes) => classes.includes('lead'));
  if (lead) sections.push(htmlBlockToText(lead.content));
  const body = readFirstElementByClass(source, 'div', (classes) => classes.includes('sx-wysiwyg-style'));
  if (body) sections.push(htmlBlockToText(body.content));
  if (!body) return '';

  // The "Job profile" box is rendered twice (mobile + desktop copy): read one.
  const profile = /<h5\b[^>]*>\s*Job profile[^<]*<\/h5>\s*<ul\b[^>]*>([\s\S]*?)<\/ul>/i.exec(source);
  const profileItems = profile ? listItems(profile[1]) : [];
  if (profileItems.length) sections.push(['Job profile', ...profileItems.map((item) => `• ${item}`)].join('\n'));
  const benefits = /<h5\b[^>]*>\s*Job benefits\s*<\/h5>\s*<ul\b[^>]*>([\s\S]*?)<\/ul>/i.exec(source);
  const benefitItems = benefits ? listItems(benefits[1]) : [];
  if (benefitItems.length) sections.push(['Job benefits', ...benefitItems.map((item) => `• ${item}`)].join('\n'));

  return normalizeDescriptionSpace(sections.filter(Boolean).join('\n\n'));
}

/**
 * Fetch and parse a Coopers job detail page for description and requirements.
 */
async function fetchJobDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return { description: '', requirements: [] };

    const descriptionText = parseCoopersDetailDescription(html);
    const posting = extractJobPostingLd(html);
    const identities = [posting?.url, posting?.sameAs].flat().filter((value) => value != null);
    // The provider's refCode query identifies the vacancy; never ignore it.
    const sameVacancy = identities.length > 0 && identities.every((value) => {
      if (typeof value !== 'string' || !value.trim()) return false;
      try { return new URL(value, detailUrl).href === new URL(detailUrl).href; }
      catch { return false; }
    });
    const publication = sourcePostingDateFields(sameVacancy ? posting?.datePosted : '');

    // Extract requirements from list items
    const requirements = [];
    const reqSection = html.match(/(?:requirements|qualifications|profile|anforderungen|your profile)[^<]*[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
    if (reqSection) {
      const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liPattern.exec(reqSection[1])) !== null) {
        const req = stripHtml(liMatch[1]).trim();
        if (req.length > 3) requirements.push(req);
      }
    }

    return {
      description: descriptionText || '',
      requirements,
      ...publication,
    };
  } catch (err) {
    console.warn(`  ⚠️ Error fetching detail: ${err.message}`);
    return { description: '', requirements: [] };
  }
}

/**
 * Normalize Coopers location to a canonical city name.
 */
function normalizeCoopersLocation(raw = '') {
  const lower = normalize(raw);
  if (lower.includes('visp')) return 'Visp';
  if (lower.includes('brig')) return 'Brig';
  if (lower.includes('naters')) return 'Naters';
  if (lower.includes('raron')) return 'Raron';
  return normalizeSpace(raw) || '';
}

/**
 * Fetch all Coopers Group AG jobs in Switzerland.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllCoopersJobs() {
  console.log(`🔍 Fetching Coopers Group AG jobs`);
  console.log(`   Source: ${JOBS_URL}`);
  console.log(`   Platform: PHP site (HTML scraping)`);
  console.log(`   Filter: Switzerland — nationwide\n`);

  // Step 1: Fetch the full listing page
  console.log(`  📄 Fetching listing page...`);
  const listingHtml = await fetchHtml(JOBS_URL);
  const allListings = parseListingPage(listingHtml);

  console.log(`  📋 Total listings on page: ${allListings.length}`);

  // Step 2: Keep Swiss listings only (nationwide; coopers.ch has no country
  // param and the dedicated pipeline applies no geo validation, so gate here —
  // a staffing agency may list cross-border placements).
  const swissListings = allListings.filter((l) => isTargetSwissLocation(l.location));

  if (swissListings.length === 0) {
    console.warn('⚠️ No job listings found.');
    return [];
  }

  // Step 3: Fetch detail pages and build job objects
  const jobs = [];
  for (const listing of swissListings) {
    const title = normalizeSpace(listing.title);
    if (!title || title.length < 3) continue;

    const city = normalizeCoopersLocation(listing.location);
    const canton = inferAnyCanton(city) || '';

    // Fetch detail for description
    console.log(`  📥 Fetching detail: ${title.substring(0, 50)}...`);
    const detail = await fetchJobDetail(listing.url);

    const descriptionText = detail.description || `${title} — ${COOPERS_COMPANY_NAME}, ${city}`;
    const requirements = detail.requirements || [];

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} coopers ${city}`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `coopers-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: COOPERS_COMPANY_NAME,
      companyKey: COOPERS_KEY,
      companyDomain: COOPERS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: listing.url,
      source: 'Coopers Group AG Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Location details ──
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',

      // ── Job metadata ──
      category: detectCategory(title),
      contract: listing.contractType?.toLowerCase() === 'permanent' ? 'permanent' : 'contracting',
      employmentType: detectEmploymentType(listing.hours || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Farmaceutica / Life Sciences',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, detail),
      applyUrl: listing.url,

      // ── Requirements ──
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    jobs.push(job);
    console.log(`  ✅ ${title} — ${city} (${listing.contractType || 'n/a'})`);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Coopers Group AG Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}
