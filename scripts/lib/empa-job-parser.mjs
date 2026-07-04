#!/usr/bin/env node
/**
 * Empa (Eidgenössische Materialprüfungs- und Forschungsanstalt / Swiss
 * Federal Laboratories for Materials Science and Technology) job parser —
 * Refline (tenant `673276`) careers portal.
 *
 * Discovery: `https://www.empa.ch/web/empa/jobs` 302-redirects to
 * `https://apply.refline.ch/673276/search.html?lang=en` — confirmed live,
 * Empa-specific tenant (not shared with any other ETH-Domain institution).
 * Empa's own search page cross-links sibling ETH-Domain job boards under a
 * distinct "Job offers ETH-Domain" block: ETH Zurich (`jobs.ethz.ch`, bespoke
 * scrape — see `./eth-zurich-job-parser.mjs`), EPFL (`emploi.epfl.ch`, SAP
 * SuccessFactors — see `./epfl-job-parser.mjs`), PSI (`psi.ch`, bespoke),
 * Eawag (Refline tenant `673277` — DIFFERENT tenant, not crawled here) and
 * WSL (Refline tenant `273855` — DIFFERENT tenant, not crawled here). No
 * double-coverage risk with any existing crawler.
 *
 * Listing: this tenant's default `positions.html` returns "position not
 * available" — the working listing endpoint is
 * `search.html?form.buttons.listAll=1&lang=de`. It uses the Refline
 * "table-row" template (`<tr><td class="position">…</td><td
 * class="workload">…</td><td class="workplace">…</td><td
 * class="published">…</td></tr>`), parsed via the shared, column-order/name
 * -independent `parseReflineTableListing()` in `./refline-common.mjs`.
 *
 * Detail pages: Empa's tenant uses Refline's "structured-detail" template
 * (DOM IDs `#bDescription` / `#bDuty` / `#bRequirement` / `#bBenefit` /
 * `#bWorkplace`, same family as Kanton GR `514915` — see
 * `./kanton-gr-job-parser.mjs`), which the generic `parseReflineDetail()`
 * paragraph-scan does NOT handle. However, unlike Kanton GR, Empa's detail
 * pages ALSO embed a full, authoritative schema.org `JobPosting` JSON-LD
 * block (title / datePosted / employmentType / hiringOrganization.name /
 * jobLocation.address with real streetAddress+postalCode+addressLocality
 * +addressRegion) — same shape already used by Sprüngli (tenant `116352`).
 * This parser reuses the shared `parseReflineJobPostingJsonLd()` helper (now
 * factored out of the Sprüngli parser into `./refline-common.mjs`) as the
 * PRIMARY data source, which sidesteps the structured-detail DOM entirely and
 * needs no bespoke nested-div extraction.
 *
 * Empa's three real sites (Dübendorf ZH — HQ, St. Gallen SG, Thun BE) each
 * carry their own real per-job address in the JSON-LD `jobLocation.address`
 * block; the Dübendorf HQ address below is used ONLY as a last-resort
 * fallback when JSON-LD is absent/malformed for a given posting.
 */
import { createHash } from 'node:crypto';
import { detectLang, ensureMinimumDescriptionWordCount } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { normalizeAnyCantonCode, isTargetCanton } from './crawler-location-config.mjs';
import {
  parseReflineTableListing,
  parseReflineDetail,
  parseReflineJobPostingJsonLd,
} from './refline-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const EMPA_KEY = 'empa';
export const EMPA_COMPANY_NAME = 'Empa';
export const EMPA_COMPANY_DOMAIN = 'empa.ch';

const REFLINE_TENANT = '673276';
const LISTING_HOST = 'apply.refline.ch';
const LISTING_URL = `https://${LISTING_HOST}/${REFLINE_TENANT}/search.html?form.buttons.listAll=1&lang=de`;
const CAREER_URL = 'https://www.empa.ch/web/empa/jobs';

/* ── HQ fallback (Überlandstrasse 129, 8600 Dübendorf, ZH) ───── */
const HQ = {
  city: 'Dübendorf',
  canton: 'ZH',
  postalCode: '8600',
  streetAddress: 'Überlandstrasse 129',
};

const SECTOR = 'Università / Ricerca';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Empa. Used by the template to filter this
 * company's jobs from the global dataset.
 */
export function isEmpaJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === EMPA_KEY
    || /\bempa\b/.test(company)
    || url.includes('empa.ch')
    || url.includes(`refline.ch/${REFLINE_TENANT}/`)
  );
}

/**
 * Validate that a URL belongs to Empa's own domain OR the Refline ATS host
 * that actually serves postings for this tenant.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === EMPA_COMPANY_DOMAIN || host.endsWith(`.${EMPA_COMPANY_DOMAIN}`)) return true;
    if (host === LISTING_HOST || host.endsWith(`.${LISTING_HOST}`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / Experience / Employment Detection ─────────────
 * Bespoke to Empa's own research-institute vocabulary (PhD/postdoc/
 * scientific/technical/administrative/IT) — the healthcare-biased
 * `detectHealthcareCategory` in hospital-custom-html-helpers.mjs would
 * misclassify e.g. a "Physiklaborant" apprentice role. Follows the same
 * structural pattern as `./eth-zurich-job-parser.mjs`'s classifiers (same
 * ETH-Domain research vocabulary) without importing from it directly, per
 * the established per-employer bespoke-classifier convention already used
 * by every other Refline crawler in this codebase (Sprüngli, GNK, PUK
 * Zürich each keep their own). */

function detectCategory(title = '', description = '') {
  const t = normalize(`${title} ${description}`);
  if (/\b(phd|doctoral|doktorand|dottorat)/.test(t)) return 'Ricerca';
  if (/\b(postdoc|post.?doc)/.test(t)) return 'Ricerca';
  if (/\b(professor|professur|professore)/.test(t)) return 'Accademico';
  if (/\b(research|forschung|ricerca|wissenschaftlich|scientific|scientifique)/.test(t)) return 'Ricerca';
  if (/\b(lernend|apprend|apprenti|lehrling|stagiair|praktik|intern\b)/.test(t)) return 'Formazione';
  if (/\b(ingegner|engineer|entwickl|architekt|ingénieur)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mechanic|elektr|install|laborant|techniker|mécanicien)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|sachbearbeit)/.test(t)) return 'Amministrazione';
  if (/\b(it\b|software|develop|programm|data\b|machine.?learning|computing|informatik|informatica)/.test(t)) return 'IT';
  if (/\b(hr\b|human resources|risorse umane|personal(abteilung)?)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|medien|communication)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|controlling)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|schnupperlehre)/.test(t)) return 'intern';
  if (/\b(phd|doctoral|doktorand|dottorat)/.test(t)) return 'junior';
  if (/\b(postdoc|post.?doc)/.test(t)) return 'mid';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leitung|professor)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  const pct = text.match(/(\d{2,3})\s*%/);
  if (pct) {
    const v = parseInt(pct[1], 10);
    if (v < 80) return 'PART_TIME';
    return 'FULL_TIME';
  }
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Listing + Detail Fetch/Parse ─────────────────────────────── */

async function fetchJobListings() {
  console.log(`   Fetching Refline tenant "${REFLINE_TENANT}" listing`);
  const html = await fetchHtml(LISTING_URL, {
    headers: { Referer: CAREER_URL },
  });

  const rows = parseReflineTableListing(html, { listingHost: LISTING_HOST, tenant: REFLINE_TENANT });
  if (!rows.length) return [];

  const listings = [];
  for (const row of rows) {
    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(row.url, { headers: { Referer: LISTING_URL } });
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${row.url}: ${err?.message || err}`);
    }
    listings.push({ ...row, detailHtml });
  }
  return listings;
}

/**
 * Fetch all Empa jobs (Switzerland only — Dübendorf ZH, St. Gallen SG,
 * Thun BE).
 * Returns an array of ParsedJob objects (source-locale only).
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step of the translate-pending pipeline.
 */
export async function fetchAllEmpaJobs() {
  console.log(`🔬 Fetching ${EMPA_COMPANY_NAME} jobs`);
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
    const title = String(listing.title || '').trim();
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const jsonLd = parseReflineJobPostingJsonLd(listing.detailHtml || '');
    const jsonLdAddr = jsonLd?.jobLocation?.address || {};

    // Non-Swiss / foreign-office guard: skip any posting whose JSON-LD
    // address explicitly names a non-CH country.
    const rawCountry = String(jsonLdAddr.addressCountry || '').trim();
    if (rawCountry && rawCountry.toUpperCase() !== 'CH') continue;

    const workplaceHint = listing.workplace || jsonLdAddr.addressLocality || '';
    let canton = normalizeAnyCantonCode(jsonLdAddr.addressRegion || '')
      || inferSwissTargetCanton(workplaceHint)
      || inferSwissTargetCanton(jsonLdAddr.addressLocality || '')
      || HQ.canton;
    if (!isTargetCanton(canton)) canton = HQ.canton;

    const city = jsonLdAddr.addressLocality;
    const postalCode = jsonLdAddr.postalCode;
    const streetAddress = jsonLdAddr.streetAddress;
    const region = jsonLdAddr.addressRegion;
    const isHqCanton = canton === HQ.canton && (!city || /d[üu]bendorf/i.test(city));

    const location = String(workplaceHint || city || HQ.city).trim();

    // Description: prefer rich JSON-LD description (real job body, incl.
    // intro/tasks/requirements/benefits), fall back to the generic Refline
    // detail paragraph-scan, then a minimal synthetic sentence.
    const jsonLdDescription = jsonLd?.description ? stripHtml(jsonLd.description) : '';
    const detailParsed = parseReflineDetail(listing.detailHtml || '');
    const descriptionText = jsonLdDescription || detailParsed.description || '';
    let description = descriptionText || `${title} bei ${EMPA_COMPANY_NAME} in ${location}.`;

    // Thin-description guard (Non-Negotiable #4: never index <50-word
    // content). Real Empa JSON-LD bodies run 350+ words; if the source ever
    // returns a stub, append company context inline instead of leaving thin
    // content indexable.
    const descWordCount = description.split(/\s+/).filter(Boolean).length;
    if (descWordCount < 50) {
      description = [
        description,
        `Empa (Eidgenössische Materialprüfungs- und Forschungsanstalt) ist das interdisziplinäre Forschungsinstitut für Materialwissenschaft und Technologieentwicklung des ETH-Bereichs. An den drei Standorten Dübendorf, St. Gallen und Thun beschäftigt Empa rund 1'000 Wissenschaftlerinnen und Wissenschaftler, Ingenieurinnen und Ingenieure sowie technisches und administratives Personal aus über 50 Nationen und bietet attraktive Anstellungsbedingungen.`,
        `Empa ist Teil des ETH-Bereichs und verbindet anwendungsorientierte Forschung mit der praktischen Umsetzung neuer Ideen für Industrie und Gesellschaft.`,
      ].join('\n');
    }

    const resolvedTitle = String(jsonLd?.title || detailParsed.title || title).trim();
    const sourceLang = detectLang(descriptionText || resolvedTitle, 'de');
    const jobSlug = slugify(`${resolvedTitle} empa ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const jsonLdEmploymentTypeRaw = Array.isArray(jsonLd?.employmentType)
      ? jsonLd.employmentType[0]
      : jsonLd?.employmentType;
    const employmentType = jsonLdEmploymentTypeRaw
      || detectEmploymentType(`${listing.workload || ''} ${resolvedTitle}`);
    const postedDate = (jsonLd?.datePosted && String(jsonLd.datePosted).slice(0, 10))
      || (listing.entryDate && /^\d{4}-\d{2}-\d{2}/.test(listing.entryDate) ? listing.entryDate.slice(0, 10) : '')
      || new Date().toISOString().split('T')[0];
    const hiringOrgName = jsonLd?.hiringOrganization?.name || EMPA_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `${EMPA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: EMPA_COMPANY_NAME,
      companyKey: EMPA_KEY,
      companyDomain: EMPA_COMPANY_DOMAIN,
      title: resolvedTitle,
      titleByLocale: { [sourceLang]: resolvedTitle },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: `Empa Dedicated Parser (Refline ${REFLINE_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress: streetAddress || (isHqCanton ? HQ.streetAddress : ''),
      postalCode: postalCode || (isHqCanton ? HQ.postalCode : ''),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(resolvedTitle, description),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(resolvedTitle),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      hiringOrganizationName: hiringOrgName,
      jobReqId: listing.posId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  ensureMinimumDescriptionWordCount(jobs, 50);

  console.log(`\n📋 Total ${EMPA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
