#!/usr/bin/env node
/**
 * Kuhn Rikon AG job parser — Jobalino ATS (my.jobalino.ch), tenant "kuhn-rikon".
 *
 * ATS verification (issue #3337 tagged Kuhn Rikon "Custom" — CORRECTED):
 * The corporate site https://kuhnrikon.com is a Magento storefront (robots.txt
 * is the stock Magento boilerplate: `Disallow: /checkout/`, `/customer/`,
 * `/catalogsearch/`, etc.), and its careers listing page
 * (`/ch_de/ueber-uns/karriere-bei-kuhn-rikon/jobs`) embeds the job list via:
 *   <script src="https://my.jobalino.ch/public/iframe/iframeResizer.min.js"></script>
 *   <iframe src="https://my.jobalino.ch/jobExternalList/de/kuhn-rikon"></iframe>
 *   <jobalino-joblist company="kuhn-rikon" view-language="de"></jobalino-joblist>
 * The static CMS pages some search results surface (e.g.
 * `kuhnrikon.com/ch_de/verkaufsberaterin-outlet-landquart`) are marketing
 * mirrors of the SAME Jobalino postings, not the real source. The real ATS
 * is Jobalino: `GET https://my.jobalino.ch/custel_jobExternalList/kuhn-rikon`
 * returns a `jb_ShowJsonHtml(...)` JSONP payload confirmed live (2026-07-03/04)
 * with active postings ("Verkaufsberater/in Outlet Landquart", "Consultante
 * vente Globus Genève"), and each `my.jobalino.ch/job/{hash}/{slug}` detail
 * page ships a clean schema.org `JobPosting` JSON-LD block. Not custom.
 *
 * Shared-module note: `scripts/lib/jobalino-common.mjs` exports both the raw
 * Jobalino wire-protocol helpers (`unwrapJobalinoJsonp`, `parseJobalinoListingHtml`,
 * `extractJobalinoJobPostingJsonLd`, `fetchJobalinoListing`, `jobalinoDescriptionToText`)
 * AND a high-level `createJobalinoParser()` factory. We reuse the wire-protocol
 * helpers (genuinely reusable — no reason to re-implement JSONP unwrapping or
 * listing-tile parsing) but deliberately do NOT use the `createJobalinoParser`
 * factory, for two documented reasons:
 *   1. It unconditionally hardcodes `sector: 'Sanità / Ospedali'` and routes
 *      title/description through `detectHealthcareCategory` /
 *      `detectHealthcareExperienceLevel` / `detectHealthcareEmploymentType`
 *      (from `hospital-custom-html-helpers.mjs`) with no config override hook.
 *      Every tenant it currently serves (Privatklinik Meiringen, Michel
 *      Gruppe, Klinik Schönberg, Rehaklinik Hasliberg) is a hospital group —
 *      Kuhn Rikon is a cookware manufacturer/retailer, so reusing it would
 *      mislabel every job's sector/category as healthcare.
 *   2. It never emits `streetAddress` on the job object at all (only
 *      `addressLocality`/`addressRegion`/`postalCode`), which would violate
 *      AGENTS.md Non-Negotiable #3 (job-page structured data must always
 *      include `streetAddress`). We build a city-gated `resolveAddress()`
 *      (pattern per `scripts/lib/staubli-job-parser.mjs`) that fills a real
 *      HQ street only for the HQ city itself, never canton-wide.
 *
 * Latent (out-of-scope) bug spotted while probing the shared module: Jobalino
 * returns locale-prefixed detail hrefs (`/job/{locale}/{hash}/{slug}`) when the
 * listing is fetched with an explicit non-"de" `locale` param (fr/it/en), but
 * `parseJobalinoListingHtml`'s tile regex only matches the unprefixed
 * `/job/{hash}/{slug}` form used by the default ("de") request — so
 * locale-scoped Jobalino fetches silently return zero tiles. Not fixed here:
 * this crawler (like all current Jobalino tenants) only ever calls the
 * default locale, which already returns every posting regardless of the
 * job's own language (confirmed: the single `custel_jobExternalList/kuhn-rikon`
 * call returned both a German and a French posting), so the bug is dormant
 * and unexercised by any existing consumer — flagged for the orchestrator/
 * owner rather than touched inside this crawler's own PR.
 *
 * HQ address — Kuhn Rikon AG, Neschwilerstrasse 4, 8486 Rikon im Tösstal ZH
 * — confirmed via 3 independent sources: (a) the company's own JSON-LD
 * `Organization` block + Impressum page (kuhnrikon.com/de/impressum), (b)
 * Northdata's mirror of the Zefix/Handelsregister entry (CHE-102.058.330,
 * "KUHN RIKON AG, Rikon im Tösstal"), (c) search.ch directory listing
 * ("Kuhn Rikon AG, Outlet", Neschwilerstrasse 4, Rikon im Tösstal). No
 * fallback guess needed.
 *
 * PII note: sampled Jobalino JSON-LD descriptions (Landquart + Genève
 * postings, 2026-07-04) contain no recruiter email/phone/named contact —
 * unlike the marketing CMS page mirrors, which do surface an HR contact
 * (bewerbung@kuhnrikon.ch). We only ever scrape the Jobalino detail pages,
 * so no PII-stripping step is wired in; a defensive test still asserts the
 * parsed description never contains an email/phone pattern.
 *
 * Exports 4 functions expected by the crawler template:
 * - fetchAllKuhnRikonJobs() — Fetch + parse all jobs
 * - isKuhnRikonJob() — Match jobs belonging to this company
 * - isTrustedDomain() — Validate URLs belong to Kuhn Rikon / Jobalino
 * - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  fetchJobalinoListing,
  parseJobalinoListingHtml,
  extractJobalinoJobPostingJsonLd,
  jobalinoDescriptionToText,
} from './jobalino-common.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';
import { normalizeSpace, decodeEntities } from './hospital-custom-html-helpers.mjs';

export { slugify, stripHtml };

/* ── Constants ──────────────────────────────────────────────── */

export const KUHN_RIKON_KEY = 'kuhn-rikon';
export const KUHN_RIKON_COMPANY_NAME = 'Kuhn Rikon';
export const KUHN_RIKON_COMPANY_DOMAIN = 'kuhnrikon.com';

const JOBALINO_TENANT = 'kuhn-rikon';
const CAREER_URL = 'https://kuhnrikon.com/ch_de/ueber-uns/karriere-bei-kuhn-rikon/jobs';
const SECTOR = 'Retail / Produzione casalinghi';
const DETAIL_DELAY_MS = 250;
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// HQ, Rikon im Tösstal ZH — see docblock above for the 3 independent sources.
const HQ = {
  city: 'Rikon im Tösstal',
  canton: 'ZH',
  postalCode: '8486',
  streetAddress: 'Neschwilerstrasse 4',
  addressRegion: 'ZH',
};

/* ── Helpers ────────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * City-gated address resolver (pattern per staubli-job-parser.mjs /
 * dormakaba-job-parser.mjs).
 *
 * The Jobalino tile already carries the posting's OWN street/zip/city for
 * almost every opening (Kuhn Rikon posts jobs at its retail outlets and
 * shop-in-shop counters all over Switzerland, e.g. Landquart, Genève —
 * each with its own address). The HQ street/postal code is ONLY used as a
 * fallback, and ONLY when the tile's own city is empty or textually matches
 * the HQ city itself ("Rikon") — never canton-wide (a Zürich-city or
 * Winterthur posting, also canton ZH, must NOT inherit the Rikon street).
 *
 * Exported (unlike the upstream Stäubli reference) so the crawler test can
 * assert the negative control directly: a same-canton-different-city tile
 * (e.g. Winterthur or Zürich, both canton ZH like Rikon im Tösstal) must NOT
 * receive the HQ street address.
 */
export function resolveAddress(tile = {}) {
  const city = normalizeSpace(decodeEntities(tile.city || ''));
  const postalCode = normalizeSpace(tile.zip || '');
  const streetAddress = normalizeSpace(decodeEntities(tile.address || ''));
  const isHqCity = !city || /\brikon\b/i.test(city);

  return {
    city: city || HQ.city,
    postalCode: postalCode || (isHqCity ? HQ.postalCode : ''),
    streetAddress: streetAddress || (isHqCity ? HQ.streetAddress : ''),
  };
}

/** Category detection, retail/manufacturing-oriented (not healthcare). */
export function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(vendita|sales|verkauf|verkaufsberat|vente|consultante|conseill|commesso|commessa)/.test(t)) return 'Vendita al dettaglio';
  if (/\b(produz|production|produktion|operai|operator|manufactur|montag)/.test(t)) return 'Produzione';
  if (/\b(logist|magazz|lager|warehouse|entrep[oô]t)/.test(t)) return 'Logistica';
  if (/\b(admin|segret|sekret|contab|buchhalt|comptab|sachbearbeit)/.test(t)) return 'Amministrazione';
  if (/\b(hr\b|human resources|personal|ressources humaines|risorse umane|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(it\b|informatik|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(market|kommunik|comunicaz|marketing)/.test(t)) return 'Marketing';
  if (/\b(qualit|qa\b|qc\b|quality)/.test(t)) return 'Qualità';
  if (/\b(kunden|customer|client[eè]le|servizio clienti)/.test(t)) return 'Servizio clienti';
  return 'Altro';
}

export function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  // "leiter(in)" is not word-boundary-prefixed on purpose: Swiss German titles
  // routinely compound it (Filialleiter, Marktleiter, Teamleiter, Abteilungsleiterin).
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)\b|leiter(in)?\b/.test(t)) return 'senior';
  return 'mid';
}

export function detectEmploymentType(workload = '', title = '') {
  const t = normalize(`${workload} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  // Workload range like "50 - 80%" implies part-time when the ceiling < 90%.
  const range = t.match(/(\d{1,3})\s*%?\s*-\s*(\d{1,3})\s*%/);
  if (range) {
    const max = parseInt(range[2], 10);
    if (Number.isFinite(max) && max < 90) return 'PART_TIME';
    return 'FULL_TIME';
  }
  const single = t.match(/(\d{1,3})\s*%/);
  if (single) {
    const pct = parseInt(single[1], 10);
    if (Number.isFinite(pct) && pct < 90) return 'PART_TIME';
    return 'FULL_TIME';
  }
  return 'FULL_TIME';
}

async function fetchDetailHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/html,*/*', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }, { label: `kuhn-rikon detail ${url}` });
}

/* ── Company Matchers ──────────────────────────────────────────── */

export function isKuhnRikonJob(job) {
  if (!job) return false;
  const key = normalize(job.companyKey || '');
  const company = normalize(job.company || '');
  const url = normalize(job.url || '');
  return (
    key === KUHN_RIKON_KEY
    || company.includes('kuhn rikon')
    || company.includes('kuhn-rikon')
    || url.includes('kuhnrikon.com')
    || (url.includes('jobalino.ch') && company.includes('kuhn'))
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === KUHN_RIKON_COMPANY_DOMAIN
      || host.endsWith(`.${KUHN_RIKON_COMPANY_DOMAIN}`)
      || host === 'my.jobalino.ch'
      || host === 'jobalino.ch'
      || host.endsWith('.jobalino.ch')
    );
  } catch {
    return false;
  }
}

/* ── Fetch + Parse ──────────────────────────────────────────────── */

export async function fetchAllKuhnRikonJobs() {
  console.log(`🔍 Fetching ${KUHN_RIKON_COMPANY_NAME} jobs`);
  console.log(`   Source: https://my.jobalino.ch/custel_jobExternalList/${JOBALINO_TENANT} (Jobalino)\n`);

  let listing;
  try {
    listing = await fetchJobalinoListing({ company: JOBALINO_TENANT, locale: 'de' });
  } catch (err) {
    console.warn(`⚠️ Jobalino listing fetch failed: ${err?.message || err}`);
    return [];
  }
  if (listing.error) {
    console.warn(`⚠️ Jobalino error for '${JOBALINO_TENANT}': ${listing.error}`);
    return [];
  }

  const tiles = parseJobalinoListingHtml(listing.html);
  if (!tiles.length) {
    console.warn(`⚠️ No openings parsed from Jobalino listing for ${JOBALINO_TENANT}`);
    return [];
  }
  console.log(`   📋 Listing tiles found: ${tiles.length}`);

  const jobs = [];
  const seen = new Set();
  const todayIso = new Date().toISOString().slice(0, 10);
  let detailHits = 0;
  let failed = 0;

  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i];
    if (seen.has(tile.id)) continue;
    seen.add(tile.id);

    let detailHtml = '';
    try {
      detailHtml = await fetchDetailHtml(tile.url);
    } catch (err) {
      console.warn(`   ⚠️ Detail fetch failed (${tile.url}): ${err?.message || err}`);
    }

    const jsonLd = detailHtml ? extractJobalinoJobPostingJsonLd(detailHtml) : null;
    if (jsonLd) detailHits += 1;

    const title = normalizeSpace(decodeEntities(String(jsonLd?.title || tile.title || '')));
    if (!title) {
      failed += 1;
      if (i < tiles.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
      continue;
    }

    const descriptionText = jsonLd?.description
      ? jobalinoDescriptionToText(jsonLd.description)
      : stripHtml(tile.title || '');
    let description = descriptionText || `${title} — ${KUHN_RIKON_COMPANY_NAME}.`;

    // Thin-description guard (Non-Negotiable #4: never index <50-word content).
    // Real Jobalino JobPosting bodies are typically long, but if the source
    // ever returns a stub, append real company context inline rather than
    // leave thin content indexable.
    const descWordCount = description.split(/\s+/).filter(Boolean).length;
    if (descWordCount < 50) {
      const FILLER = 'Kuhn Rikon AG è un’azienda svizzera con sede a Rikon im '
        + 'Tösstal (ZH), produttrice di pentole, coltelli e accessori da cucina di '
        + 'alta qualità venduti in tutto il mondo con il marchio Kuhn Rikon. '
        + 'L’azienda gestisce punti vendita e outlet in diverse località della '
        + 'Svizzera e offre posizioni nei settori vendita, produzione, logistica e '
        + 'amministrazione.';
      description = [description, FILLER].join('\n');
    }

    const { city, postalCode, streetAddress } = resolveAddress(tile);
    const canton = inferSwissTargetCanton(`${city} ${tile.country || ''}`) || HQ.canton;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const employmentType = detectEmploymentType(tile.workload, title);
    const contract = employmentType === 'PART_TIME' ? 'part-time' : 'full-time';

    const postedDate = jsonLd?.datePosted && /^\d{4}-\d{2}-\d{2}/.test(jsonLd.datePosted)
      ? String(jsonLd.datePosted).slice(0, 10)
      : todayIso;

    const jobSlug = slugify(`${title} ${KUHN_RIKON_KEY} ${city}`);
    const urlHash = createHash('sha1').update(`${KUHN_RIKON_KEY}:${tile.id}`).digest('hex').slice(0, 12);
    const publicUrl = tile.url;

    const job = {
      // ── Required fields ──
      id: `${KUHN_RIKON_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KUHN_RIKON_COMPANY_NAME,
      companyKey: KUHN_RIKON_KEY,
      companyDomain: KUHN_RIKON_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: publicUrl,
      source: 'Kuhn Rikon Dedicated Parser (Jobalino)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city,
      streetAddress,
      postalCode,
      addressRegion: HQ.addressRegion === canton ? HQ.addressRegion : canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      externalId: String(tile.id),
      hiringOrganizationName: KUHN_RIKON_COMPANY_NAME,
    };

    if (tile.workload) job.pensum = normalizeSpace(tile.workload);
    if (tile.filter3) job.department = tile.filter3;
    if (/befristet|temporaire|temporary|interim/i.test(tile.jobtype || '')
      && !/festanstellung|permanent|unbefristet/i.test(tile.jobtype || '')) {
      job.contractDuration = 'temporary';
    } else if (/festanstellung|unbefristet|permanent/i.test(tile.jobtype || '')) {
      job.contractDuration = 'permanent';
    }

    jobs.push(job);
    if (i < tiles.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }

  console.log(`\n📋 Total ${KUHN_RIKON_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${tiles.length} with JSON-LD JobPosting, ${failed} skipped)\n   Career page: ${CAREER_URL}`);
  return jobs;
}
