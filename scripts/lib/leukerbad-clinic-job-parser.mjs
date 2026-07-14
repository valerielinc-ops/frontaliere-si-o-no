#!/usr/bin/env node
/**
 * Leukerbad Clinic (RZL Rehabilitationszentrum Leukerbad AG) — Nuxt + Prismic CMS.
 *
 * Public career site:   https://leukerbadclinic.ch/de/page/jobs/
 * Prismic repository:   leukerbad-clinic.cdn.prismic.io
 * Prismic REST API:     https://leukerbad-clinic.cdn.prismic.io/api/v2
 *
 * The career page is a Nuxt SSG export pulling content from Prismic. Rather
 * than render Nuxt with Playwright we go straight to the Prismic public REST
 * API (no auth, no challenge) and query documents of type `job`.
 *
 * Pipeline:
 *   1. GET /api/v2                 → master ref
 *   2. GET /api/v2/documents/search?ref=<master>&q=[[at(document.type,"job")]]&lang=*&pageSize=100
 *      → all job documents, both fr-ch and de-ch.
 *   3. For each Prismic document, flatten the rich-text job_description blocks
 *      into a plain-text body and build a ParsedJob.
 *
 * Notes:
 *   - Master locale is `fr-ch`, secondary is `de-ch` (per /api/v2).
 *   - VS canton (Leukerbad is in Wallis); default postal code 3954.
 *   - We tag every job needsRetranslation: true so the translate-pending
 *     pipeline runs the AI localizer on first sight.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LEUKERBAD_CLINIC_KEY = 'leukerbad-clinic';
export const LEUKERBAD_CLINIC_COMPANY_NAME = 'Leukerbad Clinic';
export const LEUKERBAD_CLINIC_COMPANY_DOMAIN = 'leukerbadclinic.ch';

const PRISMIC_REPO = 'leukerbad-clinic';
const PRISMIC_API_BASE = `https://${PRISMIC_REPO}.cdn.prismic.io/api/v2`;
const PUBLIC_CAREER_URL = 'https://leukerbadclinic.ch/de/page/jobs/';

const DEFAULT_UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/2.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

async function fetchJsonRetry(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25_000;
  const maxAttempts = opts.maxAttempts || 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastErr;
}

/**
 * Flatten Prismic rich-text array into a single text blob.
 *
 * Prismic rich-text is an array of blocks, each with type+text. We preserve
 * structure by emitting newlines between blocks and a "• " prefix for
 * list-items, then run the result through the standard stripHtml/normalize
 * downstream.
 */
function richTextToText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  const lines = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const text = String(block.text || '').trim();
    if (!text) continue;
    if (block.type === 'list-item' || block.type === 'o-list-item') {
      lines.push(`• ${text}`);
    } else if (/^heading/.test(block.type || '')) {
      lines.push(`\n${text}\n`);
    } else {
      lines.push(text);
    }
  }
  return lines.join('\n');
}

function richTextToPlainTitle(blocks) {
  if (!Array.isArray(blocks)) return '';
  for (const block of blocks) {
    const text = normalizeSpace(String(block?.text || ''));
    if (text) return text;
  }
  return '';
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(arzt|ärzt|m[eé]decin|chefarzt|oberarzt|assistent.?arzt|cheffe?\s+de\s+clinique)\b/.test(t))
    return 'healthcare-medical';
  if (/\b(pflege|infirm|soins|assc|krankenpfleg|fachfrau\s+gesundheit|fage)\b/.test(t))
    return 'healthcare-nursing';
  if (/\b(physio|ergo|therap|logop|kinetik)\b/.test(t)) return 'healthcare-therapy';
  if (/\b(psycholog)\b/.test(t)) return 'healthcare-psychology';
  if (/\b(pharma|apothek)\b/.test(t)) return 'pharma';
  if (/\b(administrat|verwaltung|secret|sekret)\b/.test(t)) return 'administration';
  if (/\b(reinig|nettoy|cleaning|housekeep|hauswirt|economat|economes?)\b/.test(t)) return 'hospitality';
  if (/\b(cuisin|k[uü]che|chef\s+de\s+rang|service|h[oô]tel|restaur)\b/.test(t)) return 'hospitality';
  if (/\b(technique|technik|haustechn|elektri|sanit[aä]r|maintenance)\b/.test(t)) return 'logistics';
  if (/\b(informatique|informatik|it[-\s]|systeme|reseau|réseau)\b/.test(t)) return 'technology';
  return 'healthcare';
}

function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(stage|stagiair|praktik|intern|apprenti|lehre|trainee)\b/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(chef|chefarzt|leiter|directeur|directrice|responsable|head|senior|sr)\b/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '', timePct = '') {
  const t = String(title || '').toLowerCase();
  const pct = String(timePct || '').toLowerCase();
  if (/\b(stage|stagiair|praktik|intern)\b/.test(t)) return 'INTERN';
  if (/\b(temporaire|temporary|befristet|cdd|fixed.?term)\b/.test(t)) return 'CONTRACTOR';
  // 100% only → FULL_TIME; explicit part-time band → PART_TIME; otherwise OTHER.
  if (/^|^\s*100\s*%\s*$/.test(pct) && pct.trim() === '100%') return 'FULL_TIME';
  if (/^\s*\d+\s*%\s*$/.test(pct)) {
    const n = parseInt(pct, 10);
    if (n === 100) return 'FULL_TIME';
    if (n > 0 && n < 100) return 'PART_TIME';
  }
  return 'OTHER';
}

/* ── Job identity / trust ──────────────────────────────────── */

export function isLeukerbadClinicJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === LEUKERBAD_CLINIC_KEY ||
    company.includes('leukerbad clinic') ||
    company.includes('rehabilitationszentrum leukerbad') ||
    url.includes('leukerbadclinic.ch') ||
    url.includes('leukerbad-clinic.prismic.io') ||
    url.includes('leukerbad-clinic.cdn.prismic.io')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'leukerbadclinic.ch' ||
      host.endsWith('.leukerbadclinic.ch') ||
      host === 'leukerbad-clinic.cdn.prismic.io' ||
      host === 'leukerbad-clinic.prismic.io'
    );
  } catch {
    return false;
  }
}

/* ── Build ParsedJob from Prismic document ─────────────────── */

function buildJob(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const data = doc.data || {};

  const title =
    richTextToPlainTitle(data.job_title) ||
    normalizeSpace(data.page_title || '') ||
    normalizeSpace(doc.uid || '');
  if (!title || title.length < 3) return null;

  const workplace = normalizeSpace(data.workplace || '') || 'Leukerbad';
  const timePct = normalizeSpace(data.time_percentage || '');
  const startingDate = normalizeSpace(data.starting_date || '');
  const supTitle = normalizeSpace(richTextToPlainTitle(data.sup_title) || '');

  const descriptionRaw = richTextToText(data.job_description);
  const descriptionParts = [];
  if (supTitle) descriptionParts.push(supTitle);
  if (timePct || startingDate) {
    const meta = [];
    if (timePct) meta.push(timePct);
    if (startingDate) meta.push(startingDate);
    descriptionParts.push(meta.join(' · '));
  }
  if (descriptionRaw) descriptionParts.push(descriptionRaw);

  const description = stripHtml(descriptionParts.filter(Boolean).join('\n\n')) ||
    `${title} — ${LEUKERBAD_CLINIC_COMPANY_NAME}`;

  // Prismic lang format is 'fr-ch' / 'de-ch' — strip region.
  const langRaw = String(doc.lang || '').toLowerCase();
  const langPrefix = langRaw.split('-')[0] || '';
  const sourceLang =
    langPrefix === 'de' || langPrefix === 'fr' || langPrefix === 'it' || langPrefix === 'en'
      ? langPrefix
      : detectLang(description || title, 'fr');

  // Build canonical URL. Leukerbad's Nuxt/Prismic site renders individual
  // job documents only inside the listing page; /{lang}/page/jobs/{uid}/
  // returns 404. Keep the source URL on the live language-specific listing so
  // URL housekeeping does not expire valid Prismic jobs.
  //
  // Every job on a given language listing therefore shares the SAME path
  // (…/fr/page/jobs/ or …/de/page/jobs/). Without a per-job discriminator the
  // shared crawler's URL-based fingerprint (canonicalizeJobUrl strips the hash,
  // so a bare listing URL collapses to one key) folds all N jobs of a locale
  // onto ONE fingerprint in mergeAndDeduplicate — the whole slice shrinks to 2
  // (fr + de) and the shrink-guard hard-fails the crawler every run
  // (issues #4085 / #4169). Append a stable per-doc fragment: it never reaches
  // the server (the listing page still 200s, URL housekeeping still passes) and
  // extractJobIdentityFromUrl's bare-hash rule turns it into a distinct
  // `id|leukerbadclinic.ch|#job-<hash>` fingerprint — the exact same
  // fragment-as-identity convention the other single-listing-page crawlers use
  // (galenica #job.id=, eHnv #offer/, état de vaud #…/job/, klinik-gut #…-id-).
  const sitePath = sourceLang === 'de' ? 'de' : 'fr';
  const urlForHash = `${PRISMIC_REPO}:${doc.id || doc.uid || title}`;
  const urlHash = createHash('sha1').update(urlForHash).digest('hex').slice(0, 12);
  const publicUrl = `https://leukerbadclinic.ch/${sitePath}/page/jobs/#job-${urlHash}`;

  const jobSlug = slugify(`${title} ${LEUKERBAD_CLINIC_COMPANY_NAME} ${workplace}`);
  const postedDate = (() => {
    const candidates = [doc.last_publication_date, doc.first_publication_date];
    for (const c of candidates) {
      if (!c) continue;
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return new Date().toISOString().slice(0, 10);
  })();

  return {
    id: `${LEUKERBAD_CLINIC_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: LEUKERBAD_CLINIC_COMPANY_NAME,
    companyKey: LEUKERBAD_CLINIC_KEY,
    companyDomain: LEUKERBAD_CLINIC_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: workplace,
    canton: 'VS',
    addressLocality: workplace,
    addressRegion: 'VS',
    addressCountry: 'CH',
    country: 'CH',
    postalCode: '3954',
    category: detectCategory(title),
    sector: 'Salute / Riabilitazione',
    contract: 'full-time',
    employmentType: detectEmploymentType(title, timePct),
    experienceLevel: detectExperienceLevel(title),
    currency: 'CHF',
    featured: false,
    postedDate,
    url: publicUrl,
    applyUrl: publicUrl,
    source: 'Leukerbad Clinic Dedicated Parser (Prismic REST API)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    needsRetranslation: true,
  };
}

/* ── Main fetch function ───────────────────────────────────── */

/**
 * Fetch all Leukerbad Clinic jobs from the Prismic REST API.
 *
 * Returns ParsedJob[] with source-locale fields only (no other-locale slugs
 * or translations). Master locale is fr-ch; we also include de-ch.
 */
export async function fetchAllLeukerbadClinicJobs() {
  console.log(`🏥 Fetching Leukerbad Clinic jobs from Prismic`);
  console.log(`   Public career page: ${PUBLIC_CAREER_URL}`);
  console.log(`   Prismic API: ${PRISMIC_API_BASE}\n`);

  let masterRef = '';
  try {
    const apiInfo = await fetchJsonRetry(PRISMIC_API_BASE);
    masterRef =
      (apiInfo.refs || []).find((r) => r && r.isMasterRef)?.ref ||
      (apiInfo.refs || [])[0]?.ref ||
      '';
  } catch (err) {
    console.warn(`⚠️ Prismic /api/v2 unreachable: ${err?.message || err}`);
    return [];
  }
  if (!masterRef) {
    console.warn(`⚠️ Could not resolve Prismic master ref.`);
    return [];
  }
  console.log(`   Resolved master ref: ${masterRef}`);

  // Fetch all job docs in all langs. Prismic returns paginated results with
  // page/results_size/total_results_size; iterate until exhausted.
  const allDocs = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const q = encodeURIComponent('[[at(document.type, "job")]]');
    const url =
      `${PRISMIC_API_BASE}/documents/search?ref=${encodeURIComponent(masterRef)}` +
      `&q=${q}&lang=*&pageSize=${pageSize}&page=${page}`;
    let payload;
    try {
      payload = await fetchJsonRetry(url);
    } catch (err) {
      console.warn(`⚠️ Prismic search page ${page} failed: ${err?.message || err}`);
      break;
    }
    const results = assertJsonListShape(payload, { key: 'results', source: 'leukerbad-clinic', lang: `page ${page}` });
    allDocs.push(...results);
    const totalPages = Number(payload?.total_pages || 1);
    console.log(`   📄 Page ${page}/${totalPages}: ${results.length} job docs`);
    if (page >= totalPages || results.length === 0) break;
    page += 1;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n   Prismic returned ${allDocs.length} job document(s) across all locales`);

  const jobs = [];
  for (const doc of allDocs) {
    try {
      const job = buildJob(doc);
      if (job) jobs.push(job);
    } catch (err) {
      console.warn(`   ⚠️ Skipping doc ${doc?.id || doc?.uid}: ${err?.message || err}`);
    }
  }

  // Deduplicate by id (one Prismic doc per (uid, lang) combination, so id is
  // already unique — but the urlHash collapses by `id || uid || title`).
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    deduped.push(job);
  }

  console.log(`\n📋 Total unique Leukerbad Clinic jobs: ${deduped.length}`);
  return deduped;
}
