#!/usr/bin/env node
/**
 * BIG & ARE Stellen job parser — Fetcher and job builder.
 *
 * Source: https://recruitingapp-1123.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRecruitingapp1123Jobs()  — Fetch and parse all jobs
 *   - isRecruitingapp1123Job()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify()                   — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { evaluateSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { loadSpec, createSpecUrlPolicy } from './prospector/spec-crawler.mjs';
import { politeFetch } from './prospector/polite-fetch.mjs';
import { extractLinks } from './prospector/careers-trail.mjs';
import { extractDetailFields } from './prospector/extract.mjs';
import { extractUmantisDetailFields } from './prospector/umantis-detail.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RECRUITINGAPP_1123_KEY = 'recruitingapp-1123';
export const RECRUITINGAPP_1123_COMPANY_NAME = 'BIG & ARE Stellen';
export const RECRUITINGAPP_1123_COMPANY_DOMAIN = 'recruitingapp-1123.umantis.com';

const CAREER_URL = 'https://recruitingapp-1123.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
const MIN_DETAIL_WORDS = 50;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to BIG & ARE Stellen.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRecruitingapp1123Job(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RECRUITINGAPP_1123_KEY ||
    key.startsWith('recruitingapp-1123') ||
    company.includes('big & are stellen') ||
    url.includes('recruitingapp-1123.umantis.com')
  );
}

/**
 * Validate that a URL belongs to BIG & ARE Stellen's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'recruitingapp-1123.umantis.com' || host.endsWith('.recruitingapp-1123.umantis.com');
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

/* ── Fetcher guidato dalla spec ───────────────────────────────
 * Spec: data/prospector/crawlers/{key}.json — seed, modalita' di estrazione e
 * template degli URL di dettaglio, appresi dalla pagina reale.
 */
function wordCount(value = '') {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function explicitSourceCountry(description = '') {
  const normalized = String(description || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\b(?:osterreich(?:s|isch\w*)?|austria(?:n)?)\b/.test(normalized) ? 'AT' : '';
}

export function discoverRecruitingapp1123Listings(html = '', pageUrl = CAREER_URL) {
  const seen = new Set();
  return extractLinks(html, pageUrl).flatMap((link) => {
    let url;
    try { url = new URL(link.url); } catch { return []; }
    const match = /^\/Vacancies\/(\d+)\/Description\/\d+\/?$/i.exec(url.pathname);
    const title = normalizeSpace(link.text || '');
    if (!match || url.hostname !== RECRUITINGAPP_1123_COMPANY_DOMAIN || title.length < 3 || seen.has(match[1])) return [];
    seen.add(match[1]);
    const canonicalUrl = new URL(`/Vacancies/${match[1]}/Description/1`, CAREER_URL).toString();
    return [{ vacancyId: match[1], title, url: canonicalUrl }];
  });
}

async function fetchRequiredPage(url, urlPolicy, runtime = {}) {
  const result = await politeFetch(url, {
    urlPolicy,
    dispatcher: urlPolicy.dispatcher,
    fetchImpl: runtime.fetchImpl,
    sleepImpl: runtime.sleepImpl,
    retries: runtime.retries ?? 2,
    retryBaseMs: runtime.retryBaseMs,
    timeoutMs: runtime.timeoutMs,
    ignoreRobots: runtime.ignoreRobots === true,
  });
  if (!result.ok || !String(result.body || '').trim()) {
    throw new Error(`Recruitingapp-1123 source fetch failed (${result.status || 0}): ${url}`);
  }
  return result;
}

export async function fetchJobListings(runtime = {}) {
  const spec = loadSpec(RECRUITINGAPP_1123_KEY);
  const urlPolicy = createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl });
  try {
    const listingPage = await fetchRequiredPage(CAREER_URL, urlPolicy, runtime);
    const listings = discoverRecruitingapp1123Listings(listingPage.body, listingPage.url || CAREER_URL);
    if (listings.length === 0) {
      throw new Error('Recruitingapp-1123 authoritative listing contained no canonical vacancy links');
    }

    // Fetch and parse every detail before returning anything. A timeout,
    // malformed page or thin source rejects the complete batch, so a partial
    // listing snapshot can never replace the published slice.
    const settled = await Promise.allSettled(listings.map(async (listing) => {
      const page = await fetchRequiredPage(listing.url, urlPolicy, runtime);
      const generic = extractDetailFields(page.body, page.url || listing.url);
      const umantis = extractUmantisDetailFields(page.body);
      const description = [umantis.description, generic.description]
        .map((value) => String(value || '').trim())
        .sort((a, b) => wordCount(b) - wordCount(a))[0] || '';
      if (wordCount(description) < MIN_DETAIL_WORDS) {
        throw new Error(`Recruitingapp-1123 detail description is thin for vacancy ${listing.vacancyId}`);
      }
      if (generic.authoritativeLocationConflict) {
        throw new Error(`Recruitingapp-1123 detail location evidence conflicts for vacancy ${listing.vacancyId}`);
      }
      const rawCandidates = [
        ...(generic.locationCandidates || []),
        ...(umantis.locationCandidates || []),
      ];
      if (rawCandidates.length === 0) {
        throw new Error(`Recruitingapp-1123 detail location is missing for vacancy ${listing.vacancyId}`);
      }
      const pageCountry = explicitSourceCountry(description);
      const decisions = rawCandidates.map((candidate) => {
        let decision = evaluateSourceBackedSwissGeography([candidate]);
        // BIG's detail body explicitly identifies Austria. Apply that country
        // evidence only when the location itself is not already verifiably
        // Swiss, so a future Bern/CH vacancy cannot be erased by company prose.
        if (!decision.geography && !decision.explicitlyForeign && pageCountry) {
          decision = evaluateSourceBackedSwissGeography([{ ...candidate, addressCountry: pageCountry }]);
        }
        return decision;
      });
      const swissDecisions = decisions.filter((decision) => decision.geography);
      const hasForeignEvidence = decisions.some((decision) => decision.explicitlyForeign);
      if (swissDecisions.length > 0 && hasForeignEvidence) {
        throw new Error(`Recruitingapp-1123 detail location evidence conflicts for vacancy ${listing.vacancyId}`);
      }
      const decision = swissDecisions[0];
      if (!decision) {
        if (hasForeignEvidence) return null; // authoritative non-Swiss vacancy
        throw new Error(`Recruitingapp-1123 detail location is unverifiable for vacancy ${listing.vacancyId}`);
      }
      return {
        ...listing,
        description,
        location: decision.geography.location,
        canton: decision.geography.canton,
        addressLocality: decision.candidate.addressLocality || decision.geography.location,
        addressRegion: decision.candidate.addressRegion || decision.geography.canton,
        addressCountry: decision.candidate.addressCountry || decision.geography.addressCountry || 'CH',
        postalCode: decision.candidate.postalCode || '',
        streetAddress: decision.candidate.streetAddress || '',
        postedDate: generic.postedDate || '',
        employmentType: generic.employmentType || '',
      };
    }));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const detailed = settled.map((result) => result.value);
    const swiss = detailed.filter(Boolean);
    const foreign = detailed.length - swiss.length;
    swiss.discoveredCount = listings.length;
    swiss.detailCount = detailed.length;
    swiss.foreignCount = foreign;
    if (foreign > 0) {
      console.warn(`  🌍 Recruitingapp-1123: ${foreign}/${detailed.length} authoritative non-Swiss details excluded`);
    }
    return swiss;
  } finally {
    await urlPolicy.dispatcher.close();
  }
}

/**
 * Fetch all BIG & ARE Stellen jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllRecruitingapp1123Jobs(runtime = {}) {
  console.log(`🔍 Fetching BIG & ARE Stellen jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings(runtime);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No source-backed Swiss job listings returned.');
  }

  console.log(`  📋 Source-backed Swiss listings found: ${listings.length}`);

  const jobs = [];
  const observedAt = new Date(runtime.now?.() || Date.now()).toISOString();
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = normalizeSpace(listing.location || '');
    const canton = normalizeSpace(listing.canton || '');
    const descriptionText = String(listing.description || '').trim();
    if (!location || !canton || wordCount(descriptionText) < MIN_DETAIL_WORDS) {
      throw new Error(`Recruitingapp-1123 source-detail invariant failed for ${listing.url || title}`);
    }
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} recruitingapp-1123 ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `recruitingapp-1123-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RECRUITINGAPP_1123_COMPANY_NAME,
      companyKey: RECRUITINGAPP_1123_KEY,
      companyDomain: RECRUITINGAPP_1123_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'BIG & ARE Stellen Dedicated Parser',
      sourceLang,
      crawledAt: observedAt,

      // ── Recommended fields ──
      addressLocality: normalizeSpace(listing.addressLocality),
      addressRegion: normalizeSpace(listing.addressRegion || canton),
      addressCountry: normalizeSpace(listing.addressCountry || 'CH'),
      country: normalizeSpace(listing.addressCountry || 'CH'),
      ...(listing.postalCode ? { postalCode: normalizeSpace(listing.postalCode) } : {}),
      ...(listing.streetAddress ? { streetAddress: normalizeSpace(listing.streetAddress) } : {}),
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: listing.employmentType || detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || observedAt.split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total BIG & ARE Stellen jobs discovered: ${jobs.length}`);
  jobs.discoveredCount = listings.discoveredCount;
  jobs.detailCount = listings.detailCount;
  jobs.foreignCount = listings.foreignCount;
  return jobs;
}

/** Prove the canonical listing and every detail were observed in one batch. */
export function assertCompleteRecruitingapp1123Snapshot(jobs) {
  if (!Array.isArray(jobs)) throw new Error('Recruitingapp-1123 snapshot is not an array');
  const discovered = Number(jobs.discoveredCount);
  const detailed = Number(jobs.detailCount);
  const foreign = Number(jobs.foreignCount);
  if (![discovered, detailed, foreign].every(Number.isInteger) || discovered < 0 || detailed !== discovered) {
    throw new Error(`Recruitingapp-1123 snapshot parity failed: discovered=${discovered}, detailed=${detailed}, foreign=${foreign}`);
  }
  if (jobs.length + foreign !== discovered) {
    throw new Error(`Recruitingapp-1123 publication parity failed: swiss=${jobs.length}, foreign=${foreign}, discovered=${discovered}`);
  }
  const identities = new Set();
  for (const job of jobs) {
    const identity = String(job?.url || '');
    if (!identity || identities.has(identity) || !isTrustedDomain(identity)) {
      throw new Error(`Recruitingapp-1123 snapshot identity invalid: ${identity || 'missing'}`);
    }
    if (!job.location || !job.canton || wordCount(job.description) < MIN_DETAIL_WORDS) {
      throw new Error(`Recruitingapp-1123 source-detail invariant failed: ${identity}`);
    }
    identities.add(identity);
  }
  return true;
}
