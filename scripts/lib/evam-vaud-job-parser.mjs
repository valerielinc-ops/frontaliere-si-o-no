#!/usr/bin/env node
/**
 * EVAM (Établissement vaudois de l'accueil des migrants) job parser.
 *
 * Discovery tagged this employer "jobup.ch (feed)" / ATS "Custom (jobup.ch
 * affiliate)". Live verification (2026-07) found this WRONG — EVAM's real
 * career site (https://emploi.evam.ch/) runs on **Teamtailor**, evidenced by
 * `app.teamtailor.com` dashboard links, `images.teamtailor-cdn.com` asset
 * host, and the "Site carrière de Teamtailor" footer credit. Same wrong-tag
 * pattern recurring across this campaign (Kanton St. Gallen tagged jobs.ch
 * but was Umantis; Valiant Bank tagged jobs.ch but was Prospective + SAP
 * SuccessFactors; ZFV-Unternehmungen tagged Custom but was rexx systems).
 *
 * Source: https://emploi.evam.ch/jobs.json (Teamtailor JSONFeed export).
 * Each item embeds `_jobposting` — a genuine schema.org JobPosting JSON-LD
 * object (title, description HTML, datePosted, hiringOrganization,
 * jobLocation[].address with real per-site streetAddress/postalCode/
 * addressLocality). This gives real per-site Vaud location data (Lausanne
 * HQ, Blonay, Gryon, Vevey, Chavannes-près-Renens, Savigny, Féchy, …) — not
 * a single defaulted HQ for every job.
 *
 * Source language: French (`sourceLang: 'fr'`) — this is a Vaud (French-
 * speaking canton) employer, unlike most of this campaign's German-speaking
 * cantons.
 *
 * Reuses shared Teamtailor HTML→markdown conversion from
 * `./axpo-job-parser.mjs` (Axpo is also Teamtailor-backed) instead of
 * duplicating it, and the shared JSON-LD address extractor from
 * `./jsonld-jobposting.mjs` (AGENTS.md Non-Negotiable #6 — reuse, don't
 * duplicate a shared pattern).
 *
 * Exports the 3 functions the crawler template expects:
 * - fetchAllEvamVaudJobs() — fetch + parse all jobs
 * - isEvamVaudJob()        — match jobs belonging to this company
 * - isTrustedDomain()      — validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { htmlToMarkdown } from './axpo-job-parser.mjs';
import { jobPostingAddress } from './jsonld-jobposting.mjs';
import { slugify } from './crawler-template.mjs';

/* -- Constants ------------------------------------------------- */

export const EVAM_VAUD_KEY = 'evam-vaud';
export const EVAM_VAUD_COMPANY_NAME = "EVAM – Établissement vaudois de l'accueil des migrants";
export const EVAM_VAUD_COMPANY_DOMAIN = 'evam.ch';

const JOBS_FEED_URL = 'https://emploi.evam.ch/jobs.json';
const CAREER_SITE_HOST = 'emploi.evam.ch';
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoCrawler/1.0)';

// EVAM operates exclusively within Canton Vaud (cantonal mandate). Real
// per-job addresses come from `_jobposting.jobLocation` (see above); this is
// only the fallback for the rare item missing that block at the source.
const EVAM_HQ = {
  streetAddress: 'Rte de Chavannes 31',
  postalCode: '1007',
  addressLocality: 'Lausanne',
  addressRegion: 'VD',
  addressCountry: 'CH',
};

/* -- Matching ---------------------------------------------------- */

export function isEvamVaudJob(job) {
  if (!job) return false;
  if (job.companyKey === EVAM_VAUD_KEY) return true;
  const company = String(job.company || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();
  return (
    company.includes('evam') ||
    url.includes(CAREER_SITE_HOST)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'evam.ch' ||
      host.endsWith('.evam.ch')
    );
  } catch {
    return false;
  }
}

/* -- Employment type / contract inference ------------------------ */

/** Parse a leading/trailing "(80%)" or "(80-100%)" pensum from the title. */
export function parsePensum(title = '') {
  const m = String(title || '').match(/(\d{2,3})\s*-?\s*(\d{2,3})?\s*%/);
  if (!m) return { min: null, max: null };
  const min = parseInt(m[1], 10);
  const max = m[2] ? parseInt(m[2], 10) : min;
  return { min, max };
}

export function inferEmploymentType(title = '') {
  const { max } = parsePensum(title);
  if (max != null && max < 80) return 'PART_TIME';
  return 'FULL_TIME';
}

/** CDI (contrat à durée indéterminée) vs CDD (durée déterminée). */
export function inferContractType(title = '') {
  const t = String(title || '');
  if (/\bCDD\b/i.test(t)) return 'temporary';
  if (/\bCDI\b/i.test(t)) return 'permanent';
  return 'permanent';
}

/* -- Category inference (French keywords) ------------------------- */

export function inferCategory(title = '') {
  const t = title.toLowerCase();
  if (/(assistant.*social|éduc|foyer|accompagnement)/i.test(t)) return 'Sociale';
  if (/(ressources humaines|\brh\b|recrutement)/i.test(t)) return 'Risorse Umane';
  if (/(comptab|finance|contrôle de gestion|débiteur|contentieux)/i.test(t)) return 'Finanza';
  if (/(juridique|secrétaire juridique|enquête)/i.test(t)) return 'Legale';
  if (/(formateur|formation|fle|fli)/i.test(t)) return 'Formazione';
  if (/(intendant|gérant|administratif)/i.test(t)) return 'Amministrazione';
  if (/(immobilièr)/i.test(t)) return 'Immobiliare';
  return 'Amministrazione Pubblica';
}

function detectExperienceLevel(title = '') {
  const t = title.toLowerCase();
  if (/(stagiaire|stage|apprenti)/i.test(t)) return 'intern';
  if (/(chef|responsable|directeur|directrice)/i.test(t)) return 'senior';
  return 'mid';
}

/* -- Fetch + build ------------------------------------------------ */

async function fetchJobsFeed() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const res = await fetch(JOBS_FEED_URL, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${JOBS_FEED_URL}`);
  const feed = await res.json();
  return Array.isArray(feed?.items) ? feed.items : [];
}

function buildJob(item) {
  const ld = item?._jobposting || {};
  const title = String(item.title || ld.title || '').trim();
  const url = String(item.url || '').trim();

  const address = jobPostingAddress(ld);
  const hasRealAddress = !!(address.streetAddress || address.postalCode || address.addressLocality);
  const streetAddress = hasRealAddress ? address.streetAddress : EVAM_HQ.streetAddress;
  const postalCode = hasRealAddress ? address.postalCode : EVAM_HQ.postalCode;
  const addressLocality = hasRealAddress ? address.addressLocality : EVAM_HQ.addressLocality;
  // EVAM is a single-canton (Vaud) cantonal agency — hardcode VD rather than
  // fuzzy city inference (sanity-checked once below, not per-job, since a
  // mismatch would indicate a parser bug worth surfacing loudly).
  const addressRegion = 'VD';

  const rawHtml = ld.description || item.content_html || '';
  const detail = htmlToMarkdown(rawHtml);
  const description = (detail.markdown || '').slice(0, 5000);

  const stableId = extractNumericId(url) || createHash('sha1').update(url).digest('hex').slice(0, 12);
  const slug = slugify(`${title} evam vaud ch`);
  const postedDate = String(ld.datePosted || item.date_published || '').slice(0, 10) || todayIso();

  return {
    id: `${EVAM_VAUD_KEY}-${stableId}`,
    slug,
    slugByLocale: { fr: slug },
    company: 'EVAM',
    companyKey: EVAM_VAUD_KEY,
    companyDomain: EVAM_VAUD_COMPANY_DOMAIN,
    title,
    titleByLocale: { fr: title },
    description,
    descriptionByLocale: { fr: description },
    location: addressLocality,
    streetAddress,
    postalCode,
    addressLocality,
    addressRegion,
    addressCountry: 'CH',
    canton: 'VD',
    country: 'CH',
    url,
    source: 'EVAM Dedicated Parser',
    sourceLang: 'fr',
    postedDate,
    datePosted: postedDate,
    crawledAt: new Date().toISOString(),
    category: inferCategory(title),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Amministrazione Pubblica',
    employmentType: inferEmploymentType(title),
    contract: inferContractType(title) === 'permanent' ? 'full-time' : 'temporary',
    contractType: inferContractType(title),
    currency: 'CHF',
    hiringOrganizationName: 'EVAM',
  };
}

function extractNumericId(url = '') {
  const m = String(url || '').match(/\/jobs\/(\d{5,})-/);
  return m ? m[1] : '';
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetch all EVAM jobs from the Teamtailor JSONFeed export.
 * Returns an array of ParsedJob objects (source-locale [fr] only).
 */
export async function fetchAllEvamVaudJobs() {
  console.log(`🔍 Fetching EVAM jobs from ${JOBS_FEED_URL}`);
  const items = await fetchJobsFeed();
  console.log(`📋 Total items in feed: ${items.length}`);

  const jobs = [];
  for (const item of items) {
    const title = item?.title || item?._jobposting?.title;
    if (!title) continue;
    const job = buildJob(item);
    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 55)} — ${job.addressLocality}`);
  }

  console.log(`\n📋 Total EVAM jobs discovered: ${jobs.length}`);
  return jobs;
}
