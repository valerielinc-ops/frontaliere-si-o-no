#!/usr/bin/env node
/**
 * Kanton Solothurn (cantonal administration) job parser — job.so.ch board.
 *
 * Discovery-tag correction: row 38 of the #3342 queue tagged this employer
 * with URL `ictjobs.ch` and note "IT jobs board, 28 ruoli". Live verification
 * shows `ictjobs.ch` is actually a generic nationwide IT-jobs aggregator
 * (title "IT-Jobs & Informatiker-Stellen in der Schweiz") with zero relation
 * to Kanton Solothurn beyond carrying a handful of Solothurn-region listings
 * like any other canton. The REAL cantonal administration careers portal is
 * `https://karriere.so.ch/stellenmarkt/offene-stellen/`, which embeds an
 * `<iframe src="https://ktso.prospective.ch/...">`. That in turn is a
 * Prospective.ch-hosted careercenter (asset path `/careercenter/1001566/`)
 * that is ALSO served on the vanity domain `https://job.so.ch/`.
 *
 * The scope is NOT IT-only: the board lists the full cantonal
 * administration's open roles across all departments (IT, hunting/fishing,
 * unemployment insurance, security, education, finance, apprenticeships,
 * etc. — 8 "Arbeitswelt" categories observed live: `IT & Digital Business`,
 * `Umwelt & Infrastruktur`, `Sicherheit & Justiz`, `Bildung & Kultur`,
 * `Gesundheit & Soziales`, `Finanzen & Steuern`, `Wirtschaft & Arbeit`,
 * `Zentrale Funktionen`). This parser therefore crawls the FULL board, not
 * an IT-only subset, since restricting to IT would silently drop most of
 * the genuine live scope.
 *
 * This tenant does NOT expose the public
 * `https://ohws.prospective.ch/public/v1/medium/{ID}/jobs` JSON API (every
 * combination of lang/offset/limit verified live → `400 BAD_REQUEST`,
 * matching the same dead-end already documented for CSS Versicherung
 * (medium 1000981) in `css-versicherung-job-parser.mjs`) — the
 * `createProspectiveChParser` shared factory cannot be reused here. Instead
 * this parser scrapes the tenant's own server-rendered HTML front-end,
 * mirroring the CSS Versicherung pattern:
 *
 *   1. Listing: GET https://job.so.ch/?lang=de&offset={N}&limit={L} returns
 *      a fully server-rendered page with `a.job[href]` anchors, each
 *      carrying a "Region" / "Pensum" / "Vertrag" / "Arbeitswelt" /
 *      "Arbeitsbeginn" summary. Verified live: root fetch (no offset)
 *      already returns all 29 open positions in one page; `offset=20`
 *      returns the trailing 9 (strict subset, no new links) — pagination
 *      loop kept for future-proofing if the roster grows past one page.
 *   2. Each detail page (https://job.so.ch/offene-stellen/{slug}/{uuid})
 *      embeds a clean schema.org/JobPosting JSON-LD block (title,
 *      description, employmentType, datePosted, jobLocation.address with
 *      postalCode) used as the primary data source.
 *
 * Genuine cantonal public-sector employer — direct employer, not a
 * staffing agency. Distinct entity from `solothurner-spitaeler` /
 * `soh-solothurner-spitaeler` (the cantonal HOSPITAL GROUP, a separate
 * employer with its own Prospective tenant) already covered by
 * `solothurner-spitaeler-job-parser.mjs` / `soh-solothurner-spitaeler-job-
 * parser.mjs` — this parser covers the cantonal ADMINISTRATION itself
 * (general public-sector roles), which was genuinely uncovered.
 *
 * German-only source (no fr/it/en locale switcher observed on the board).
 *
 * Exports the standard functions consumed by `crawler-template.mjs`'s
 * `runStandardCrawlerPipeline`:
 *   - fetchAllKantonSolothurnJobs() — Fetch and parse all jobs
 *   - isKantonSolothurnJob()        — Match jobs belonging to this employer
 *   - isTrustedDomain()             — Validate URLs belong to this employer
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KANTON_SOLOTHURN_KEY = 'kanton-solothurn';
export const KANTON_SOLOTHURN_COMPANY_NAME = 'Kanton Solothurn';
export const KANTON_SOLOTHURN_COMPANY_DOMAIN = 'so.ch';

const CAREER_URL = 'https://job.so.ch/';
const BOARD_HOST = 'job.so.ch';
const LIST_PAGE_SIZE = 50;
const MAX_OFFSET = 2000; // safety cap against a runaway pagination loop
const REQUEST_DELAY_MS = 200;

const HQ = {
  city: 'Solothurn',
  canton: 'SO',
  postalCode: '4500',
  streetAddress: '',
  region: 'SO',
};

// "Arbeitswelt" taxonomy → internal category, captured verbatim from the
// listing card (see extractListingEntries()). Falls back to a title-regex
// guess when the listing didn't carry a recognised Arbeitswelt label.
const ARBEITSWELT_TO_CATEGORY = {
  'it & digital business': 'IT',
  'umwelt & infrastruktur': 'Ambiente & Infrastrutture',
  'sicherheit & justiz': 'Sicurezza & Giustizia',
  'bildung & kultur': 'Educazione & Cultura',
  'gesundheit & soziales': 'Sanità / Ospedali',
  'finanzen & steuern': 'Finanza',
  'wirtschaft & arbeit': 'Economia & Lavoro',
  'zentrale funktionen': 'Amministrazione',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Kanton Solothurn's cantonal administration.
 * Used by the template to filter this employer's jobs from the global
 * dataset. Deliberately does NOT match on bare "solothurn" (would collide
 * with the separate `solothurner-spitaeler` hospital-group employer).
 */
export function isKantonSolothurnJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KANTON_SOLOTHURN_KEY ||
    company === 'kanton solothurn' ||
    url.includes('job.so.ch')
  );
}

/**
 * Validate that a URL belongs to the Kanton Solothurn careers board.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === BOARD_HOST || host === 'karriere.so.ch' || host === 'so.ch' || host.endsWith('.so.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', arbeitswelt = '') {
  const mapped = ARBEITSWELT_TO_CATEGORY[normalize(arbeitswelt)];
  if (mapped) return mapped;

  const t = normalize(title);
  if (/\b(informatik|ict|system|software|developer|applikation|digital)/.test(t)) return 'IT';
  if (/\b(polizei|sicherheit|justiz|straf|gericht)/.test(t)) return 'Sicurezza & Giustizia';
  if (/\b(lehrer|lehrperson|schule|bildung|dozent|ausbildung)/.test(t)) return 'Educazione & Cultura';
  if (/\b(pflege|sozial|gesundheit|betreuung)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(finanz|steuer|buchhalt|rechnungswesen)/.test(t)) return 'Finanza';
  if (/\b(bau|tiefbau|umwelt|infrastruktur|forst|jagd|fischerei)/.test(t)) return 'Ambiente & Infrastrutture';
  if (/\b(lernend|praktik|stagiaire|apprenti)/.test(t)) return 'Formazione';
  return 'Amministrazione';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lernend|praktik|stagiaire|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|leiter|leiterin|chef|verantwort|direktor|manager|abteilungsleit)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Resolve the canton-gated address fields for a job.
 *
 * Mirrors the css-versicherung-job-parser.mjs `resolveAddress()` pattern:
 * postalCode and streetAddress are NEVER unconditionally backfilled from HQ
 * — only when the job's own inferred canton actually matches HQ's canton
 * (SO). Kanton Solothurn's own JSON-LD does carry an accurate per-job
 * postalCode in samples checked live (e.g. `4500` for Solothurn), but
 * `streetAddress` is empty in every sample seen — the canton-gated HQ
 * fallback below supplies it only when the job's own canton matches HQ.
 */
function resolveAddress(address = {}) {
  const rawLocality = normalizeSpace(address.addressLocality || '');
  const canton = rawLocality ? inferSwissTargetCanton(rawLocality) : '';
  const rawPostal = String(address.postalCode || '').trim();
  const postalCode = /^\d{4}$/.test(rawPostal) ? rawPostal : '';
  const rawStreet = normalizeSpace(address.streetAddress || '');

  if (!rawLocality || !canton) {
    // No usable location signal — fall back to HQ entirely (never dropped).
    return {
      city: HQ.city,
      canton: HQ.canton,
      postalCode: postalCode || HQ.postalCode,
      streetAddress: rawStreet || HQ.streetAddress,
      region: HQ.region,
    };
  }

  const isHqCity = /^solothurn$/i.test(rawLocality);
  return {
    city: rawLocality,
    canton,
    postalCode: postalCode || (isHqCity ? HQ.postalCode : ''),
    streetAddress: rawStreet || (isHqCity ? HQ.streetAddress : ''),
    region: canton,
  };
}

/* ── HTTP helpers ─────────────────────────────────────────── */

/**
 * Extract `{ url, arbeitswelt }` entries from one listing page's HTML.
 * Each `<a class="job" href="...">` card also carries a plain-text
 * "Arbeitswelt: <label>" line used here for accurate category tagging
 * (richer signal than a title-only regex guess).
 */
function extractListingEntries(html = '') {
  const entries = new Map();
  const re = /<a class="job"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = String(match[1] || '').trim();
    if (!href.includes('/offene-stellen/')) continue;
    const url = href.startsWith('http') ? href : new URL(href, CAREER_URL).toString();
    if (entries.has(url)) continue;

    const text = normalizeSpace(match[2].replace(/<[^>]+>/g, '|'));
    const worldMatch = text.match(/Arbeitswelt:\s*\|+\s*([^|]+)/);
    entries.set(url, { url, arbeitswelt: worldMatch ? worldMatch[1].trim() : '' });
  }
  return [...entries.values()];
}

/**
 * Discover every open job entry by paginating the listing endpoint until a
 * page contributes zero new links (root fetch already returns everything
 * in the live board today, but this loop future-proofs against roster
 * growth past a single page, mirroring the CSS Versicherung parser).
 */
async function collectAllJobEntries() {
  const seen = new Map();
  let offset = 0;

  while (offset < MAX_OFFSET) {
    const listUrl = offset === 0 ? CAREER_URL : `${CAREER_URL}?lang=de&offset=${offset}&limit=${LIST_PAGE_SIZE}`;
    let html;
    try {
      html = await fetchHtml(listUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    } catch (err) {
      console.warn(`  ⚠️  Listing fetch failed at offset=${offset}: ${err?.message || err}`);
      break;
    }

    const entries = extractListingEntries(html);
    if (!entries.length) break;

    let newCount = 0;
    for (const entry of entries) {
      if (!seen.has(entry.url)) {
        seen.set(entry.url, entry);
        newCount += 1;
      }
    }
    if (newCount === 0) break; // fully duplicate page → pagination exhausted

    offset += LIST_PAGE_SIZE;
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  return [...seen.values()];
}

/**
 * Extract and parse the schema.org JobPosting block embedded in a job
 * detail page.
 */
function parseJobPostingJsonLd(html = '') {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const payload = JSON.parse(match[1]);
      const candidates = Array.isArray(payload) ? payload : [payload];
      for (const candidate of candidates) {
        if (candidate && candidate['@type'] === 'JobPosting') return candidate;
      }
    } catch {
      // Malformed JSON-LD block — try the next <script> tag, if any.
    }
  }
  return null;
}

/* ── Main Fetcher ─────────────────────────────────────────── */

/**
 * Fetch and parse all open Kanton Solothurn cantonal-administration jobs.
 */
export async function fetchAllKantonSolothurnJobs() {
  console.log(`🔍 Fetching ${KANTON_SOLOTHURN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (Prospective careercenter listing + per-job JobPosting JSON-LD)\n`);

  const entries = await collectAllJobEntries();
  if (!entries.length) {
    console.warn('⚠️  No job listings discovered.');
    return [];
  }
  console.log(`  📋 Listings found: ${entries.length}`);

  const jobs = [];

  for (const entry of entries) {
    const jobUrl = entry.url;
    let html;
    try {
      html = await fetchHtml(jobUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    } catch (err) {
      console.warn(`  ⚠️  Skipping ${jobUrl} — fetch failed: ${err?.message || err}`);
      continue;
    }

    const jsonLd = parseJobPostingJsonLd(html);
    if (!jsonLd) {
      console.warn(`  ⚠️  Skipping ${jobUrl} — no JobPosting JSON-LD found`);
      continue;
    }

    const title = normalizeSpace(jsonLd.title || '');
    if (!title || title.length < 3) continue;

    const address = jsonLd.jobLocation?.address || {};
    const { city, canton, postalCode, streetAddress, region } = resolveAddress(address);

    let descriptionText = stripHtml(
      [jsonLd.description, jsonLd.responsibilities, jsonLd.qualifications]
        .filter(Boolean)
        .join('\n\n'),
    );
    const sourceLang = detectLang(descriptionText || title, 'de');

    // Thin-content guard (Non-Negotiable #4): never index < 50 words —
    // mirrors the enrichment pattern used by sibling parsers (e.g.
    // css-versicherung-job-parser.mjs) rather than dropping the job outright.
    const wordCount = descriptionText.split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) {
      descriptionText = [
        descriptionText || `${title} — ${KANTON_SOLOTHURN_COMPANY_NAME}, ${city}.`,
        'Der Kanton Solothurn ist Arbeitgeber für tausende Mitarbeitende in der kantonalen Verwaltung — von der Informatik über Bildung, Sicherheit und Justiz bis zu Umwelt, Finanzen und zentralen Verwaltungsfunktionen. Er bietet flexible Arbeitsmodelle, faire Anstellungsbedingungen auf Basis eines Gesamtarbeitsvertrags (GAV) und Weiterbildungsmöglichkeiten in einer sinnstiftenden Tätigkeit von politischer und gesellschaftlicher Relevanz.',
        'Bewirb dich direkt online über job.so.ch.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    const employmentType =
      String(jsonLd.employmentType || '').toUpperCase().trim() || detectEmploymentType(title);
    const applyUrl = String(jsonLd.url || '').trim() || jobUrl;
    const jobSlug = slugify(`${title} kanton solothurn ${city}`);
    const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const parsed = new Date(String(jsonLd.datePosted || ''));
      return Number.isNaN(parsed.getTime())
        ? new Date().toISOString().slice(0, 10)
        : parsed.toISOString().slice(0, 10);
    })();

    const job = {
      id: `${KANTON_SOLOTHURN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: jsonLd.hiringOrganization?.name?.replace(/​/g, '').trim() || KANTON_SOLOTHURN_COMPANY_NAME,
      companyKey: KANTON_SOLOTHURN_KEY,
      companyDomain: KANTON_SOLOTHURN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: `${KANTON_SOLOTHURN_COMPANY_NAME} Dedicated Parser (Prospective careercenter + JobPosting JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: region,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, entry.arbeitswelt),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Amministrazione pubblica',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  console.log(`\n📋 Total ${KANTON_SOLOTHURN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
