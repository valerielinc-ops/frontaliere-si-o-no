#!/usr/bin/env node
/**
 * Canton du Valais job parser — Fetcher and job builder.
 *
 * Source: https://www.vs.ch/web/srh/stellenborse (État du Valais civil-service
 *         job board; see OTB_PORTLET_URL below for the actual data fragment)
 *
 * Descriptions: the portlet listing only carries a one-line department blurb
 * (and the iApply ATS's own JSON detail endpoint returns that SAME blurb),
 * so the rich ad body is fetched from each offer's PDF and rebuilt with its
 * section/bullet structure — see ./canton-valais-otb-pdf.mjs (issue #3836).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCantonValaisJobs()  — Fetch and parse all jobs
 *   - isCantonValaisJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace as _normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { fetchOtbJobPdfDescription } from './canton-valais-otb-pdf.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CANTON_VALAIS_KEY = 'canton-valais';
export const CANTON_VALAIS_COMPANY_NAME = 'Canton du Valais';
export const CANTON_VALAIS_COMPANY_DOMAIN = 'vs.ch';

const OTB_LANDING_URL = 'https://www.vs.ch/web/srh/stellenborse';
const CAREER_URL = OTB_LANDING_URL;
const HQ = getCompanyDefaults('canton-valais');

/**
 * État du Valais career board — the public landing page is a Liferay portal
 * page whose job-offer list is rendered by a separate "vsotbportlet" AJAX
 * fragment (server-rendered HTML, no auth/JS execution required). The old
 * `vs.service-now.com/x/hdvi2/hvs-ats-portal/...` endpoint previously used
 * here was actually Hôpital du Valais's own dedicated ATS (see
 * hopital-du-valais-job-parser.mjs) — it never carried real "État du Valais"
 * civil-service postings (issue #3797).
 */
const OTB_PORTLET_URL =
  'https://www.vs.ch/c/portal/render_portlet?p_l_id=34365892&p_p_id=vsotbportlet' +
  '&p_p_lifecycle=0&p_t_lifecycle=0&p_p_state=normal&p_p_mode=view' +
  '&p_p_col_id=_com_liferay_nested_portlets_web_portlet_NestedPortletsPortlet_INSTANCE_vivDF3CdM1oJ__column-1' +
  '&p_p_col_pos=1&p_p_col_count=2&p_p_isolated=1&currentURL=%2Fweb%2Fsrh%2Fstellenborse';

// Legacy ServiceNow page-cap sentinel — retained only because
// resolveServiceNowPageCap() below is still covered by
// tests/canton-valais-crawler.test.ts (issue #3578).
const SN_DEFAULT_PAGE_CAP = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Canton du Valais.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCantonValaisJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CANTON_VALAIS_KEY ||
    key.startsWith('canton-valais') ||
    company.includes('canton du valais') ||
    url.includes('vs.ch')
  );
}

/**
 * Validate that a URL belongs to Canton du Valais's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'vs.ch' || host.endsWith('.vs.ch');
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

/**
 * Resolve the page-size cap to compare a ServiceNow listing count against.
 * Uses the URL's own `sysparm_limit` when present; otherwise falls back to
 * SN_DEFAULT_PAGE_CAP so the truncation warning still fires for endpoints
 * that don't carry an explicit limit param (issue #3578).
 */
export function resolveServiceNowPageCap(apiUrl) {
  const limitParam = new URL(apiUrl).searchParams.get('sysparm_limit');
  return limitParam ? Number(limitParam) : SN_DEFAULT_PAGE_CAP;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch job offers from the État du Valais Liferay portlet fragment.
 * Server-rendered HTML — no auth or JS execution required.
 */
async function fetchOtbListings() {
  let html = '';
  try {
    html = await fetchHtml(OTB_PORTLET_URL, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`   ⚠️ Failed to fetch État du Valais job portlet: ${err.message}`);
    return [];
  }
  return parseOtbListings(html);
}

const VALAIS_CITY_HINTS = [
  'Sion', 'Sierre', 'Martigny', 'Monthey', 'Brig-Glis', 'Brigue', 'Brig',
  'Visp', 'Naters', 'Loèche', 'Conthey', 'Vétroz', 'Saxon', 'Fully',
  'Bagnes', 'Verbier', 'Zermatt', 'Saas-Fee', 'Crans-Montana', 'Nendaz',
  'Savièse', 'Saint-Maurice', 'St-Gingolph', 'Collombey', 'Vouvry',
  'Troistorrents', 'Val de Bagnes',
];

function extractOtbCity(text = '') {
  for (const city of VALAIS_CITY_HINTS) {
    if (new RegExp(`\\b${city}\\b`, 'i').test(text)) return city;
  }
  return '';
}

/**
 * Parse the "vsotbportlet" fragment's `.ivs-job-offer` blocks into raw
 * listing objects shaped for the job-building loop below.
 * Exported for tests.
 */
export function parseOtbListings(html = '') {
  if (!html) return [];
  const jobs = [];
  const blockRx = /<div class="ivs-job-offer[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g;
  let match;
  while ((match = blockRx.exec(html))) {
    const block = match[1];

    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = normalizeSpace(stripHtml(titleMatch?.[1] || ''));
    if (!title) continue;

    const pMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const deptText = normalizeSpace(stripHtml(pMatch?.[1] || ''));

    const docMatch = block.match(/joboffersdocument\/(\d+)/i);
    const pdfUrl = docMatch
      ? `https://otb.apps.vs.ch/svc/api/joboffersdocument/${docMatch[1]}?language=fr`
      : '';

    const applyMatch = block.match(/href="(https:\/\/otb\.apps\.vs\.ch\/iapply\?[^"]*)"/i);
    const applyUrl = applyMatch ? applyMatch[1].replace(/&amp;/g, '&') : '';

    const location = extractOtbCity(deptText) || HQ?.city || 'Sion';

    jobs.push({
      title,
      location,
      url: applyUrl || pdfUrl || OTB_LANDING_URL,
      description: deptText,
      pdfUrl,
    });
  }
  return jobs;
}

/**
 * Fetch all Canton du Valais (État du Valais) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Source: the public `vs.ch` civil-service job board, whose listing is
 * rendered by a Liferay "vsotbportlet" fragment (see fetchOtbListings()).
 */
export async function fetchAllCantonValaisJobs() {
  console.log(`🔍 Fetching Canton du Valais jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchOtbListings();

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on the État du Valais job portlet.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || listing.name || listing.short_description || '');
    if (!title || title.length < 3) continue;

    // Extract location from listing data or default to Sion
    const rawLocation = listing.location || listing.city || listing.work_location || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Sion';
    const canton = inferAnyCanton(location) || HQ?.canton || 'VS';
    // The portlet listing only carries a one-line department blurb — the
    // real ad body (tasks, profile, entry date, contacts) lives in the
    // per-job PDF only (issue #3836: 13/19 thin stubs). Prefer the PDF's
    // structured text; fall back to the department blurb when the PDF is
    // missing, unreachable, or image-only.
    let pdfDescription = '';
    if (listing.pdfUrl) {
      console.log(`  📄 Fetching job-ad PDF: ${title}`);
      pdfDescription = await fetchOtbJobPdfDescription(listing.pdfUrl);
    }
    const descriptionHtml = listing.description || listing.job_description || listing.content || '';
    const descriptionText = pdfDescription || stripHtml(descriptionHtml);
    const publicUrl = listing.url || listing.link || listing.apply_url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} canton-valais ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Poste au sein de l'administration cantonale du Valais, Suisse.`;

    const job = {
      id: `canton-valais-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CANTON_VALAIS_COMPANY_NAME,
      companyKey: CANTON_VALAIS_KEY,
      companyDomain: CANTON_VALAIS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Canton du Valais Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'VS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '1950',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || listing.employment_type || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Administration publique / Service public',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || listing.posted_date || listing.sys_created_on?.slice(0, 10) || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Canton du Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
