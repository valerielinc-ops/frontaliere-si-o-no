#!/usr/bin/env node
/**
 * NVIDIA (ufficio Zurich) job parser — Workday ATS.
 *
 * Tenant host: nvidia.wd5.myworkdayjobs.com
 * Site path:   NVIDIAExternalCareerSite
 * Career URL:  https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
 *
 * NVIDIA's global Workday tenant lists ~2000 open roles worldwide. Its only
 * Swiss office is Zurich (R&D hub). We filter with the tenant's
 * `locationHierarchy1` facet for "Switzerland"
 * (id `2fcb99c455831013ea52e9ef1a0032ba`, verified live: 36/2000 postings) —
 * this tenant has no `locationCountry`/`locationHierarchy2`-per-city facet,
 * only the country-level rollup.
 *
 * NVIDIA posts most reqs to MANY countries simultaneously (a single req is
 * often listed as e.g. "Germany, Remote" primary + ["UK, Remote",
 * "Switzerland, Remote"] additional locations). The listing endpoint's
 * `locationsText` only ever says "N Locations" for these — the real
 * location list lives on the detail endpoint (`jobPostingInfo.location` +
 * `.additionalLocations`), which we already fetch for the description body.
 * Live verification (2026-07-03) confirmed every one of the 36
 * Switzerland-tagged postings resolves to either "Switzerland, Zurich" or
 * "Switzerland, Remote" — never another Swiss city — consistent with the
 * single-office-hub brief, so all matches are mapped to Zürich / ZH.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllNvidiaZurichJobs() — Fetch and parse all Swiss jobs
 *   - isNvidiaZurichJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to NVIDIA / Workday tenant
 *   - NVIDIA_ZURICH_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDescriptionText,
  fetchWorkdayJobDetail,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const NVIDIA_ZURICH_KEY = 'nvidia-zurich';
export const NVIDIA_ZURICH_COMPANY_NAME = 'NVIDIA (ufficio Zurich)';
export const NVIDIA_ZURICH_COMPANY_DOMAIN = 'nvidia.com';

const WORKDAY_TENANT_HOST = 'nvidia.wd5.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'NVIDIAExternalCareerSite';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en-US/${WORKDAY_SITE_PATH}`;

const CAREER_URL = `https://${WORKDAY_TENANT_HOST}/${WORKDAY_SITE_PATH}`;

// `locationHierarchy1` facet value for "Switzerland" on the NVIDIA tenant —
// verified live via POST {API_BASE}/jobs with searchText:'' and inspecting
// the returned `facets[].values` (this tenant has no `locationCountry`
// facet, unlike most Workday tenants).
const SWITZERLAND_FACET_ID = '2fcb99c455831013ea52e9ef1a0032ba';

const ZURICH_CITY = 'Zürich';
const ZURICH_CANTON = 'ZH';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isNvidiaZurichJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === NVIDIA_ZURICH_KEY ||
    key.startsWith('nvidia-zurich') ||
    company.includes('nvidia') ||
    url.includes('nvidia.com') ||
    url.includes(WORKDAY_TENANT_HOST)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'nvidia.com' ||
      host.endsWith('.nvidia.com') ||
      host === WORKDAY_TENANT_HOST ||
      host.endsWith('.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ──────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(sales|account|business\s*develop|territory)/.test(t)) return 'Vendite';
  if (/\b(market|brand|communit|content)/.test(t)) return 'Marketing';
  if (/\b(hr|human|talent|recruit|people)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|account|controller|tax|treasur)/.test(t)) return 'Finanza';
  if (/\b(legal|counsel|attorney|compliance)/.test(t)) return 'Legale';
  if (/\b(supply|logist|procurement|purchas)/.test(t)) return 'Logistica';
  if (/\b(program\s*manag|project\s*manag|product\s*manag)/.test(t)) return 'Gestione Progetti';
  if (/\b(research|scientist|phd)/.test(t)) return 'Ricerca';
  if (/\b(engineer|developer|architect|software|compiler|kubernetes|devops|it\b|cloud|network|system)/.test(t)) return 'Ingegneria';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|internship|new\s*college\s*grad|university|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|principal|staff|lead|head|director|manager|chief)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (/part.?time/.test(t)) return 'PART_TIME';
  if (/full.?time/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Workday fetcher ──────────────────────────────────────────
 * NVIDIA lists most reqs against several countries at once. We filter the
 * listing to the Switzerland facet, then confirm on the detail payload
 * (already fetched for the description) that "Switzerland" genuinely
 * appears in `location`/`additionalLocations` before keeping the job.
 */
async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      appliedFacets: { locationHierarchy1: [SWITZERLAND_FACET_ID] },
      maxPages: 100000,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        publicBase: WORKDAY_PUBLIC_BASE,
        company: NVIDIA_ZURICH_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(`❌ Workday anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }
  return out;
}

/**
 * Fetch all NVIDIA (ufficio Zurich) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 */
export async function fetchAllNvidiaZurichJobs() {
  console.log(`🔍 Fetching ${NVIDIA_ZURICH_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Workday: ${WORKDAY_API_BASE}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss (Zurich) job listings returned from Workday API.');
    return [];
  }

  console.log(`  📋 Switzerland-tagged listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // Detail payload carries the real location list — the listing endpoint
    // only reports "N Locations" for these multi-country reqs.
    const detail = await fetchWorkdayJobDetail(WORKDAY_API_BASE, listing.externalPath);
    const info = detail?.jobPostingInfo || {};
    const primaryLocation = String(info.location || '');
    const additionalLocations = Array.isArray(info.additionalLocations) ? info.additionalLocations : [];
    const isSwissRole = /switzerland/i.test(primaryLocation) || additionalLocations.some((l) => /switzerland/i.test(String(l)));
    if (!isSwissRole) {
      // Facet match without a confirmed Switzerland location on detail —
      // skip rather than mislabel a foreign-only role as Zurich.
      console.log(`  ⏭️  Skipped (no confirmed CH location on detail): ${title}`);
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    const location = ZURICH_CITY;
    const canton = ZURICH_CANTON;
    const publicUrl = listing.url || CAREER_URL;

    const html = String(info.jobDescription || '').trim();
    const detailDescription = html
      ? stripHtml(html).replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000)
      : await fetchWorkdayJobDescriptionText(WORKDAY_API_BASE, listing.externalPath, stripHtml);
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${NVIDIA_ZURICH_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}, Kanton ${canton}, Schweiz`,
      '• Employer: NVIDIA — global leader in accelerated computing and AI (GPUs, CUDA, data center + robotics/AI platforms).',
      '• Swiss footprint: Zurich R&D hub (GPU networking, HPC/AI research, developer relations).',
      '• Apply: NVIDIA Workday careers portal.',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ${NVIDIA_ZURICH_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${NVIDIA_ZURICH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: NVIDIA_ZURICH_COMPANY_NAME,
      companyKey: NVIDIA_ZURICH_KEY,
      companyDomain: NVIDIA_ZURICH_COMPANY_DOMAIN,
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
      source: `${NVIDIA_ZURICH_COMPANY_NAME} Dedicated Parser (Workday)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(info.timeType || ''),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Tecnologia / Semiconduttori',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (listing.jobReqId) job.jobReqId = listing.jobReqId;

    jobs.push(job);
  }

  console.log(`\n📋 Total ${NVIDIA_ZURICH_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
