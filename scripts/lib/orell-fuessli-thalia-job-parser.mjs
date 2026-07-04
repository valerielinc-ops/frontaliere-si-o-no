#!/usr/bin/env node
/**
 * Orell Füssli Thalia AG job parser — custom Drupal 11 career microsite,
 * NOT a third-party ATS despite issue #3337 tagging it "Custom" (this label
 * turns out accurate, but the underlying stack was undiscovered — worth
 * documenting so a future pass doesn't re-run the same probe).
 *
 * Discovery (issue #3337 backlog row): the marketing domain
 * www.orellfuessli.ch sits behind a Cloudflare interactive challenge
 * (`cf-mitigated: challenge`) and is unreachable via plain curl. The
 * dedicated careers subdomain karriere.orellfuessli.ch is NOT behind that
 * challenge and returns `<meta name="Generator" content="Drupal 11">` on
 * every page — this is a bespoke Drupal "Views" job board (listing at
 * /de/offene-stellen, one node per posting at
 * /de/offene-stellen/{slug}), not Personio/Softgarden/Umantis/etc. No known
 * ATS script host, iframe, or login-link leak was found anywhere on the
 * career site. Every listing card link carries `class="c-job-teaser"`,
 * which cleanly disambiguates job links from nav/filter links sharing the
 * same `/de/offene-stellen/*` path prefix.
 *
 * The "Jetzt bewerben" (Apply now) button on each detail page DOES leak a
 * real ATS: it points at
 * `https://career74.sapsf.eu/careers?company=OFThalia&career_job_req_id={id}&career_ns=job_application&lang=de_DE`
 * — SAP SuccessFactors Recruiting (tenant "OFThalia"), confirming the
 * "shares infrastructure with the German Thalia parent" hunch from the
 * issue, since Thalia Group DE is a known SAP SuccessFactors shop. However
 * this SF instance is used ONLY as the final application-form backend
 * (`career_ns=job_application`, no listing/search surface reachable from
 * it) — it is not the source of listing/detail data, so the shared
 * `./ats-clients/successfactors-client.mjs` genuinely does not fit here:
 * `detectSuccessFactorsKind()` only recognises `career{N}.successfactors.eu`
 * / `careerN.sapsf.eu` HTML-career pages (title `Career Opportunities: …`,
 * `joqReqDescription` div) or OData feeds — `career74.sapsf.eu/careers?...`
 * is a bare apply-form deep link with none of that shape, and every field
 * we need (title, datePosted, hiringOrganization, jobLocation, full
 * description) is already served directly by the Drupal detail page as
 * inline schema.org JSON-LD, which is both richer and far simpler to trust
 * than reverse-engineering the SF apply funnel. Hence a bespoke parser.
 *
 * Each Drupal detail page embeds:
 *   <script type="application/ld+json">{"@context":"https://schema.org",
 *     "@graph":[{"@type":"JobPosting","title":…,"datePosted":…,
 *     "hiringOrganization":{"name":"Orell Füssli",…},
 *     "jobLocation":{"address":{"addressLocality":…,"addressCountry":"CH"}},
 *     "description":…}]}</script>
 * The JSON-LD `description` field is plain text but includes trailing
 * apply-widget noise (contact blurb + button label runs straight into the
 * string with no separator). The rendered HTML body
 * (`<div class="c-text-block-layout c-text-block-layout--text">…</div>`,
 * unique per detail page) is clean semantic HTML (h3/p/strong/br, no nested
 * divs) with none of that noise, so it is preferred; the JSON-LD field is
 * kept only as a fallback if the HTML block is ever absent (template
 * change).
 *
 * Verified live 2026-07-04: 19 open Swiss postings across Zürich,
 * Rapperswil, Luzern, St. Gallen, Spreitenbach, Urtenen-Schönbühl, Bern,
 * Weinfelden, Uster, Würenlos, Basel — single listing page, no pagination
 * needed at this volume.
 *
 * HQ: Orell Füssli Thalia AG, Dietzingerstrasse 3, 8003 Zürich ZH.
 * Confirmed via Handelsregister/Zefix (CHE-172.909.619, legal seat Zürich,
 * domicile Dietzingerstrasse 3, 8003 Zürich per SHAB mutation) and
 * cross-checked against the company's own jobs.ch profile listing the same
 * address.
 *
 * resolveAddress() gates the HQ street/postal fallback on the job's own
 * resolved CITY TEXT via regex (mirrors scripts/lib/staubli-job-parser.mjs
 * and scripts/lib/veeam-job-parser.mjs) — NEVER on canton alone. Uster is
 * ZH (same canton as the Zürich HQ) but is a different city and correctly
 * does NOT inherit the Dietzingerstrasse 3 street address (see
 * tests/orell-fuessli-thalia-crawler.test.ts).
 *
 * Exports 4 functions expected by the crawler template:
 * - fetchAllOrellFuessliThaliaJobs() — Fetch and parse all Swiss jobs
 * - isOrellFuessliThaliaJob() — Match jobs belonging to this company
 * - isTrustedDomain() — Validate URLs belong to this company
 * - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import {
  slugify,
  stripHtml,
  fetchHtml,
  normalizeDescriptionSpace,
  normalizeDescriptionBullets,
} from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ──────────────────────────────────────────────── */

export const ORELL_FUESSLI_THALIA_KEY = 'orell-fuessli-thalia';
export const ORELL_FUESSLI_THALIA_COMPANY_NAME = 'Orell Füssli Thalia';
export const ORELL_FUESSLI_THALIA_COMPANY_DOMAIN = 'orellfuessli.ch';

const CAREER_URL = 'https://karriere.orellfuessli.ch/de/offene-stellen';
const CAREER_HOST = 'karriere.orellfuessli.ch';

/* HQ — Dietzingerstrasse 3, 8003 Zürich ZH (Handelsregister/Zefix, see file header) */
const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8003',
  streetAddress: 'Dietzingerstrasse 3',
  region: 'Zürich',
};

const SECTOR = 'Retail / Librerie e Cartoleria';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Helpers ────────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ───────────────────────────────────────── */

/**
 * Check if job belongs to Orell Füssli Thalia.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isOrellFuessliThaliaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const url = normalize(job?.url || '');

  return (
    key === ORELL_FUESSLI_THALIA_KEY ||
    key.startsWith('orell-fuessli') ||
    company.includes('orell fussli') ||
    company.includes('orell-fussli') ||
    url.includes('orellfuessli.ch')
  );
}

/**
 * Validate URL belongs to Orell Füssli Thalia's own domain OR the leaked
 * SAP SuccessFactors apply-form tenant (career74.sapsf.eu?company=OFThalia).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'orellfuessli.ch' || host.endsWith('.orellfuessli.ch')) return true;
    if (host.endsWith('.sapsf.eu') && /company=ofthalia/i.test(rawUrl)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Classifiers ────────────────────────────────────────────── */

export function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ict|it[- ]?support|systemadministrat)/.test(t)) return 'IT';
  if (/\b(logistik)/.test(t)) return 'Logistica';
  if (/\b(filialleit|abteilungsleit|stv\.?\s*filialleit)/.test(t)) return 'Management';
  if (/\b(lernend|lehrling|efz)/.test(t)) return 'Apprendistato';
  if (/\b(buchh[aä]ndler|detailhandel|kundenservice|papeterie)/.test(t)) return 'Vendita';
  return 'Retail';
}

export function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lernend|lehrling|efz|praktik|stage|stagiair|intern|apprendist|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(filialleit|abteilungsleit|senior|sr|lead|head|director|dirett|chef|verantwort|responsab|stv\.?\s*filialleit)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Infer employment type from title (Swiss retail postings encode work
 * percentage in the title, e.g. "Filialleitung 80% (a)", "… 40 - 50% (a)").
 * Mirrors scripts/lib/denner-job-parser.mjs's `inferEmploymentType()`
 * threshold convention (max pct < 80 → PART_TIME).
 */
export function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/\b(lernend|lehrling|efz|praktik|stage|stagiair|apprendist|apprenti)/.test(t)) return 'INTERN';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    if (Number.isFinite(maxPct) && maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/**
 * Pick best city / postal code / street / region for a posting, falling
 * back to the documented HQ address (Zürich) ONLY when the job's own
 * resolved city text is empty OR textually matches the HQ city itself.
 *
 * CRITICAL (per AGENTS.md Non-Negotiable / known recurring bug class): the
 * gate is a regex against the CITY TEXT, never canton equality — Uster is
 * ZH (same canton as the Zürich HQ) but is a different city and must NOT
 * inherit Dietzingerstrasse 3 / 8003. See
 * tests/orell-fuessli-thalia-crawler.test.ts for the regression test.
 */
export function resolveAddress(rawCity = '') {
  const city = normalizeSpace(rawCity);
  const isHqCity = !city || /^z(?:ü|u)rich$/i.test(city);

  return {
    city: city || HQ.city,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
    region: HQ.region,
  };
}

/* ── JSON-LD / HTML extraction ─────────────────────────────── */

/**
 * Extract the schema.org JobPosting node from a Drupal detail page's inline
 * JSON-LD `<script type="application/ld+json">` block.
 */
export function extractJobPostingJsonLd(html = '') {
  const m = String(html || '').match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!m) return null;
  let parsed;
  try {
    parsed = JSON.parse(m[1].trim());
  } catch {
    return null;
  }
  const nodes = Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed];
  return (
    nodes.find((n) => {
      const t = n?.['@type'];
      return Array.isArray(t)
        ? t.some((x) => String(x || '').toLowerCase() === 'jobposting')
        : String(t || '').toLowerCase() === 'jobposting';
    }) || null
  );
}

/**
 * Extract the clean rendered-HTML description block
 * (`<div class="c-text-block-layout c-text-block-layout--text">…</div>`),
 * preferred over the JSON-LD `description` field which runs straight into
 * apply-widget/contact noise with no separator (see file header).
 */
export function extractDescriptionHtml(html = '') {
  const m = String(html || '').match(
    /<div class="c-text-block-layout c-text-block-layout--text">([\s\S]*?)<\/div>/i,
  );
  return m ? m[1] : '';
}

function buildDescription(html = '', jsonLdDescription = '') {
  const htmlBlock = extractDescriptionHtml(html);
  const fromHtml = htmlBlock ? normalizeDescriptionSpace(stripHtml(htmlBlock)) : '';
  const fromJsonLd = jsonLdDescription
    ? normalizeDescriptionSpace(stripHtml(String(jsonLdDescription)))
    : '';
  const best = fromHtml.length >= fromJsonLd.length ? fromHtml : fromJsonLd;
  return normalizeDescriptionBullets(best);
}

/* ── Fetch + Parse ──────────────────────────────────────────── */

/**
 * Fetch the listing page and extract every job-detail URL. Listing cards
 * carry `class="c-job-teaser"`, which cleanly disambiguates them from other
 * `/de/offene-stellen/*` nav/filter links (e.g. the apprenticeship filter
 * page `/de/offene-stellen/offene-lehrstellen`).
 */
async function fetchListingUrls() {
  const html = await fetchHtml(CAREER_URL);
  const re = /<a href="(\/de\/offene-stellen\/[a-z0-9-]+)" class="c-job-teaser">/g;
  const urls = new Set();
  let m;
  while ((m = re.exec(html))) {
    urls.add(`https://${CAREER_HOST}${m[1]}`);
  }
  return [...urls];
}

/**
 * Fetch and parse every job listing (source-locale only). Returns raw
 * listing objects consumed by fetchAllOrellFuessliThaliaJobs().
 */
async function fetchJobListings() {
  const urls = await fetchListingUrls();
  const listings = [];
  for (const url of urls) {
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`⚠️ ${ORELL_FUESSLI_THALIA_COMPANY_NAME}: failed to fetch ${url}: ${err?.message || err}`);
      continue;
    }
    const node = extractJobPostingJsonLd(html);
    if (!node) {
      console.warn(`⚠️ ${ORELL_FUESSLI_THALIA_COMPANY_NAME}: no JobPosting JSON-LD on ${url}`);
      continue;
    }
    const title = normalizeSpace(node.title || '');
    if (!title) continue;
    const city =
      node.jobLocation?.address?.addressLocality ||
      node.jobLocation?.name ||
      '';
    listings.push({
      title,
      city: normalizeSpace(city),
      postedAt: node.datePosted || null,
      description: buildDescription(html, node.description),
      url,
    });
    await sleep(300);
  }
  return listings;
}

/**
 * Fetch all Orell Füssli Thalia jobs (Switzerland only — the whole career
 * site IS Swiss-only, no country filter needed).
 * Returns array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled in by
 * the AI localization step of the translate-pending pipeline.
 */
export async function fetchAllOrellFuessliThaliaJobs() {
  console.log(`🔍 Fetching ${ORELL_FUESSLI_THALIA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`   📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const { city, postalCode, streetAddress, region } = resolveAddress(listing.city);
    const location = city || HQ.city;
    const canton = inferSwissTargetCanton(location) || HQ.canton;

    const descriptionText = listing.description || '';
    const description =
      descriptionText || `${title} bei ${ORELL_FUESSLI_THALIA_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} orell fuessli thalia ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${ORELL_FUESSLI_THALIA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ORELL_FUESSLI_THALIA_COMPANY_NAME,
      companyKey: ORELL_FUESSLI_THALIA_KEY,
      companyDomain: ORELL_FUESSLI_THALIA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Orell Füssli Thalia Dedicated Parser (Drupal career site)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, AGENTS.md Non-Negotiable #3) ──
      addressLocality: city,
      addressRegion: region || canton,
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
      applyUrl: publicUrl,
      jobReqId: null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${ORELL_FUESSLI_THALIA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { slugify, stripHtml };
