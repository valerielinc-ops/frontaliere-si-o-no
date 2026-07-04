#!/usr/bin/env node
/**
 * SWICA job parser — jobs.swica.ch career board.
 *
 * Discovery (issue #3342 row 50) tagged this employer ATS "Custom" —
 * VERIFIED WRONG live (2026-07-04). `jobs.swica.ch` is a Prospective.ch
 * (Aequivital AG) tenant: assets load from `/careercenter/1000922/` on the
 * listing page and `/directlink/1003249002/` on detail pages, and every
 * apply/share/tracking link on the detail page points at
 * `ohws.prospective.ch/public/v1/...`. HOWEVER, unlike most other
 * Prospective tenants in this codebase, medium 1000922 does NOT expose the
 * public `https://ohws.prospective.ch/public/v1/medium/{ID}/jobs` JSON API
 * (verified: every lang param returns `400 BAD_REQUEST` — same symptom
 * already documented for CSS Versicherung's tenant 1000981 in
 * `css-versicherung-job-parser.mjs`). The shared `createProspectiveChParser`
 * factory (`prospective-ch-job-parser-common.mjs`) therefore cannot be
 * reused here (would 400 on every request) — this parser scrapes the
 * tenant's own HTML front-end instead, mirroring the CSS Versicherung and
 * Spital Zofingen parsers rather than duplicating a new JSON-LD extractor:
 *
 * 1. Listing: GET https://jobs.swica.ch/?lang={lang}&offset={N}&limit={L}
 *    returns HTML with `<a href=".../offene-stellen/{slug}/{uuid}">` anchors.
 *    Paginate by offset until a page contributes zero NEW links. Verified
 *    live: 34 open positions, all discoverable at offset=0/limit=50 (a
 *    single page) — `lang` only changes UI chrome; the underlying job set
 *    and URLs are IDENTICAL across de/fr/it (each job already carries its
 *    own native-language title/slug baked into the URL).
 * 2. Each detail page (https://jobs.swica.ch/offene-stellen/{slug}/{uuid})
 *    embeds a single clean schema.org/JobPosting JSON-LD block (title,
 *    description, employmentType, datePosted, jobLocation.address with
 *    postalCode + streetAddress) — extracted via the shared
 *    `jsonld-jobposting.mjs` helper (`extractJobPostingLd`,
 *    `jobPostingDescriptionText`, `jobPostingAddress`), NOT a hand-rolled
 *    regex duplicate.
 *
 * SWICA is a national health insurer with real per-agency office locations
 * (verified live across all 34 postings): Bellinzona (TI), Lausanne (VD),
 * Winterthur/Zürich/Kloten/Wetzikon (ZH), Bern (BE), Basel (BS), Luzern (LU),
 * St. Gallen (SG), Schaffhausen (SH), Herisau (AR) — canton is inferred per
 * job from the JSON-LD `addressLocality` (the real city), never defaulted to
 * HQ for a non-HQ posting. `addressRegion` in SWICA's own JSON-LD is
 * sometimes a city label rather than a canton name (e.g. some Winterthur
 * postings emit `addressRegion: "Winterthur"`), so canton is ALWAYS derived
 * via `inferSwissTargetCanton(addressLocality)`, never trusted verbatim.
 *
 * HQ (used only as a last-resort fallback, city-gated — never leaked onto
 * a job in a different canton): Römerstrasse 38, 8401 Winterthur, ZH.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { extractJobPostingLd, jobPostingDescriptionText, jobPostingAddress } from './jsonld-jobposting.mjs';

/* ── Constants ─────────────────────────────────────────────── */
export const SWICA_KEY = 'swica';
export const SWICA_COMPANY_NAME = 'SWICA';
export const SWICA_COMPANY_DOMAIN = 'swica.ch';

const BOARD_HOST = 'jobs.swica.ch';
const LISTING_BASE = 'https://jobs.swica.ch/';
const LIST_PAGE_SIZE = 50;
const MAX_OFFSET = 2000; // safety cap against a runaway pagination loop
const REQUEST_DELAY_MS = 200;
const SECTOR = 'Assicurazioni';

const HQ = {
  city: 'Winterthur',
  canton: 'ZH',
  postalCode: '8401',
  streetAddress: 'Römerstrasse 38',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to SWICA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSwicaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SWICA_KEY ||
    key.startsWith('swica') ||
    company === 'swica' ||
    company.includes('swica gesundheitsorganisation') ||
    url.includes('jobs.swica.ch')
  );
}

/**
 * Validate that a URL belongs to SWICA's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'swica.ch' || host === BOARD_HOST || host.endsWith('.swica.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(arzt|ärztin|arztin|telemedizin|psychotherap|pflegefachperson|pflege|gesundheitsberater)/.test(t)) return 'Sanità';
  if (/\b(underwrit|schaden|sinistr|claims|leistung|fallmanagement)/.test(t)) return 'Assicurazioni';
  if (/\b(kundenberat|kundenbetreu|consulen.*client|conseill.*client|customer|service client|gestionnaire.*sant|gestionnaire.*client)/.test(t)) return 'Servizio Clienti';
  if (/\b(vendita|sales|verkauf|vente|akquisi|acquisiz|versicherungsberater)/.test(t)) return 'Commerciale';
  if (/\b(it|software|develop|programm|data|cloud|devops|cyber|network engineer)/.test(t)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|account|comptab|sachbearbeiter)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|risorse|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|communication|academy|trainer)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|controll)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|jurid|compliance)/.test(t)) return 'Legale';
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager|teamleiter|leiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Resolve the canton-gated address fields for a job.
 *
 * Mirrors `css-versicherung-job-parser.mjs`'s `resolveAddress()` pattern:
 * postalCode and streetAddress are NEVER unconditionally backfilled from HQ
 * — only when the job's own inferred canton matches HQ's canton. SWICA's own
 * JSON-LD supplies an accurate per-job postalCode/streetAddress for every
 * live posting observed, so that value is always preferred when present;
 * the HQ fallback exists purely as a Non-Negotiable #3 safety net for a
 * future posting that omits address data.
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
    };
  }

  const isHqCity = /winterthur/i.test(rawLocality);
  return {
    city: rawLocality,
    canton,
    postalCode: postalCode || (isHqCity ? HQ.postalCode : ''),
    streetAddress: rawStreet || (isHqCity ? HQ.streetAddress : ''),
  };
}

/* ── HTTP helpers ─────────────────────────────────────────── */

/**
 * Extract job detail URLs from one listing page's HTML.
 */
function extractListingLinks(html = '') {
  const links = new Set();
  const re = /<a\s+href="([^"]+\/offene-stellen\/[^"]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = String(match[1] || '').trim();
    links.add(href.startsWith('http') ? href : new URL(href, LISTING_BASE).toString());
  }
  return [...links];
}

/**
 * Discover every open job URL by paginating the listing endpoint until a
 * page contributes zero new links.
 */
async function collectAllJobUrls() {
  const seen = new Set();
  let offset = 0;

  while (offset < MAX_OFFSET) {
    const listUrl = `${LISTING_BASE}?lang=de&offset=${offset}&limit=${LIST_PAGE_SIZE}`;
    let html;
    try {
      html = await fetchHtml(listUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    } catch (err) {
      console.warn(`  ⚠️  Listing fetch failed at offset=${offset}: ${err?.message || err}`);
      break;
    }

    const links = extractListingLinks(html);
    if (!links.length) break;

    let newCount = 0;
    for (const link of links) {
      if (!seen.has(link)) {
        seen.add(link);
        newCount += 1;
      }
    }
    if (newCount === 0) break; // fully duplicate page → pagination exhausted

    offset += LIST_PAGE_SIZE;
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  return [...seen];
}

/* ── Main Fetcher ─────────────────────────────────────────── */

/**
 * Fetch and parse all open SWICA jobs.
 */
export async function fetchAllSwicaJobs() {
  console.log(`🔍 Fetching ${SWICA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_BASE} (Prospective careercenter listing + per-job JobPosting JSON-LD)\n`);

  const jobUrls = await collectAllJobUrls();
  if (!jobUrls.length) {
    console.warn('⚠️  No job listings discovered.');
    return [];
  }
  console.log(`  📋 Listings found: ${jobUrls.length}`);

  const jobs = [];

  for (const jobUrl of jobUrls) {
    let html;
    try {
      html = await fetchHtml(jobUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    } catch (err) {
      console.warn(`  ⚠️  Skipping ${jobUrl} — fetch failed: ${err?.message || err}`);
      continue;
    }

    const jsonLd = extractJobPostingLd(html);
    if (!jsonLd) {
      console.warn(`  ⚠️  Skipping ${jobUrl} — no JobPosting JSON-LD found`);
      continue;
    }

    const title = normalizeSpace(jsonLd.title || '');
    if (!title || title.length < 3) continue;

    const address = jobPostingAddress(jsonLd);
    const { city, canton, postalCode, streetAddress } = resolveAddress(address);

    let descriptionText = jobPostingDescriptionText(jsonLd.description || '');
    const sourceLang = detectLang(descriptionText || title, 'de');

    // Thin-content guard (Non-Negotiable #4): never index < 50 words —
    // mirrors the enrichment pattern used by sibling parsers (e.g.
    // css-versicherung-job-parser.mjs) rather than dropping the job outright.
    const wordCount = descriptionText.split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) {
      descriptionText = [
        descriptionText || `${title} — ${SWICA_COMPANY_NAME}, ${city}.`,
        'SWICA ist eine der führenden Kranken- und Unfallversicherungen der Schweiz mit rund 1,7 Millionen Versicherten und einem Netz von Agenturen und Gesundheitszentren in der ganzen Schweiz. Seit über 100 Jahren begleitet SWICA Menschen in der Schweiz mit Grundversicherung, Zusatzversicherungen und Gesundheitsförderung und bietet ihren Mitarbeitenden flexible Arbeitsmodelle, Weiterbildungsmöglichkeiten und ein dynamisches Arbeitsumfeld.',
        'Bewirb dich direkt online über jobs.swica.ch.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    const employmentType =
      String(jsonLd.employmentType || '').toUpperCase().trim() || detectEmploymentType(title);
    const applyUrl = String(jsonLd.url || '').trim() || jobUrl;
    const jobSlug = slugify(`${title} swica ${city}`);
    const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const parsed = new Date(String(jsonLd.datePosted || ''));
      return Number.isNaN(parsed.getTime())
        ? new Date().toISOString().slice(0, 10)
        : parsed.toISOString().slice(0, 10);
    })();

    const job = {
      id: `${SWICA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: jsonLd.hiringOrganization?.name || SWICA_COMPANY_NAME,
      companyKey: SWICA_KEY,
      companyDomain: SWICA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: `${SWICA_COMPANY_NAME} Dedicated Parser (Prospective careercenter + JobPosting JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
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

  console.log(`\n📋 Total ${SWICA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
