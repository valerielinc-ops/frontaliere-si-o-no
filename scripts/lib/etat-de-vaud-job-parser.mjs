#!/usr/bin/env node
/**
 * État de Vaud (Administration cantonale vaudoise) job parser.
 *
 * Table hint said 'jobup.ch (feed)' / 'Custom (jobup.ch affiliate)' — WRONG,
 * same mislabel already seen for EVAM (row 49, actually Teamtailor) and under
 * verification for Groupe E (row 55). Confirmed LIVE by curl:
 *
 *   https://www.vd.ch/etat-droit-finances/etat-employeur/offres-demploi
 *     → https://offres-emploi.vd.ch/ (TYPO3 wrapper, `data-host` attr)
 *     → https://fa-ewrg-saasfaeuraprod1.fa.ocs.oraclecloud.com
 *
 * The real backend is Oracle Recruiting Cloud (Oracle Fusion Cloud HCM
 * "Candidate Experience", site number CX_1) — NOT jobup.ch, NOT Prospective,
 * NOT any ATS already covered by a shared factory in this repo. Public REST
 * API (no auth required for the CE site):
 *
 *   List:   {HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *             ?onlyData=true&finder=findReqs;siteNumber=CX_1,limit=25,offset=N
 *   Detail: {HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
 *             ?onlyData=true&finder=ById;Id="{id}",siteNumber=CX_1
 *   Public job page: https://offres-emploi.vd.ch/#fr/sites/CX_1/job/{id}
 *
 * ~28 open roles at time of writing (table said 22 — count fluctuates
 * normally), spanning multiple Vaud localities (Lausanne, Vevey, Aigle,
 * Yverdon-les-Bains, Morges, Orbe, Renens, etc.) — offices of the Ordre
 * judiciaire vaudois and cantonal departments, not a single HQ address.
 * The Oracle `workLocation` node never carries a structured street/PLZ for
 * this tenant, so per-city PLZ is resolved via a small local lookup with
 * the cantonal seat (Lausanne, Place du Château 1, 1014) as the safe
 * default for anything unmapped (Non-Negotiable #3 requires the field
 * present, not necessarily hyper-precise for a canton-wide employer).
 *
 * Exports the 4 functions required by the standard crawler template:
 *   - fetchAllEtatDeVaudJobs() — Fetch and parse all jobs
 *   - isEtatDeVaudJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ETAT_DE_VAUD_KEY = 'etat-de-vaud';
export const ETAT_DE_VAUD_COMPANY_NAME = 'État de Vaud (Administration cantonale vaudoise)';
export const ETAT_DE_VAUD_COMPANY_DOMAIN = 'vd.ch';

const CAREER_URL = 'https://offres-emploi.vd.ch/';
const ORACLE_HOST = 'https://fa-ewrg-saasfaeuraprod1.fa.ocs.oraclecloud.com';
const SITE_NUMBER = 'CX_1';
const PAGE_LIMIT = 25;

const ORACLE_HEADERS = { 'ora-irc-vanity-domain': 'Y' };

// État de Vaud (Chancellerie / administration cantonale) — used only as the
// canton-gated safe default when a job's exact office street isn't known;
// mirrors the resolveAddress() pattern in bcv-job-parser.mjs.
const HQ = {
  city: 'Lausanne',
  canton: 'VD',
  postalCode: '1014',
  streetAddress: 'Place du Château 1',
};

// Small locality → PLZ lookup for the Vaud communes seen hosting cantonal
// offices (Ordre judiciaire vaudois districts, cantonal departments, etc.).
// Keys are lowercase + diacritic-stripped + trailing " vd" removed.
const VD_LOCALITY_POSTAL_CODES = {
  lausanne: '1000',
  aigle: '1860',
  morges: '1110',
  orbe: '1350',
  palezieux: '1607',
  penthalaz: '1305',
  prilly: '1008',
  renens: '1020',
  'st-sulpice': '1025',
  vevey: '1800',
  'yverdon-les-bains': '1400',
  montreux: '1820',
  nyon: '1260',
  payerne: '1530',
  moudon: '1510',
  rolle: '1180',
  bex: '1880',
  'la tour-de-peilz': '1814',
  pully: '1009',
  echallens: '1040',
  cossonay: '1304',
  vallorbe: '1337',
  bussigny: '1030',
  gland: '1196',
  'sainte-croix': '1450',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripDiacritics(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extract the leading locality from an Oracle `PrimaryLocation` string, e.g.
 * "Vevey, Riviera-Pays-d'Enhaut, Suisse" → "Vevey",
 * "Renens VD, Ouest Lausannois, Suisse" → "Renens VD".
 */
function extractCity(primaryLocation = '') {
  const first = String(primaryLocation || '').split(',')[0];
  return normalizeSpace(first);
}

function localityLookupKey(cityRaw = '') {
  return stripDiacritics(normalize(cityRaw))
    .replace(/\bvd\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Canton-gated address resolution (mirrors bcv-job-parser.mjs). Always
 * returns a concrete postalCode/streetAddress — the cantonal seat is the
 * safe default (Non-Negotiable #3) when the specific office locality isn't
 * in the local lookup table.
 */
function resolveAddress(primaryLocation = '') {
  const city = extractCity(primaryLocation) || HQ.city;
  const canton = inferSwissTargetCanton(city) || HQ.canton;
  const key = localityLookupKey(city);
  const postalCode = VD_LOCALITY_POSTAL_CODES[key] || HQ.postalCode;

  return {
    city,
    canton,
    postalCode,
    // Exact office street isn't exposed by this Oracle tenant for any
    // locality — the cantonal seat street is used as the safe default.
    streetAddress: HQ.streetAddress,
    region: canton,
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to État de Vaud.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isEtatDeVaudJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = stripDiacritics(normalize(job?.company || ''));
  const url = normalize(job?.url || '');

  return (
    key === ETAT_DE_VAUD_KEY ||
    key.startsWith('etat-de-vaud') ||
    company.includes('etat de vaud') ||
    url.includes('offres-emploi.vd.ch')
  );
}

/**
 * Validate that a URL belongs to État de Vaud's official recruitment domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'offres-emploi.vd.ch' || host === 'vd.ch' || host.endsWith('.vd.ch');
  } catch {
    return false;
  }
}

/* ── Category / Employment Type Detection ─────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|ingenieur|ing[ée]nieur)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|electric|install)/.test(t)) return 'Tecnica';
  if (/\b(huissi|greffi|juridi|juriste|droit|legal)/.test(t)) return 'Legale';
  if (/\b(admin|secr[ée]tari|gestion|comptab|contab)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|commerce|commercial)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|entrep[oô]t|warehouse)/.test(t)) return 'Logistica';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it\b|informatique|software|d[ée]velopp|programm)/.test(t)) return 'IT';
  if (/\b(hr\b|rh\b|ressources humaines|personnel)/.test(t)) return 'Risorse Umane';
  if (/\b(market|communicat)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(soign|infirmi|m[ée]dical|sant[ée])/.test(t)) return 'Sanità';
  if (/\b(enseign|professeur|formateur|formation)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stagiair|stage|apprenti|apprentissage)/.test(t)) return 'intern';
  if (/\b(junior)/.test(t)) return 'junior';
  if (/\b(chef|cheffe|directeur|directrice|responsable|senior|adjoint)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * État de Vaud job titles/short-descriptions carry a taux d'activité range
 * like "80-100%" or "50%". Anything with a max under 80% is treated as
 * PART_TIME (same threshold convention as spital-thusis / solothurner
 * -spitaeler / pdgr parsers in this repo).
 */
function detectEmploymentType(text = '') {
  const t = normalize(text);
  const matches = [...t.matchAll(/(\d{1,3})\s*%/g)].map((m) => parseInt(m[1], 10));
  if (matches.length > 0) {
    const max = Math.max(...matches);
    return max < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  if (/\b(temps partiel|partiel)\b/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch one page of the public Oracle Recruiting Cloud CE job list.
 */
async function fetchJobRequisitionsPage(offset) {
  // NOTE: the Oracle `finder` param must keep its literal `;`/`,`/`=`
  // separators — encodeURIComponent() would escape `=` to `%3D` too and
  // break offset/limit parsing server-side, so this is built by hand
  // rather than run through a full encode + partial un-escape.
  const finder = `findReqs;siteNumber=${SITE_NUMBER},limit=${PAGE_LIMIT},offset=${offset},sortBy=POSTING_DATES_DESC`;
  const url = `${ORACLE_HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=all&finder=${finder}`;
  const data = await fetchJson(url, { headers: ORACLE_HEADERS });
  const page = data?.items?.[0];
  return {
    totalCount: Number(page?.TotalJobsCount) || 0,
    requisitions: Array.isArray(page?.requisitionList) ? page.requisitionList : [],
  };
}

/**
 * Fetch the full requisition detail (description/qualifications) for a
 * single job by its numeric Oracle requisition Id.
 */
async function fetchJobRequisitionDetail(id) {
  // Same rationale as fetchJobRequisitionsPage() — only the double quotes
  // around the Id value need percent-encoding, `;`/`,`/`=` must stay literal.
  const finder = `ById;Id=%22${id}%22,siteNumber=${SITE_NUMBER}`;
  const url = `${ORACLE_HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=${finder}`;
  const data = await fetchJson(url, { headers: ORACLE_HEADERS });
  return data?.items?.[0] || null;
}

/**
 * Fetch all requisition list pages (handles pagination beyond PAGE_LIMIT).
 */
async function fetchAllRequisitions() {
  const all = [];
  let offset = 0;
  let totalCount = Infinity;
  while (offset < totalCount) {
    const { totalCount: count, requisitions } = await fetchJobRequisitionsPage(offset);
    totalCount = count;
    if (requisitions.length === 0) break;
    all.push(...requisitions);
    offset += PAGE_LIMIT;
  }
  return all;
}

/**
 * Fetch all État de Vaud jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only source-locale fields are set here. Other locales are
 * filled downstream by the AI localization step (translate-pending pipeline).
 */
export async function fetchAllEtatDeVaudJobs() {
  console.log(`🔍 Fetching État de Vaud jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Platform: Oracle Recruiting Cloud (Fusion Cloud HCM, site ${SITE_NUMBER})\n`);

  let requisitions;
  try {
    requisitions = await fetchAllRequisitions();
  } catch (err) {
    console.warn(`⚠️ Failed to fetch requisition list: ${err?.message || err}`);
    return [];
  }

  if (!requisitions || requisitions.length === 0) {
    console.warn('⚠️ No job requisitions found.');
    return [];
  }

  console.log(`  📋 Requisitions found: ${requisitions.length}`);

  const jobs = [];
  for (const req of requisitions) {
    const id = String(req?.Id || '').trim();
    const title = normalizeSpace(req?.Title || '');
    if (!id || !title) continue;

    let detail = null;
    try {
      detail = await fetchJobRequisitionDetail(id);
    } catch (err) {
      console.warn(`   ⚠️ Detail fetch failed for requisition ${id}: ${err?.message || err}`);
    }

    const descriptionParts = [
      stripHtml(detail?.ExternalDescriptionStr || ''),
      stripHtml(detail?.ExternalResponsibilitiesStr || ''),
      stripHtml(detail?.ExternalQualificationsStr || ''),
    ]
      .map((part) => normalizeSpace(part))
      .filter(Boolean);

    const boilerplate = `Poste au sein de l'Administration cantonale vaudoise (État de Vaud), Suisse. Candidature en ligne sur le portail carrière officiel offres-emploi.vd.ch.`;
    const description = descriptionParts.length > 0
      ? [...descriptionParts, boilerplate].join('\n\n')
      : `${title} — ${boilerplate}`;

    const primaryLocation = detail?.PrimaryLocation || req?.PrimaryLocation || '';
    const address = resolveAddress(primaryLocation);

    const shortDescription = req?.ShortDescriptionStr || '';
    const sourceLang = detectLang(description || title, 'fr');
    const jobSlug = slugify(`${title} etat de vaud ${address.city}`);
    const publicUrl = `${CAREER_URL}#fr/sites/${SITE_NUMBER}/job/${id}`;
    const postedDate = req?.PostedDate || detail?.ExternalPostedStartDate?.slice(0, 10) || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${ETAT_DE_VAUD_KEY}-${id}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ETAT_DE_VAUD_COMPANY_NAME,
      companyKey: ETAT_DE_VAUD_KEY,
      companyDomain: ETAT_DE_VAUD_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: address.city,
      canton: address.canton,
      url: publicUrl,
      source: 'État de Vaud Dedicated Parser (Oracle Recruiting Cloud)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Location details ──
      addressLocality: address.city,
      addressRegion: address.region,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: address.postalCode,
      streetAddress: address.streetAddress,

      // ── Classification ──
      category: detectCategory(title),
      contract: detectEmploymentType(`${shortDescription} ${title}`) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(`${shortDescription} ${title}`),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Administration publique / Service public',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n📋 Total État de Vaud jobs discovered: ${jobs.length}`);
  return jobs;
}
