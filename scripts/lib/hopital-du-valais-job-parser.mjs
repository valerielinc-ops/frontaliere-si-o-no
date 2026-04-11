/**
 * Hôpital du Valais (HVS) job parser — ServiceNow databroker API.
 *
 * The HVS career portal runs on ServiceNow UXF. The public databroker
 * API returns structured JSON without authentication, so no browser
 * automation is needed.
 *
 * API endpoints (all POST to /api/now/uxf/databroker/exec):
 *   - data_broker_published_job_list_v2g  — paginated listing (10/page)
 *   - data_broker_total_published_job_list_v2  — total count
 *   - data_broker_get_selected_annonce_v2  — full job detail
 *
 * Source: https://vs.service-now.com/x/hdvi2/hvs-ats-portal/landing/params/language/fr/spref/
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const API_BASE = 'https://vs.service-now.com/api/now/uxf/databroker/exec';
const PORTAL_BASE = 'https://vs.service-now.com/x/hdvi2/hvs-ats-portal';
const PAGE_SIZE = 10;

// ServiceNow pipeline definition IDs (stable — part of the app config)
const PIPELINE_LIST = 'data_broker_published_job_list_v2g';
const PIPELINE_TOTAL = 'data_broker_total_published_job_list_v2';
const PIPELINE_DETAIL = 'data_broker_get_selected_annonce_v2';
const DEF_LIST = '80aeab4f1bf25550e63a41588b4bcb0d';
const DEF_TOTAL = 'a777e2f21b3ad150e63a41588b4bcbe8';
const DEF_DETAIL = '7193cc971b765550e63a41588b4bcbc1';

// Published, external, not spontaneous, not expired
const QUERY_FILTER =
  'u_spontaneous_application=false^u_annonce_status=3^u_publication_externe=true^u_date_fin>=javascript:gs.beginningOfToday()';

export const HVS_KEY = 'hopital-du-valais';
export const HVS_COMPANY_NAME = 'Hôpital du Valais';
export const HVS_COMPANY_DOMAIN = 'hopitalvs.ch';

/* ── Postal code map for Valais cities ─────────────────────── */

const VS_POSTAL_CODES = {
  sion: '1950',
  sierre: '3960',
  martigny: '1920',
  brig: '3900',
  visp: '3930',
  monthey: '1870',
  st_maurice: '1890',
  saxon: '1907',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function slugify(text = '', maxLength = 90) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}

/**
 * Parse DD.MM.YYYY → YYYY-MM-DD. Returns '' on failure.
 */
function parseDate(raw = '') {
  const m = String(raw || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Normalize employment percentage: "20 %" → "20", "100 %" → "100".
 */
function parsePct(raw = '') {
  const m = String(raw || '').match(/(\d+)/);
  return m ? m[1] : '';
}

/**
 * Build employment type string from min/max percentages.
 * "20 %" / "100 %" → "20 - 100%"
 */
export function buildEmploymentType(min = '', max = '') {
  const lo = parsePct(min);
  const hi = parsePct(max);
  if (!lo && !hi) return '';
  if (lo === hi) return `${lo}%`;
  if (!lo) return `${hi}%`;
  if (!hi) return `${lo}%`;
  return `${lo} - ${hi}%`;
}

/**
 * Build the canonical detail page URL from sys_id.
 */
export function buildDetailUrl(sysId = '') {
  return `${PORTAL_BASE}/annonce-details-page/x_hdvi2_hvs_applic_annonce/${sysId}/params/language/fr`;
}

/**
 * Infer postal code from site name.
 */
function inferPostalCode(site = '') {
  const key = String(site || '').toLowerCase().replace(/[^a-z]/g, '_');
  return VS_POSTAL_CODES[key] || '1950';
}

/**
 * Detect category from the u_famille field.
 */
export function detectCategory(famille = '') {
  const f = normalizeSpace(famille).toLowerCase();
  if (f.includes('médecin') || f.includes('arzt') || f.includes('ärzt')) return 'healthcare-medical';
  if (f.includes('soins') || f.includes('pflege') || f.includes('infirm')) return 'healthcare-nursing';
  if (f.includes('psycholog')) return 'healthcare-psychology';
  if (f.includes('pharma')) return 'pharma';
  if (f.includes('formation') || f.includes('ausbildung')) return 'education';
  if (f.includes('logistique') || f.includes('technique') || f.includes('technik')) return 'logistics';
  if (f.includes('financ') || f.includes('finanzen')) return 'finance';
  if (f.includes('administrat') || f.includes('verwaltung')) return 'administration';
  if (f.includes('informatique') || f.includes('informatik') || f.includes('it')) return 'technology';
  if (f.includes('médico') || f.includes('medizinisch')) return 'healthcare-medtech';
  if (f.includes('hôtelier') || f.includes('hotellerie') || f.includes('restauration')) return 'hospitality';
  if (f.includes('social')) return 'social-work';
  return 'healthcare';
}

/* ── API calls ─────────────────────────────────────────────── */

async function callDatabroker(definitionSysId, inputValues, pipelineId) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      body: JSON.stringify([{
        type: 'TRANSFORM',
        definitionSysId,
        inputValues,
        pipelineId,
      }]),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ServiceNow API`);
    }

    const data = await res.json();
    return data?.result?.[0]?.executionResult?.output || [];
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchTotalCount() {
  const output = await callDatabroker(DEF_TOTAL, {
    query: { type: 'JSON_LITERAL', value: QUERY_FILTER },
  }, PIPELINE_TOTAL);
  return output?.[0]?.RowCount || 0;
}

async function fetchJobListPage(offset = 0) {
  return callDatabroker(DEF_LIST, {
    query: { type: 'JSON_LITERAL', value: QUERY_FILTER },
    language: { type: 'JSON_LITERAL', value: 'fr' },
    record_offset: { type: 'JSON_LITERAL', value: offset },
    fieldsort: { type: 'JSON_LITERAL', value: 'u_date_published' },
  }, PIPELINE_LIST);
}

async function fetchJobDetail(sysId) {
  const output = await callDatabroker(DEF_DETAIL, {
    query: { type: 'JSON_LITERAL', value: `sys_id=${sysId}` },
    language: { type: 'JSON_LITERAL', value: 'fr' },
  }, PIPELINE_DETAIL);
  return output?.[0] || null;
}

/* ── Job identification ────────────────────────────────────── */

export function isHvsJob(job = {}) {
  const key = String(job?.companyKey || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === HVS_KEY ||
    company.includes('hôpital du valais') ||
    company.includes('hopital du valais') ||
    company.includes('spital wallis') ||
    url.includes('vs.service-now.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'vs.service-now.com' ||
      host === 'www.hopitalvs.ch' ||
      host === 'hopitalvs.ch' ||
      host.endsWith('.service-now.com')
    );
  } catch {
    return false;
  }
}

/* ── Build job from API data ───────────────────────────────── */

function buildDescription(listing, detail) {
  const parts = [];

  // Intro from listing description
  const intro = stripHtml(listing.u_description || '');
  if (intro) parts.push(intro);

  // Mission / tasks from detail
  if (detail?.mission) {
    const missionText = stripHtml(detail.mission);
    if (missionText) parts.push(`Mission:\n${missionText}`);
  }

  // Profile / requirements from detail
  if (detail?.profil) {
    const profilText = stripHtml(detail.profil);
    if (profilText) parts.push(`Profil:\n${profilText}`);
  }

  // Offer / benefits from detail
  if (detail?.offer) {
    const offerText = stripHtml(detail.offer);
    if (offerText) parts.push(`Offre:\n${offerText}`);
  }

  return parts.join('\n\n') || normalizeSpace(listing.u_titre || '');
}

function buildJobFromApi(listing, detail) {
  const sysId = listing.sys_id;
  const number = listing.number || '';
  const title = normalizeSpace(listing.u_titre || detail?.titre || '');
  const site = normalizeSpace(listing.u_site || detail?.site || '');
  const societe = normalizeSpace(listing.u_societe || detail?.societe || '');
  const famille = normalizeSpace(listing.u_famille || detail?.famille || '');

  // Detect source language (FR for Valais romand, DE for Oberwallis)
  const hasDe = !!(listing.u_titre_de && listing.u_titre_de.trim());
  const descText = stripHtml(listing.u_description || '');
  const sourceLang = hasDe && !listing.u_description ? 'de' : detectLang(descText || title, 'fr');

  const description = buildDescription(listing, detail);
  const employmentType = buildEmploymentType(
    listing.u_tx_occupation_min,
    listing.u_tx_occupation_max,
  );

  const postedDate = parseDate(listing.u_date_published || listing.u_date_debut);
  const detailUrl = buildDetailUrl(sysId);
  const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
  const locationForSlug = site || 'valais';
  const jobSlug = slugify(`${title} ${HVS_COMPANY_NAME} ${locationForSlug}`);

  return {
    id: `${HVS_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: HVS_COMPANY_NAME,
    companyKey: HVS_KEY,
    companyDomain: HVS_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: site ? site.charAt(0) + site.slice(1).toLowerCase() : 'Sion',
    canton: 'VS',
    addressLocality: site ? site.charAt(0) + site.slice(1).toLowerCase() : 'Sion',
    addressCountry: 'CH',
    country: 'CH',
    postalCode: inferPostalCode(site),
    category: detectCategory(famille),
    sector: 'Santé / Hôpital',
    contract: 'full-time',
    employmentType: employmentType || 'OTHER',
    featured: false,
    postedDate: postedDate || new Date().toISOString().slice(0, 10),
    url: detailUrl,
    applyUrl: detailUrl,
    source: 'HVS Dedicated Parser (ServiceNow API)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    _hvsMeta: {
      number,
      sysId,
      societe,
      famille,
      site,
    },
  };
}

/* ── Main fetch function ───────────────────────────────────── */

/**
 * Fetch all HVS jobs from the ServiceNow databroker API.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllHvsJobs() {
  console.log(`🏥 Fetching Hôpital du Valais jobs from ServiceNow API`);
  console.log(`   API: ${API_BASE}`);
  console.log(`   Portal: ${PORTAL_BASE}\n`);

  const total = await fetchTotalCount();
  console.log(`  📊 Total published jobs: ${total}`);

  if (total === 0) {
    console.warn('⚠️ ServiceNow API returned 0 published jobs.');
    return [];
  }

  // Paginate through all listings
  const allListings = [];
  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    const page = await fetchJobListPage(offset);
    if (!page || page.length === 0) break;
    allListings.push(...page);
    console.log(`  📄 Page ${Math.floor(offset / PAGE_SIZE) + 1}: ${page.length} jobs (total so far: ${allListings.length})`);
    if (page.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n  📋 Listings fetched: ${allListings.length}. Fetching details...\n`);

  // Fetch detail for each job (for richer description)
  const jobs = [];
  for (const listing of allListings) {
    const sysId = listing.sys_id;
    if (!sysId) continue;

    try {
      const detail = await fetchJobDetail(sysId);
      const job = buildJobFromApi(listing, detail);
      jobs.push(job);
      console.log(`  ✅ ${listing.number} — ${normalizeSpace(listing.u_titre).substring(0, 60)}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${listing.number} — detail fetch failed: ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total unique HVS jobs discovered: ${deduped.length}`);
  return deduped;
}
