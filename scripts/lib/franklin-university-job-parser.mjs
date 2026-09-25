#!/usr/bin/env node
/**
 * Franklin University Switzerland job parser — Fetcher and job builder.
 *
 * Source: https://www.fus.edu/about-franklin/job-opportunities
 * (franklin.edu.ch is dead — DNS NOERROR/NODATA. The university's current
 * domain is fus.edu; job-opportunities is a Drupal page built from nested
 * "single-accordion" paragraphs: a top-level category accordion — e.g.
 * ACADEMIC POSITIONS, ADMINISTRATIVE POSITIONS — that either states there
 * are no open positions, or nests one leaf accordion per open role. See
 * #3797.)
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFranklinUniversityJobs()  — Fetch and parse all jobs
 *   - isFranklinUniversityJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { buildJobSlug, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FRANKLIN_UNIVERSITY_KEY = 'franklin-university';
export const FRANKLIN_UNIVERSITY_COMPANY_NAME = 'Franklin University Switzerland';
export const FRANKLIN_UNIVERSITY_COMPANY_DOMAIN = 'fus.edu';

const CAREER_URL = 'https://www.fus.edu/about-franklin/job-opportunities';
const HQ = getCompanyDefaults('franklin-university');

const SWISS_LOCATION_RE = /switzerland|svizzera|schweiz|suisse|ticino|lugano|sorengo|mendrisio|bellinzona/i;
const NO_OPENINGS_RE = /no open positions|no current openings|currently no open/i;
/** A fragment-safe HTML id: the per-vacancy anchor on the single careers page. */
const DETAIL_ANCHOR_RE = /^[A-Za-z][\w-]*$/;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Franklin University Switzerland.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFranklinUniversityJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FRANKLIN_UNIVERSITY_KEY ||
    key.startsWith('franklin-university') ||
    company.includes('franklin university switzerland') ||
    url.includes('fus.edu')
  );
}

/**
 * Validate that a URL belongs to Franklin University Switzerland's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'fus.edu' || host.endsWith('.fus.edu');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|admission)/.test(t)) return 'Amministrazione';
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

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Extract the "Location:" field (if any) from a job's rendered body text.
 * Returns '' when no explicit Location field is present.
 */
function extractLocationField(bodyText = '') {
  const m = bodyText.match(/Location:\s*([^.\n]{3,120})/i);
  return m ? normalizeSpace(m[1]) : '';
}

/**
 * Parse the fus.edu job-opportunities page (Drupal nested accordions).
 * Category-level accordions (ACADEMIC POSITIONS, ADMINISTRATIVE POSITIONS)
 * either state there are no open positions, or nest one leaf accordion per
 * open role. Only leaf accordions (no further nested accordion inside) that
 * aren't a "no openings" placeholder are real jobs. Postings explicitly
 * located outside Switzerland (e.g. US remote admissions roles) are
 * out of scope for this Swiss job board and are skipped.
 * Returns an array of { title, url, snippet, location } objects.
 *
 * The page has no per-vacancy detail page, but every leaf accordion carries a
 * stable Drupal paragraph id (`id="para_4660"`), so each vacancy gets its own
 * deep link `CAREER_URL#para_<n>`. Publishing the bare list page instead made
 * every successive vacancy share one URL, and the URL-keyed merge then handed
 * each new role the previous role's id and slug (issue #9679: the id minted in
 * July for "Director of Marketing and Communications" was still serving the
 * "Vice President of Enrollment Management" posting under a "senior advisor"
 * slug). A leaf WITHOUT an anchor is dropped, not published under the list
 * URL, and counted in `missingDetailUrlCount` so the crawler template keeps
 * the existing slice when that loss exceeds MISSING_DETAIL_URL_MAX_RATIO.
 */
export function parseListingPage(html = '') {
  const jobs = [];
  if (!html) return jobs;
  let missingDetailUrlCount = 0;
  const { document } = new JSDOM(html).window;

  const accordions = document.querySelectorAll('.paragraph--type-single-accordion, [class*="paragraph--type-single-accordion"], [class*="single-accordion"]');
  for (const node of accordions) {
    // Leaf = no further nested accordion inside this one.
    if (node.querySelector('[class*="single-accordion"]')) continue;

    const titleEl = node.querySelector('[class*="fus_para_accordion_title"]');
    const title = normalizeSpace(titleEl?.textContent || '');
    if (!title || title.length < 3) continue;
    // Category headers render in all caps ("ACADEMIC POSITIONS"); real job
    // titles are natural-case.
    if (title === title.toUpperCase() && /[A-Z]/.test(title)) continue;

    const bodyEl = node.querySelector('[class*="fus_para_accordion_text"]');
    const bodyText = normalizeSpace(bodyEl?.textContent || '');
    if (!bodyText || NO_OPENINGS_RE.test(bodyText)) continue;

    const location = extractLocationField(bodyText);
    if (location && !SWISS_LOCATION_RE.test(location)) continue; // out-of-scope (e.g. US remote)

    const anchor = String(node.getAttribute('id') || '').trim();
    if (!DETAIL_ANCHOR_RE.test(anchor)) {
      missingDetailUrlCount += 1;
      continue;
    }

    jobs.push({ title, url: `${CAREER_URL}#${anchor}`, snippet: bodyText, location: location || HQ.city });
  }

  if (missingDetailUrlCount > 0) jobs.missingDetailUrlCount = missingDetailUrlCount;
  return jobs;
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Franklin University Switzerland jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllFranklinUniversityJobs() {
  console.log(`  Fetching Franklin University Switzerland jobs from ${CAREER_URL}`);
  let html = '';
  try {
    html = await fetchHtml(CAREER_URL, { timeoutMs: 20000 });
  } catch (err) {
    throw new Error(`Franklin University: failed to fetch the careers page: ${err.message}`, { cause: err });
  }
  const listings = parseListingPage(html);
  const missingDetailUrlCount = listings.missingDetailUrlCount || 0;
  console.log(`  Jobs found on listing page: ${listings.length}`);
  if (missingDetailUrlCount > 0) {
    console.warn(`  ⚠️ ${missingDetailUrlCount} vacancy(ies) without a per-vacancy anchor dropped (no list-page fallback)`);
  }

  const jobs = [];
  // Only a real loss is attached: a clean crawl stays a plain array, so an
  // empty page still reads as the genuine empty result `[]`.
  if (missingDetailUrlCount > 0) jobs.missingDetailUrlCount = missingDetailUrlCount;
  if (!listings.length) return jobs;

  for (const listing of listings) {
    const description = listing.snippet || '';
    const location = listing.location || HQ.city;
    const sourceLang = detectLang(listing.title + ' ' + description, 'en');
    const jobSlug = buildJobSlug(`${listing.title} ${location}`, 'franklin-university');
    // Id basis unchanged from the list-page era (`CAREER_URL#title`), so the id
    // stays a function of the vacancy title and not of Drupal's paragraph id.
    const urlHash = createHash('sha1').update(`${CAREER_URL}#${listing.title}`).digest('hex').slice(0, 12);

    jobs.push({
      id: `${FRANKLIN_UNIVERSITY_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FRANKLIN_UNIVERSITY_COMPANY_NAME,
      companyKey: FRANKLIN_UNIVERSITY_KEY,
      companyDomain: FRANKLIN_UNIVERSITY_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description: description || `${listing.title} — Franklin University Switzerland`,
      descriptionByLocale: { [sourceLang]: description || `${listing.title} — Franklin University Switzerland` },
      location,
      canton: HQ.canton,
      addressLocality: location.split('/')[0].trim(),
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Istruzione / Universita',
      contract: detectEmploymentType(listing.title + ' ' + description) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.title + ' ' + description),
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url,
      applyUrl: listing.url,
      source: 'Franklin University Switzerland Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`  Total Franklin University Switzerland jobs discovered: ${jobs.length}`);
  return jobs;
}
