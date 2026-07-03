#!/usr/bin/env node
/**
 * VZ VermögensZentrum job parser — Fetcher and job builder.
 *
 * VZ VermögensZentrum is Switzerland's leading independent financial
 * services group (wealth/asset management, pension "Vorsorge" planning,
 * mortgages, insurance brokerage). Career site: vermoegenszentrum.ch/jobs-karriere.
 * The live listing board (jobs.vermoegenszentrum.ch) embeds a Prospective.ch
 * "careercenter" widget (tenant/medium id 1003550) — confirmed via the job
 * detail page header-image host (ohws.prospective.ch/directlink/...) and the
 * public JSON feed below, which returns the same 50+ listings the widget
 * renders (client-side "load more" only toggles visibility, no separate
 * paginated AJAX call).
 *
 * Unlike many Prospective tenants (see prospective-ch-job-parser-common.mjs,
 * whose pickPostalCode()/pickLocation() only handle a zip embedded inside
 * sza_location.city or sza_workplace.* fields), this tenant supplies clean
 * per-listing sza_location.city / .zip / .street / .region / .country fields
 * directly — so, following the same precedent as emmi-job-parser.mjs, this
 * parser reads them directly instead of going through the shared factory
 * (which would silently default every job's postalCode/streetAddress to the
 * HQ fallback regardless of the job's real office).
 *
 * VZ has offices across many Swiss cities (Zug, Zürich, Basel, Chur,
 * Lausanne, Solothurn, Sursee, Thun, Rapperswil-Jona, Baar, …) plus a small
 * number in Germany (München, Frankfurt am Main) — this is a CH-focused
 * board (frontalieri commuting into Switzerland), so non-Swiss jobs are
 * dropped via an isSwissJob() guard (matching Emmi's established pattern).
 *
 * HQ fallback: VZ Holding AG's registered legal seat (Zefix CHE-102.060.456)
 * is Zug — Innere Güterstrasse 2, 6300 Zug — confirmed via Zefix (Swiss
 * commercial registry), cross-checked against Moneyhouse and the feed's own
 * Zug-based listings (whose sza_location already carries this exact
 * street/zip). Used ONLY as a canton-gated fallback — see resolveAddress().
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllVzVermoegenszentrumJobs() — Fetch and parse all Swiss jobs
 *   - isVzVermoegenszentrumJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()                 — Validate URLs belong to this company
 *   - slugify() / stripHtml()           — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VZ_VERMOEGENSZENTRUM_KEY = 'vz-vermoegenszentrum';
export const VZ_VERMOEGENSZENTRUM_COMPANY_NAME = 'VZ VermögensZentrum';
export const VZ_VERMOEGENSZENTRUM_COMPANY_DOMAIN = 'vermoegenszentrum.ch';

const CAREER_URL = 'https://www.vermoegenszentrum.ch/jobs-karriere';

// prospective.ch OHWS careercenter id for VZ (mixed CH+DE board — CH-only filtered below).
const OHWS_MEDIUM_ID = '1003550';
const OHWS_JOBS_URL = `https://ohws.prospective.ch/public/v1/medium/${OHWS_MEDIUM_ID}/jobs`;
const SOURCE_LANG = 'de';

// VZ Holding AG registered legal seat (Zefix CHE-102.060.456): Innere
// Güterstrasse 2, 6300 Zug — used only as a canton-gated fallback, never
// applied to a job whose own inferred canton differs from HQ.canton.
const HQ = {
  city: 'Zug',
  canton: 'ZG',
  postalCode: '6300',
  streetAddress: 'Innere Güterstrasse 2',
  region: 'Zug',
};
const SECTOR = 'Finanza / Wealth Management';

const CH_COUNTRY_LABELS = new Set(['schweiz', 'suisse', 'svizzera', 'switzerland']);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to VZ VermögensZentrum.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isVzVermoegenszentrumJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === VZ_VERMOEGENSZENTRUM_KEY ||
    key.startsWith('vz-vermoegenszentrum') ||
    company.includes('vermögenszentrum') ||
    url.includes('vermoegenszentrum.ch')
  );
}

/**
 * Validate that a URL belongs to VZ VermögensZentrum's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    // Primary domain + subdomains (keeps the unit test green) ...
    if (host === 'vermoegenszentrum.ch' || host.endsWith('.vermoegenszentrum.ch')) return true;
    // ... plus the real ATS posting/feed hosts (prospective.ch OHWS board).
    if (host === 'prospective.ch' || host.endsWith('.prospective.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(`${title} ${department}`);
  if (/\b(informatik|it\b|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(vermögensberat|wealth|portfolio|asset management|anlage)/.test(t)) return 'Finanza';
  if (/\b(vorsorge|hypothek|immobil|mortgage)/.test(t)) return 'Consulenza Finanziaria';
  if (/\b(versicherung|insurance|privatversicherung)/.test(t)) return 'Assicurazioni';
  if (/\b(contact center|kundenservice|customer service)/.test(t)) return 'Servizio Clienti';
  if (/\b(finance|controlling|rechnungswesen|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(recht|compliance|risk|legal|giurid)/.test(t)) return 'Legale';
  if (/\b(hr\b|human resources|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(firmenkund|corporate)/.test(t)) return 'Clienti Corporate';
  if (/\b(lehre|praktik|stage|apprendist|lernend)/.test(t)) return 'Formazione';
  if (/\b(backoffice|administration|services)/.test(t)) return 'Amministrazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter)/.test(t)) return 'senior';
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
 * Convert a prospective.ch `start_date` / `last_modification_timestamp`
 * (ISO 8601 string) to a YYYY-MM-DD posted date.
 */
function toPostedDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

/**
 * Is this OHWS job located in Switzerland? VZ's careercenter also lists a
 * handful of German postings (München, Frankfurt am Main) — this site
 * targets Swiss/cross-border commuting jobs only, so those are excluded.
 */
function isSwissJob(szas = {}) {
  const country = normalize(szas['sza_location.country'] || '');
  if (country) return CH_COUNTRY_LABELS.has(country);
  // No country label at all — fall back to a Swiss-looking 4-digit zip.
  const zip = String(szas['sza_location.zip'] || '').trim();
  return /^\d{4}$/.test(zip);
}

/**
 * Resolve a job's address fields. Canton-gated: the HQ street/postal-code
 * fallback is only applied when the job's own inferred canton matches HQ's
 * canton — a job in a different canton (e.g. Zürich, Basel, Chur) must NEVER
 * inherit the Zug HQ street address just because its own street/zip is
 * missing from the feed.
 */
function resolveAddress({ city, region, zip, street, canton }) {
  const isHqCity = !city || /\bzug\b/i.test(city);
  const postalCode = /^\d{4}$/.test(zip)
    ? zip
    : isHqCity
      ? HQ.postalCode
      : '';
  const streetAddress = street || (isHqCity ? HQ.streetAddress : '');
  return {
    addressLocality: city || HQ.city,
    addressRegion: region || (canton === HQ.canton ? HQ.region : ''),
    postalCode,
    streetAddress,
  };
}

/**
 * Fetch the prospective.ch OHWS JSON feed for VZ's careercenter and return
 * raw listing objects. The feed paginates via offset/limit; total is modest
 * (~55) so a single limit=100 page returns everything, but we loop
 * defensively in case the catalogue grows.
 */
async function fetchJobListings() {
  console.log(`   Fetching OHWS feed: ${OHWS_JOBS_URL}?lang=${SOURCE_LANG}`);

  const limit = 100;
  let offset = 0;
  const collected = [];

  // Bounded loop (safety cap) — exits as soon as a page returns < limit.
  for (let page = 0; page < 50; page += 1) {
    const url = `${OHWS_JOBS_URL}?lang=${SOURCE_LANG}&offset=${offset}&limit=${limit}`;
    const data = await fetchJson(url);
    const batch = assertJsonListShape(data, { key: 'jobs', source: 'vz-vermoegenszentrum' });
    collected.push(...batch);

    const total = Number(data?.total) || collected.length;
    offset += limit;
    if (batch.length < limit || collected.length >= total) break;
  }

  return collected;
}

/**
 * Fetch all VZ VermögensZentrum jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllVzVermoegenszentrumJobs() {
  console.log(`🔍 Fetching VZ VermögensZentrum jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();

  for (const listing of listings) {
    const szas = listing.szas || {};

    // Germany/CH-only guard (board mixes CH + a few DE postings).
    if (!isSwissJob(szas)) continue;

    const title = normalizeSpace(listing.title || szas.sza_title || '');
    if (!title || title.length < 3) continue;

    // ── Location: real per-job city/region/zip/street, HQ fallback canton-gated ──
    const city = normalizeSpace(szas['sza_location.city'] || '');
    const region = normalizeSpace(szas['sza_location.region'] || '');
    const zip = normalizeSpace(szas['sza_location.zip'] || '');
    const street = normalizeSpace(szas['sza_location.street'] || '');
    const location = [city, region].filter(Boolean).join(', ') || HQ.city;
    const canton =
      inferSwissTargetCanton([city, region].filter(Boolean).join(' ')) || HQ.canton;
    const { addressLocality, addressRegion, postalCode, streetAddress } = resolveAddress({
      city,
      region,
      zip,
      street,
      canton,
    });

    // ── Description: company profile + tasks + requirements + benefits ──
    const profileHtml = szas.sza_company_profil || '';
    const tasksHtml = szas.sza_tasks || '';
    const reqsHtml = szas.sza_requirements || '';
    const benefitsHtml = szas.sza_benefits || '';
    const descriptionHtml = [profileHtml, tasksHtml, reqsHtml, benefitsHtml]
      .filter(Boolean)
      .join('\n');
    const descriptionText =
      stripHtml(descriptionHtml) || stripHtml(tasksHtml) || stripHtml(profileHtml);

    // ── Canonical job-detail URL (links.directlink) ──
    const publicUrl = listing.links?.directlink || CAREER_URL;

    // Stable reference: prefer prospective viewkey/reference, fallback URL hash.
    const stableRef =
      String(szas.sza_reference_code || listing.viewkey || listing.id || '').trim();
    const urlHash = stableRef
      ? createHash('sha1').update(`vz-vermoegenszentrum:${stableRef}`).digest('hex').slice(0, 12)
      : createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const id = `vz-vermoegenszentrum-${urlHash}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const sourceLang = detectLang(descriptionText || title, SOURCE_LANG);
    const jobSlug = slugify(`${title} vz vermoegenszentrum ch`);

    // ── Posted date: prefer OHWS start_date, fall back to last-modified ──
    const postedDate =
      toPostedDate(listing.start_date) ||
      toPostedDate(listing.last_modification_timestamp) ||
      new Date().toISOString().split('T')[0];

    // ── Employment type: pensum + sza_employment_type label ──
    const pensumMax = Number(szas['sza_pensum.max']);
    const pensumMin = Number(szas['sza_pensum.min']);
    const pensumLabel = normalizeSpace(szas.sza_pensum || '');
    let employmentType;
    if (Number.isFinite(pensumMax) && pensumMax > 0 && pensumMax < 90) {
      employmentType = 'PART_TIME';
    } else if (Number.isFinite(pensumMin) && pensumMin > 0 && pensumMin < 90) {
      employmentType = 'PART_TIME';
    } else if (Number.isFinite(pensumMax) && pensumMax >= 90) {
      employmentType = 'FULL_TIME';
    } else {
      employmentType = detectEmploymentType(
        `${pensumLabel} ${szas.sza_employment_type || ''} ${title}`,
      );
    }

    const department = normalizeSpace(
      (Array.isArray(listing.attributes?.['20']) && listing.attributes['20'][0]) ||
        szas.sza_industry ||
        '',
    );

    const requirements = stripHtml(reqsHtml)
      .split(/\n+/)
      .map((s) => normalizeSpace(s))
      .filter((s) => s.length > 0);

    const job = {
      // ── Required fields ──
      id,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VZ_VERMOEGENSZENTRUM_COMPANY_NAME,
      companyKey: VZ_VERMOEGENSZENTRUM_KEY,
      companyDomain: VZ_VERMOEGENSZENTRUM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${VZ_VERMOEGENSZENTRUM_COMPANY_NAME}`,
      descriptionByLocale: {
        [sourceLang]: descriptionText || `${title} — ${VZ_VERMOEGENSZENTRUM_COMPANY_NAME}`,
      },
      location,
      canton,
      url: publicUrl,
      source: 'VZ VermögensZentrum Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality,
      postalCode,
      addressRegion,
      streetAddress: streetAddress || undefined,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, department),
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: normalizeSpace(szas['sza_salary.currency'] || '') || 'CHF',
      featured: false,
      postedDate,
      applyUrl: normalizeSpace(szas.sza_apply_link || '') || publicUrl,
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total VZ VermögensZentrum jobs discovered: ${jobs.length}`);
  return jobs;
}
