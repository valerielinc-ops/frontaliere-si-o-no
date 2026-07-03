#!/usr/bin/env node
/**
 * EPI Genève job parser — SmartRecruiters (tenant
 * "EtablissementsPublicsPourLIntegration") API.
 *
 * Source: https://careers.smartrecruiters.com/EtablissementsPublicsPourLIntegration
 * (public career page, French only)
 *
 * Établissements publics pour l'intégration (EPI) is a public
 * socio-professional / socio-sanitary institution of the Republic and
 * Canton of Geneva, offering work-integration and residential support
 * for adults with disabilities. HQ at Route de Chêne 48, 1208 Genève.
 *
 * Tenant discovery note: the short public brand "EPI" is NOT the
 * SmartRecruiters tenant id — the tenant id is the full legal name
 * with no spaces/accents, case-sensitive:
 * "EtablissementsPublicsPourLIntegration". Confirmed live via
 * https://api.smartrecruiters.com/v1/companies/EtablissementsPublicsPourLIntegration/postings?limit=1
 * (returns `totalFound: 11`). The public REST API exposes every
 * active posting; `locationCountryCodes: ['ch']` narrows to the
 * Swiss subset (EPI is Geneva-only in practice, but the filter is
 * kept for parity with the other SmartRecruiters dedicated crawlers).
 * Per-posting detail (full jobAd description + street address) lives
 * at `/postings/{id}` and is fetched on demand.
 *
 * Public posting URLs are
 * jobs.smartrecruiters.com/EtablissementsPublicsPourLIntegration/{id}-{slug}.
 *
 * Postings are published in French (Geneva) — sourceLang is detected
 * per-job via detectLang() with a 'fr' fallback, same approach as the
 * other Romandie dedicated crawlers (e.g. arsante-clinique-de-carouge).
 *
 * Exports the 4 functions required by the crawler template:
 *   - fetchAllEpiGeneveJobs()  — Fetch and parse all Swiss jobs
 *   - isEpiGeneveJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchSmartRecruitersJobs } from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const EPI_GENEVE_KEY = 'epi-geneve';
export const EPI_GENEVE_COMPANY_NAME = "Établissements publics pour l'intégration";
export const EPI_GENEVE_COMPANY_DOMAIN = 'epi.ge.ch';

const SR_TENANT = 'EtablissementsPublicsPourLIntegration';
const CAREER_URL = 'https://careers.smartrecruiters.com/EtablissementsPublicsPourLIntegration';

/* ── HQ fallback (Route de Chêne 48, 1208 Genève, GE) ────────── */

const HQ = {
  city: 'Genève',
  canton: 'GE',
  postalCode: '1208',
  streetAddress: 'Route de Chêne 48',
  region: 'Genève',
};

const SECTOR = 'Sociale / Socio-sanitario';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to EPI Genève.
 * Used by the template to filter this company's jobs out of the
 * global dataset.
 */
export function isEpiGeneveJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '');
  const url = normalize(job?.url || '');

  return (
    key === EPI_GENEVE_KEY ||
    key.startsWith('epi-geneve') ||
    company.includes('etablissements publics pour lintegration') ||
    company === 'epi' ||
    url.includes('epi.ge.ch') ||
    url.includes('smartrecruiters.com/etablissementspublicspourlintegration')
  );
}

/**
 * Validate that a URL belongs to EPI Genève's domain OR the
 * SmartRecruiters ATS hosts that actually serve the postings
 * (api/jobs/careers.smartrecruiters.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'epi.ge.ch' || host.endsWith('.epi.ge.ch')) return true;
    if (host === 'smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(educateur|educatrice|socio.?educat|accompagn)/.test(t)) return 'Sociale';
  if (/\b(infirmi|soignant|sante|medic)/.test(t)) return 'Sanitario';
  if (/\b(ingegner|engineer|technicien|technique)/.test(t)) return 'Tecnica';
  if (/\b(admin|secretar|comptab|gestionnaire)/.test(t)) return 'Amministrazione';
  if (/\b(vente|vendita|commerc)/.test(t)) return 'Commerciale';
  if (/\b(logist|magasin|entrepot)/.test(t)) return 'Logistica';
  if (/\b(product|atelier|operateur|operatrice)/.test(t)) return 'Produzione';
  if (/\b(qualit)/.test(t)) return 'Qualità';
  if (/\b(informatique|it|logiciel|developp)/.test(t)) return 'IT';
  if (/\b(rh|ressources humaines|personnel)/.test(t)) return 'Risorse Umane';
  if (/\b(market|communicat)/.test(t)) return 'Marketing';
  if (/\b(financ|comptab)/.test(t)) return 'Finanza';
  if (/\b(juridi|legal)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stage|stagiaire|apprenti|apprentissage)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|responsable|chef|directeur|directrice|adjoint)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(temps partiel|part.?time)/.test(t)) return 'PART_TIME';
  if (/\b(temps plein|full.?time)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Pick the best city / postal code / street / region from the raw
 * SmartRecruiters posting location, falling back to the documented
 * HQ address (Genève GE) when a field is missing.
 */
function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
  const postalCode = (rawLoc.postalCode || '').trim();
  const streetAddress = (rawLoc.address || '').trim();
  const region = (rawLoc.region || '').trim();

  return {
    city: city || HQ.city,
    postalCode: postalCode || (!city || /gen[eè]ve/i.test(city) ? HQ.postalCode : ''),
    streetAddress: streetAddress || (!city || /gen[eè]ve/i.test(city) ? HQ.streetAddress : ''),
    region,
  };
}

/**
 * Fetch Switzerland-only EPI Genève postings from the SmartRecruiters
 * API (tenant "EtablissementsPublicsPourLIntegration", country=ch).
 * Returns an array of raw listing objects {title, location, url,
 * postedAt, description, jobReqId, rawLocation}.
 */
async function fetchJobListings() {
  console.log(`  Fetching SmartRecruiters tenant "${SR_TENANT}" (country=ch)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const listings = [];

  try {
    for await (const job of fetchSmartRecruitersJobs(SR_TENANT, {
      company: EPI_GENEVE_COMPANY_NAME,
      locationCountryCodes: ['ch'],
      fetchDetail: true,
      timeoutMs,
    })) {
      const raw = job.rawPosting || {};
      listings.push({
        title: job.title,
        location: job.location,
        url: job.applyUrl,
        postedAt: job.postedAt,
        description: job.descriptionHtml || '',
        jobReqId: job.jobReqId || raw.id || '',
        rawLocation: raw.location || {},
        employmentLabel: raw?.typeOfEmployment?.label || '',
      });
    }
  } catch (err) {
    console.warn(`⚠️ SmartRecruiters fetch failed: ${err?.message || err}`);
    throw err;
  }

  return listings;
}

/**
 * Fetch all EPI Genève jobs (Switzerland only). Returns an array of
 * ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step of the translate-pending pipeline.
 */
export async function fetchAllEpiGeneveJobs() {
  console.log(`🔍 Fetching ${EPI_GENEVE_COMPANY_NAME} jobs`);
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

    const { city, postalCode, streetAddress, region } = resolveAddress(listing.rawLocation);
    const location = normalizeSpace(listing.location || city || HQ.city);
    const canton =
      inferSwissTargetCanton(location) ||
      inferSwissTargetCanton(`${city} ${region}`) ||
      HQ.canton;

    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const description = descriptionText || `${title} chez ${EPI_GENEVE_COMPANY_NAME} à ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} epi geneve ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${EPI_GENEVE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: EPI_GENEVE_COMPANY_NAME,
      companyKey: EPI_GENEVE_KEY,
      companyDomain: EPI_GENEVE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'EPI Genève Dedicated Parser (SmartRecruiters)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress: streetAddress || HQ.streetAddress,
      postalCode: postalCode || (canton === HQ.canton ? HQ.postalCode : ''),
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
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${EPI_GENEVE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
