#!/usr/bin/env node
/**
 * Bossard Group job parser — Workday ATS.
 *
 * Tenant host: bossard.wd103.myworkdayjobs.com
 * Site path:   BossardJobs
 *
 * Discovery: issue #3337 research listed Bossard as ATS "Custom" (no known
 * public ATS). Direct probing of the public careers page HTML
 * (https://www.bossard.com/ch-en/about-us/careers/open-positions/) found a
 * `myworkdayjobs.com` reference to `bossard.wd103.myworkdayjobs.com/BossardJobs`
 * — a real Workday tenant, not a custom scrape target. Confirmed live via the
 * public CXS API:
 *   curl -X POST https://bossard.wd103.myworkdayjobs.com/wday/cxs/bossard/BossardJobs/jobs \
 *     -H 'Content-Type: application/json' -d '{"appliedFacets":{},"limit":20,"offset":0}'
 *
 * `BossardJobs` is a Switzerland-scoped Workday site (every posting observed
 * during discovery — 5/5 — is in Zug, the group's Swiss HQ), unlike most
 * Workday tenants used by other dedicated crawlers here which run one global
 * multi-country site. We still request the standard Swiss location facet
 * defensively (see `WORKDAY_LOCATION_FACET`) and keep a per-listing foreign
 * guard so a future tenant change (e.g. folding in other-country postings)
 * can't silently leak non-CH roles labelled as `addressCountry: 'CH'`.
 *
 * Bossard Group is a global industrial fastening & assembly-technology
 * solutions provider for OEM customers, founded in Zug in 1831, listed on
 * the SIX Swiss Exchange (~3,000 employees, 33 countries).
 *
 * HQ (per https://www.bossard.com/ch-en/imprint/):
 *   Bossard AG, Steinhauserstrasse 70, 6301 Zug, Schweiz.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBossardJobs() — Fetch and parse all Swiss jobs
 *   - isBossardJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to Bossard / Workday tenant
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 *
 * IMPORTANT: Only source-locale fields are set here. Other locales are
 * filled later by the AI localization pipeline (translate-pending).
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDescriptionText,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BOSSARD_KEY = 'bossard';
export const BOSSARD_COMPANY_NAME = 'Bossard Group';
export const BOSSARD_COMPANY_DOMAIN = 'bossard.com';

const WORKDAY_TENANT_HOST = 'bossard.wd103.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'BossardJobs';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://www.bossard.com/ch-en/about-us/careers/open-positions/';

// Standard Workday Switzerland country facet UUID (same across nearly all
// tenants — see workday-swiss-job-parser-common.mjs).
const WORKDAY_SWISS_LOCATION_ID = '187134fccb084a0ea9b4b95f23890dbe';

/* ── HQ address (Bossard AG, Steinhauserstrasse 70, 6301 Zug) ── */

const HQ = {
  city: 'Zug',
  canton: 'ZG',
  postalCode: '6301',
  streetAddress: 'Steinhauserstrasse 70',
};

const SECTOR = 'Industria / Tecnologia di assemblaggio';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if job belongs to Bossard.
 * Used by template to filter this company's jobs from global dataset.
 */
export function isBossardJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BOSSARD_KEY ||
    key.startsWith('bossard') ||
    company.includes('bossard') ||
    url.includes('bossard.com') ||
    url.includes('bossard.wd103.myworkdayjobs.com')
  );
}

/**
 * Validate that URL belongs to Bossard's domain OR the Workday ATS host
 * that actually serves postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'bossard.com' || host.endsWith('.bossard.com')) return true;
    if (host === WORKDAY_TENANT_HOST || host.endsWith('.myworkdayjobs.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|développ)/.test(t)) return 'Ingegneria';
  if (/\b(einkauf|acquist|purchas|procurement|acheteur)/.test(t)) return 'Acquisti';
  if (/\b(quality|qualit[eà]|qualitäts)/.test(t)) return 'Qualità';
  if (/\b(sales|vendite|vente|verkauf|business developer|account manager|key account)/.test(t)) return 'Vendite';
  if (/\b(customer service|kundendienst|servizio clienti|service client)/.test(t)) return 'Servizio Clienti';
  if (/\b(techni|tecnic|mecanic|elektr|install|meccatron|mechatron|assembly|montage)/.test(t)) return 'Tecnica';
  if (/\b(logist|lager|magazz|supply chain|transport)/.test(t)) return 'Logistica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|controll|treasur)/.test(t)) return 'Finanza';
  if (/\b(it\b|sap|cloud|cyber|data|infrastructure|network|devops|digital|analytics)/.test(t)) return 'IT';
  if (/\b(lernend|praktik|ausbildung|apprenti|stage)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '', title = '') {
  const t = normalize(`${timeType} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Address resolution ───────────────────────────────────────
 * Only apply the HQ street/postal-code fallback when the job's own
 * resolved city TEXT matches the HQ city (Zug) — never gate on canton
 * equality. Canton-gating would stamp Bossard's exact HQ street address
 * onto every future posting anywhere in canton Zug, even a different
 * town. `addressRegion` (canton-level) is fine to fall back unconditionally.
 * Pattern mirrors scripts/lib/staubli-job-parser.mjs's resolveAddress().
 */
function resolveAddress(rawCity = '') {
  const city = normalizeSpace(rawCity || '');
  const isHqCity = !city || /\bzug\b/i.test(city);

  return {
    city: city || HQ.city,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch Switzerland-only Bossard postings from the Workday CXS API. The
 * `BossardJobs` site is Swiss-scoped in practice (every posting observed
 * is in Zug), but we still apply the standard Swiss location facet
 * defensively and drop any listing that is explicitly foreign so a future
 * tenant change can't leak non-CH roles.
 */
async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      appliedFacets: { locationCountry: [WORKDAY_SWISS_LOCATION_ID] },
      maxPages: 100000,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        company: BOSSARD_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        location: id.location || posting.locationsText || '',
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(`❌ Workday anti-bot block (${BOSSARD_COMPANY_NAME}): ${err.message}`);
      return [];
    }
    // Some tenants reject an unrecognised locationCountry facet outright —
    // fall back to the unfiltered board and rely on the per-listing
    // foreign guard below.
    console.warn(`⚠️ ${BOSSARD_COMPANY_NAME}: Swiss facet fetch failed (${err?.message || err}). Refetching unfiltered.`);
    out.length = 0;
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, { maxPages: 100000 })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        company: BOSSARD_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        location: id.location || posting.locationsText || '',
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
      });
    }
  }
  return out;
}

/**
 * Fetch all Bossard jobs (Switzerland only).
 * Returns array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step / translate-pending pipeline.
 */
export async function fetchAllBossardJobs() {
  console.log(`🔩 Fetching ${BOSSARD_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Workday: ${WORKDAY_API_BASE}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();

  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || '';
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️ Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }

    const { city, postalCode, streetAddress } = resolveAddress(rawLocation);
    const location = rawLocation || city || HQ.city;
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(city) || HQ.canton;

    const publicUrl = listing.url || WORKDAY_PUBLIC_BASE;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    // Workday listing endpoint never returns the job body — fetch detail.
    let detailDescription = '';
    try {
      detailDescription = await fetchWorkdayJobDescriptionText(
        WORKDAY_API_BASE,
        listing.externalPath,
        stripHtml,
      );
    } catch {
      detailDescription = '';
    }
    // Be polite to the Workday tenant between per-job detail fetches.
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${BOSSARD_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Arbeitgeber: Bossard AG — führender Anbieter industrieller Verbindungs- und Montagetechnik',
      '• Bewerbung über: Bossard Karriereportal (Workday)',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} bossard ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.timeType || '', title);
    const postedDate = listing.postedAt || new Date().toISOString().split('T')[0];

    const job = {
      id: `${BOSSARD_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BOSSARD_COMPANY_NAME,
      companyKey: BOSSARD_KEY,
      companyDomain: BOSSARD_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, translate-pending.yml picks the job up.
      needsRetranslation: true,
      location,
      canton,
      url: publicUrl,
      source: `${BOSSARD_COMPANY_NAME} Dedicated Parser (Workday)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
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
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${BOSSARD_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
