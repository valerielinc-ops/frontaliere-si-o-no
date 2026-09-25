#!/usr/bin/env node
/**
 * ZFV-Unternehmungen job parser — Fetcher job builder.
 *
 * Source: https://jobs.zfv.ch/stellenangebote.html (rexx systems ATS)
 *
 * Genossenschaft ZFV-Unternehmungen operates restaurants, staff canteens
 * (Personalgastronomie / Betriebsgastronomie) and care homes (Alters- und
 * Pflegeheime) across Switzerland. Nationwide employer — no single home
 * canton (sample listing spans Bern, Basel, Luzern, Rapperswil, …).
 *
 * Discovery note: the campaign discovery tag listed this employer as
 * "Custom", but the live site is standard **rexx systems** SaaS ATS
 * (rexx-systems.com GmbH) — same tenant markup already used in this repo
 * for Senevita / Globus / Zuger Kantonsspital / Spital Schwyz / Kantonsspital
 * Uri. Verified via page source (rexxCha script, joboffer_container markup)
 * live curl of the listing + detail HTML.
 *
 * Crawl strategy:
 * 1. GET stellenangebote.html?start={0,50,100,…} — server-rendered listing,
 *    ~50 results/page (`<div class="joboffer_container"
 *    onclick="window.location.href='…'">`). Reuse `parseRexxListing()` from
 *    `./rexx-systems-job-parser-common.mjs` instead of duplicating the
 *    listing regex — same tenant markup, already shared by other rexx
 *    tenants in this repo.
 * 2. Per job, GET the detail page — it embeds an inline
 *    `<script type="application/ld+json">{ "@type": "JobPosting", … }</script>`
 *    block whose `description` field already concatenates the intro
 *    paragraph + all `<h2>` sections + benefits pre-composed by the CMS
 *    (richer than scraping `<h2>` headlines ourselves). Also carries
 *    `datePosted`, `validThrough`, `employmentType`, `jobLocation.address`
 *    (real per-job `streetAddress` + `postalCode` + `addressLocality`) and
 *    `hiringOrganization`.
 * 3. `jobLocation.address.addressRegion` is always `null` at source, so we
 *    infer the canton from the city via `inferAnyCanton()` (nationwide
 *    lookup), falling back to the ZFV head-office canton (ZH) only if that
 *    fails.
 *
 * Notes:
 * - This tenant's detail pages use their own `<h2>` headline vocabulary
 *   ("Dein Wirkungsbereich:", "Deine Stärken:", "Bei uns findest du:") which
 *   the shared factory's `extractRexxDetail()` `CONTENT_HEADLINE_RX` does
 *   not recognise (that list only had "Deine Aufgaben/Dein Profil/…"
 *   variants) — but since the JSON-LD `description` field already contains
 *   the full composed text, we don't need HTML-headline scraping here at
 *   all, so `createRexxSystemsParser()`/`extractRexxDetail()` are not used.
 * - `baseSalary` is not present at source (typical for Swiss job boards).
 *   Per repo convention (same as Kulm Hotel / Senevita / Globus dedicated
 *   parsers), we do not fabricate `salaryMin`/`salaryMax` here — the shared
 *   `buildJobPostingSchema()` (build-plugins/shared/jobPostingSchema.ts)
 *   guarantees a realistic per-canton default downstream (CLAUDE.md rule #3).
 *
 * Exports 4 functions expected by the crawler template:
 * - fetchAllZfvUnternehmungenJobs() — Fetch + parse all jobs
 * - isZfvUnternehmungenJob() — Match jobs belonging to this company
 * - isTrustedDomain() — Validate URLs belong to this company
 * - slugify() / stripHtml() — re-exported from crawler-template.mjs by callers
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { decodeEntities, htmlToText } from './hospital-custom-html-helpers.mjs';
import { parseRexxListing } from './rexx-systems-job-parser-common.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ZFV_UNTERNEHMUNGEN_KEY = 'zfv-unternehmungen';
export const ZFV_UNTERNEHMUNGEN_COMPANY_NAME = 'ZFV-Unternehmungen';
export const ZFV_UNTERNEHMUNGEN_COMPANY_DOMAIN = 'zfv.ch';

const CAREER_URL = 'https://jobs.zfv.ch/stellenangebote.html';
const ATS_HOST = 'jobs.zfv.ch';
const SECTOR = 'Ospitalità / Ristorazione';

// Observed page size for this tenant (76 jobs total: start=0 → 50, start=50 → 26).
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const DETAIL_DELAY_MS = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 250;

// HQ fallback (Impressum: Flüelastrasse 51, 8047 Zürich) — used only when a
// detail page is missing address data entirely.
const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8047',
  streetAddress: 'Flüelastrasse 51',
};

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 FrontaliereTicinoBot/1.0';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/* ── Company matching ─────────────────────────────────────── */

/**
 * Match a job object as belonging to ZFV-Unternehmungen.
 */
export function isZfvUnternehmungenJob(job) {
  if (!job) return false;
  const key = normalize(job.companyKey);
  const company = normalize(job.company);
  const url = normalize(job.url);
  return (
    key === ZFV_UNTERNEHMUNGEN_KEY ||
    company.includes('zfv') ||
    url.includes('jobs.zfv.ch') ||
    url.includes('zfv.ch')
  );
}

/**
 * Validate that a URL belongs to ZFV-Unternehmungen's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'zfv.ch' || host.endsWith('.zfv.ch') || host === ATS_HOST;
  } catch {
    return false;
  }
}

/* ── Category / classification ─────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(sous.?chef|chef de partie|k[üu]chenchef|k[öo]ch|hilfsk[öo]ch|konditor)/.test(t)) return 'Cucina';
  if (/\b(service|kellner|buffet|bar.?mitarbeit|restaurationsfach)/.test(t)) return 'Servizio';
  if (/\b(gouvernante|hauswirtschaft|housekeep)/.test(t)) return 'Housekeeping';
  if (/\b(r[ée]ceptionist|front.?desk|front.?office|portier)/.test(t)) return 'Ricevimento';
  if (/\b(catering|event)/.test(t)) return 'Eventi & Catering';
  if (/\b(pflege|fage|betreuung|heim)/.test(t)) return 'Cura / Assistenza';
  if (/\b(betriebsleiter|leiter|leitung|f[üu]hrung)/.test(t)) return 'Management';
  if (/\b(lehrstelle|lernend|praktikant|efz|ausbildung)/.test(t)) return 'Formazione';
  if (/\b(admin|office|legal|assistent)/.test(t)) return 'Amministrazione';
  return 'Ospitalità / Ristorazione';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrstelle|lernend|praktikant|aushilfe|hilfsk)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(chef|leiter|leitung|senior|sr|f[üu]hrung)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentTypeFromTitle(title = '') {
  const t = normalize(title);
  const pct = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'FULL_TIME';
}

/* ── Detail page — JSON-LD JobPosting ────────────────────────── */

/**
 * Extract the first `application/ld+json` JobPosting object from a
 * ZFV job detail page. Returns the parsed object, or null.
 */
export function extractJobPostingJsonLd(html = '') {
  if (!html) return null;
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : (data && data['@graph']) || [data];
      const posting = items.find((item) => item && item['@type'] === 'JobPosting');
      if (posting) return posting;
    } catch {
      // malformed block — try next <script> tag
    }
  }
  return null;
}

function cleanAddressPart(v = '') {
  return normalizeSpace(decodeEntities(String(v || '')));
}

/* ── Listing pagination ──────────────────────────────────────── */

async function fetchAllListings() {
  const listings = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE;
    const url = start === 0 ? CAREER_URL : `${CAREER_URL}?start=${start}`;
    let html = '';
    try {
      html = await fetchHtml(url, { headers: { 'User-Agent': UA } });
    } catch (err) {
      console.warn(`  ⚠️ Listing fetch failed at start=${start}: ${err?.message || err}`);
      break;
    }
    const entries = parseRexxListing(html);
    let added = 0;
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      listings.push(entry);
      added += 1;
    }
    console.log(`  📄 start=${start}: +${added} (total: ${listings.length})`);
    if (added === 0) break;
  }
  return listings;
}

/* ── Main fetch pipeline ──────────────────────────────────────── */

/**
 * Fetch all ZFV-Unternehmungen jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only source-locale fields are set here. Other locales are
 * filled in by the AI localization step in the translate-pending pipeline.
 */
export async function fetchAllZfvUnternehmungenJobs() {
  console.log(`🔍 Fetching ${ZFV_UNTERNEHMUNGEN_COMPANY_NAME} jobs`);
  console.log(`  Source: ${CAREER_URL} (rexx systems ATS)\n`);

  const listings = await fetchAllListings();
  if (!listings.length) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }
  console.log(`  📋 Total listings discovered: ${listings.length}`);

  const jobs = [];
  for (let i = 0; i < listings.length; i++) {
    const entry = listings[i];
    let posting = null;
    try {
      const detailHtml = await fetchHtml(entry.detailUrl, { headers: { 'User-Agent': UA } });
      posting = extractJobPostingJsonLd(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${entry.title} (j${entry.id}): ${err?.message || err}`);
    }
    if (i < listings.length - 1) {
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    const title = normalizeSpace(decodeEntities(posting?.title || entry.title || ''));
    if (!title || title.length < 3) continue;

    const address = posting?.jobLocation?.address || {};
    const city = cleanAddressPart(address.addressLocality) || HQ.city;
    const postalCode = cleanAddressPart(address.postalCode) || HQ.postalCode;
    const streetAddress = cleanAddressPart(address.streetAddress) || HQ.streetAddress;
    const canton = inferAnyCanton(city) || HQ.canton;

    const descriptionHtml = posting?.description || '';
    const descriptionText = descriptionHtml ? normalizeSpace(htmlToText(descriptionHtml)) : '';
    // Safe default only if the JSON-LD description is missing/too thin
    // (never observed live, but guards against a malformed detail page).
    const description =
      descriptionText && descriptionText.split(/\s+/).length >= 20
        ? descriptionText
        : `${title} — ${ZFV_UNTERNEHMUNGEN_COMPANY_NAME}, ${city}. ` +
          'Genossenschaft ZFV-Unternehmungen betreibt Personalrestaurants, ' +
          'Gastronomiebetriebe und Alters- und Pflegeheime in der ganzen Schweiz.';

    const employmentTypeRaw = normalize(posting?.employmentType || '');
    const employmentType =
      employmentTypeRaw === 'part_time'
        ? 'PART_TIME'
        : employmentTypeRaw === 'full_time'
          ? 'FULL_TIME'
          : detectEmploymentTypeFromTitle(title);

    const postedDate =
      posting?.datePosted && !Number.isNaN(new Date(posting.datePosted).getTime())
        ? new Date(posting.datePosted).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${ZFV_UNTERNEHMUNGEN_KEY} ${city}`);
    const urlHash = createHash('sha1').update(entry.detailUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `${ZFV_UNTERNEHMUNGEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ZFV_UNTERNEHMUNGEN_COMPANY_NAME,
      companyKey: ZFV_UNTERNEHMUNGEN_KEY,
      companyDomain: ZFV_UNTERNEHMUNGEN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: entry.detailUrl,
      source: 'ZFV-Unternehmungen Dedicated Parser (rexx systems)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      needsRetranslation: true,

      // ── Recommended / structured-data fields (CLAUDE.md rule #3) ──
      addressLocality: city,
      postalCode,
      streetAddress,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: entry.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    console.log(`  ✅ ${(i + 1).toString().padStart(2)}/${listings.length}: ${title.substring(0, 55)} — ${city}`);
  }

  console.log(`\n📋 Total ${ZFV_UNTERNEHMUNGEN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
