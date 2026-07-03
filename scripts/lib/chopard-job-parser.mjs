#!/usr/bin/env node
/**
 * Chopard job parser — Cornerstone OnDemand (CSOD) tenant "chopard".
 *
 * Chopard is an independent Swiss watch and jewellery Maison, headquartered
 * in Meyrin (Canton Geneva, GE) — HQ address confirmed from the company's
 * own legal notice page (chopard.com/it-it/legal-terms-of-website-use.html):
 * "Le petit-fils de L.U. Chopard & Cie SA, Rte de Veyrot 8, C.P. 85,
 * 1217 Meyrin 1, Svizzera".
 *
 * ATS discovery: the marketed careers URL (chopard.com/careers,
 * chopard.com/int-en/careers) 404s. The public homepage (chopard.com)
 * footer links to the real career portal:
 * https://chopard.csod.com/ux/ats/careersite/1/home?c=chopard
 * — a Cornerstone OnDemand (CSOD) React SPA (career site id 1, tenant host
 * chopard.csod.com). This is the SAME ATS family as Groupe Mutuel
 * (scripts/update-groupe-mutuel-jobs.mjs), so all auth/pagination logic is
 * shared via scripts/lib/ats-clients/csod-client.mjs rather than
 * duplicated (AGENTS.md sibling-pattern rule).
 *
 * Volume note: Chopard's CSOD tenant is GROUP-WIDE (all Maison locations,
 * not Switzerland-only) — at discovery time it listed 8 total open
 * requisitions worldwide, of which only 1 was in Switzerland (Meyrin HQ,
 * an IT project manager role). This is thin but real recurring HQ signal
 * (corporate/support functions at the Geneva HQ) — flagged in the crawler
 * backlog issue as borderline-volume; kept as a dedicated crawler since
 * there is at least one genuine, resolvable CH posting today and the CSOD
 * tenant is stable/low-maintenance once wired.
 *
 * Public posting URLs are
 * https://chopard.csod.com/ux/ats/careersite/1/home/requisition/{id}?c=chopard&lang=en-US
 * — verified to resolve (HTTP 200, SPA shell) for a live requisition id.
 *
 * Exports required by the crawler template:
 * - fetchAllChopardJobs() — Fetch + parse all Swiss postings
 * - isChopardJob() — Match jobs belonging to this company
 * - isTrustedDomain() — Validate URLs belong to the company/ATS
 * - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchCsodJobs } from './ats-clients/csod-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CHOPARD_KEY = 'chopard';
export const CHOPARD_COMPANY_NAME = 'Chopard';
export const CHOPARD_COMPANY_DOMAIN = 'chopard.com';

const CSOD_TENANT_HOST = 'chopard.csod.com';
const CSOD_CAREER_SITE_ID = 1;
const CSOD_COMPANY_PARAM = 'chopard';
const CSOD_CULTURE_ID = 1; // en-US
const CSOD_CULTURE_NAME = 'en-US';

const CAREER_URL = `https://${CSOD_TENANT_HOST}/ux/ats/careersite/${CSOD_CAREER_SITE_ID}/home?c=${CSOD_COMPANY_PARAM}&lang=${CSOD_CULTURE_NAME}`;

/* ── HQ fallback (Rte de Veyrot 8, C.P. 85, 1217 Meyrin, GE) ─── */

const HQ = {
  city: 'Meyrin',
  canton: 'GE',
  postalCode: '1217',
  streetAddress: 'Route de Veyrot 8',
  region: 'Genève',
};

const SECTOR = 'Orologeria / Gioielleria';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Chopard.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isChopardJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CHOPARD_KEY ||
    key.startsWith('chopard') ||
    company.includes('chopard') ||
    url.includes('chopard.com') ||
    url.includes('chopard.csod.com')
  );
}

/**
 * Validate a URL belongs to Chopard's own domain OR its CSOD career-site
 * host — the only two hosts that actually serve postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'chopard.com' || host.endsWith('.chopard.com')) return true;
    if (host === CSOD_TENANT_HOST || host.endsWith('.csod.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment-type detection ───────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(it |informatique|informatica|digital|erp|développeur|developer|data)/.test(t)) return 'IT';
  if (/\b(vente|sales associate|boutique|retail|vendita|commerciale)/.test(t)) return 'Commerciale';
  if (/\b(marketing|communication|pr specialist|public relations)/.test(t)) return 'Marketing';
  if (/\b(ressources humaines|human resources|talent acquisition|rh )/.test(t)) return 'Risorse Umane';
  if (/\b(horloger|watchmaker|orologiaio|joaillier|jewel|production|manufactur)/.test(t)) return 'Produzione / Manifattura';
  if (/\b(finance|comptab|audit|contrôle de gestion)/.test(t)) return 'Finanza';
  if (/\b(legal|juridique|avvocat)/.test(t)) return 'Legale';
  if (/\b(chef de projet|project manager|responsable|manager|director|head of)/.test(t)) return 'Management';
  return 'Amministrazione';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stagiaire|praktikant|intern|stage|apprenti|apprendista)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|manager|chef de|responsable)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(cdd|temps partiel|part.?time|teilzeit|tempo parziale)/.test(t)) return 'PART_TIME';
  if (/\b(cdi|temps plein|full.?time|vollzeit|tempo pieno)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Address resolution ───────────────────────────────────────
 * Only fall back to the HQ street/postal code when the resolved city
 * itself is empty or genuinely Meyrin — NEVER gate on canton equality.
 * See scripts/lib/staubli-job-parser.mjs `resolveAddress()` for the
 * canonical pattern this mirrors (canton-gating was a production bug
 * class: it stamps HQ's exact street address onto every job anywhere in
 * the same canton, even a different city).
 * ────────────────────────────────────────────────────────────── */
export function resolveAddress(city = '') {
  const cleanCity = normalizeSpace(city);
  const isHqCity = !cleanCity || /meyrin/i.test(cleanCity);
  return {
    city: cleanCity || HQ.city,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
    region: HQ.region,
  };
}

/* ── CSOD requisition parsing ─────────────────────────────────── */

function buildPublicUrl(requisitionId) {
  return `https://${CSOD_TENANT_HOST}/ux/ats/careersite/${CSOD_CAREER_SITE_ID}/home/requisition/${requisitionId}?c=${CSOD_COMPANY_PARAM}&lang=${CSOD_CULTURE_NAME}`;
}

function parsePostingDate(raw = '') {
  // CSOD "postingEffectiveDate" format observed: "M/D/YYYY"
  const parts = String(raw || '').split('/');
  if (parts.length === 3) {
    const [m, d, y] = parts;
    const mm = m.padStart(2, '0');
    const dd = d.padStart(2, '0');
    if (y.length === 4) return `${y}-${mm}-${dd}`;
  }
  return '';
}

/**
 * Fetch all Chopard CSOD requisitions worldwide, then filter to
 * Switzerland-only postings (locations[].country === 'CH').
 */
async function fetchChopardRequisitions() {
  return fetchCsodJobs(CSOD_TENANT_HOST, CSOD_CAREER_SITE_ID, {
    companyParam: CSOD_COMPANY_PARAM,
    cultureId: CSOD_CULTURE_ID,
    cultureName: CSOD_CULTURE_NAME,
    referer: `https://${CSOD_TENANT_HOST}/`,
  });
}

/**
 * Fetch and parse all Swiss Chopard jobs from the CSOD API.
 * Returns array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only sets source-locale fields. Other locales are filled
 * by the AI localization step of the translate-pending pipeline.
 */
export async function fetchAllChopardJobs() {
  console.log(`🔍 Fetching ${CHOPARD_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const requisitions = await fetchChopardRequisitions();
  if (!requisitions || requisitions.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`   📋 Requisitions found (worldwide): ${requisitions.length}`);

  const jobs = [];
  const seen = new Set();

  for (const raw of requisitions) {
    const locations = Array.isArray(raw?.locations) ? raw.locations : [];
    const isSwiss = locations.some((l) => normalize(l?.country) === 'ch');
    if (!isSwiss) continue;

    const title = normalizeSpace(raw?.displayJobTitle || raw?.title || raw?.requisitionTitle || '');
    if (!title || title.length < 3) continue;

    const requisitionId = raw?.requisitionId;
    if (!requisitionId) continue;

    const publicUrl = buildPublicUrl(requisitionId);
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const rawCity = locations.find((l) => normalize(l?.country) === 'ch')?.city || '';
    const { city, postalCode, streetAddress, region } = resolveAddress(rawCity);
    const location = city || HQ.city;
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(region) || HQ.canton;

    const descriptionRaw = raw?.externalDescription || raw?.internalDescription || '';
    const descriptionText = normalizeSpace(stripHtml(descriptionRaw));
    const description = descriptionText || `${title} presso ${CHOPARD_COMPANY_NAME} a ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'fr');

    const jobSlug = slugify(`${title} chopard ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${title} ${descriptionText}`);

    const postedDate =
      parsePostingDate(raw?.postingEffectiveDate) || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${CHOPARD_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CHOPARD_COMPANY_NAME,
      companyKey: CHOPARD_KEY,
      companyDomain: CHOPARD_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Chopard Dedicated Parser (Cornerstone OnDemand)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
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
      jobReqId: String(requisitionId),
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${CHOPARD_COMPANY_NAME} Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}
