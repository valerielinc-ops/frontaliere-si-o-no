#!/usr/bin/env node
/**
 * Spital STS AG (Thun-Simmental) job parser — SSR career page + job-detail HTML.
 *
 * The Prospective.ch `/medium/1000717/jobs` listing endpoint started returning
 * HTTP 400 in May 2026 (schema rotation). The public career site at
 *   https://jobs.spitalstsag.ch/
 * is still alive and contains all 10–15 active jobs SSR'd inside
 * `<div class="job job-N">` blocks. Each block carries:
 *
 *   <a id="job-{numericId}"
 *      data-href="https://ohws.prospective.ch/public/v1/redirect/{viewkey}/ats/"
 *      data-location="Thun"
 *      data-workload="80-100%"
 *      href="https://jobs.spitalstsag.ch/offene-stellen/{slug}/{viewkey}"
 *      title="...">
 *     <h3 class="title">...</h3>
 *     <span class="workplace bold">...</span>
 *     <span class="workload bold">...</span>
 *     <span class="description">...teaser...</span>
 *
 * The canonical detail page at `jobs.spitalstsag.ch/offene-stellen/{slug}/{viewkey}`
 * SSRs the full job description in `<section id="introduction">` + `<section id="tasks">`
 * + `<section id="skills">` (Prospective Aequivital ATS shell). We scrape those
 * sections to build a rich `description`.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalStsJobs()  — Fetch and parse all jobs across pages
 *   - isSpitalStsJob()         — Match jobs belonging to STS
 *   - isTrustedDomain()        — Validate URLs belong to STS / Prospective tenant
 *   - SPITAL_STS_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalize,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_STS_KEY = 'spital-sts';
export const SPITAL_STS_COMPANY_NAME = 'Spital STS';
export const SPITAL_STS_COMPANY_DOMAIN = 'spitalstsag.ch';

const PROSPECTIVE_TENANT = '1000717';
const CAREER_LIST_URL = 'https://jobs.spitalstsag.ch/';
const PUBLIC_CAREER_URL = 'https://www.spitalthun.ch/stellenmarkt';
const DETAIL_DELAY_MS = 250;

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Spital STS AG (Thun-Simmental).
 */
export function isSpitalStsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_STS_KEY ||
    key.startsWith('spital-sts') ||
    company.includes('spital sts') ||
    company.includes('spital thun') ||
    url.includes('spitalstsag.ch') ||
    url.includes('spitalthun.ch') ||
    url.includes(`/${PROSPECTIVE_TENANT}/`) ||
    url.includes('ohws.prospective.ch')
  );
}

/**
 * Validate that a URL belongs to Spital STS AG or the Prospective ATS host.
 *
 * We accept any path on `ohws.prospective.ch` because the parser now uses the
 * Prospective `redirect/{viewkey}/ats/` URL as the canonical job URL, and the
 * tenant scope is no longer encoded in that path (it lives in the viewkey).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'spitalstsag.ch' || host.endsWith('.spitalstsag.ch')) return true;
    if (host === 'spitalthun.ch' || host.endsWith('.spitalthun.ch')) return true;
    if (host === 'jobs.spitalstsag.ch') return true;
    if (host === 'ohws.prospective.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── HTML extractors ───────────────────────────────────────── */

/**
 * Parse the SSR career list page (`https://jobs.spitalstsag.ch/`) and return
 * one row per `<div class="job job-N">` block.
 *
 * The list block also includes a teaser description; we keep it as a fallback
 * in case the detail-page fetch fails.
 */
export function parseJobListHtml(html = '') {
  const out = [];
  const seen = new Set();
  // Match each `<div class="job job-N">` block up to its closing tag.
  // The greedy version would slurp the entire trailing `<div class="job-favorit">`;
  // we anchor on the inner `</a>` instead and stop there.
  const blockRe = /<div\s+class="job\s+job-\d+">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const block = m[1];
    const anchorTagMatch = block.match(/<a\b[^>]*>/);
    if (!anchorTagMatch) continue;
    const tag = anchorTagMatch[0];

    const dataHref = (tag.match(/\sdata-href="([^"]+)"/) || [])[1] || '';
    const href = (tag.match(/\shref="([^"]+)"/) || [])[1] || '';
    const dataLocation = (tag.match(/\sdata-location="([^"]+)"/) || [])[1] || '';
    const dataWorkload = (tag.match(/\sdata-workload="([^"]+)"/) || [])[1] || '';
    const titleAttr = (tag.match(/\stitle="([^"]+)"/) || [])[1] || '';
    const numericId = (tag.match(/\sid="job-(\d+)"/) || [])[1] || '';

    // Extract viewkey from the redirect URL (`/redirect/{viewkey}/ats/`) or
    // fall back to the canonical detail URL (`/offene-stellen/{slug}/{viewkey}`).
    let viewkey = '';
    const vkRedirect = dataHref.match(/\/redirect\/([a-f0-9-]{36})\//i);
    if (vkRedirect) viewkey = vkRedirect[1];
    if (!viewkey && href) {
      const vkDetail = href.match(/\/([a-f0-9-]{36})(?:[/?#]|$)/i);
      if (vkDetail) viewkey = vkDetail[1];
    }
    if (!viewkey) continue;
    if (seen.has(viewkey)) continue;
    seen.add(viewkey);

    const titleH3 = (block.match(/<h3[^>]*class="title"[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '';
    const title = normalizeSpace(decodeEntities(titleH3 || titleAttr));
    if (!title || title.length < 3) continue;

    const teaserMatch = block.match(/<span[^>]*class="description"[^>]*>([\s\S]*?)<\/span>/i);
    const teaser = teaserMatch ? normalizeSpace(decodeEntities(teaserMatch[1])) : '';

    out.push({
      viewkey,
      numericId,
      dataHref: dataHref || `https://ohws.prospective.ch/public/v1/redirect/${viewkey}/ats/`,
      detailHref: href,
      title,
      location: normalizeSpace(decodeEntities(dataLocation)) || 'Thun',
      workload: normalizeSpace(decodeEntities(dataWorkload)),
      teaser,
    });
  }
  return out;
}

/**
 * Scrape the SSR detail page and build a clean German-text description by
 * concatenating the Prospective `<section id="introduction|tasks|skills">`
 * blocks. Falls back to the listing teaser if the detail fetch returns
 * something unusable.
 */
function extractSection(html, id) {
  const re = new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/section>`, 'i');
  const m = html.match(re);
  if (!m) return '';
  return htmlToText(m[1]);
}

async function fetchDetailDescription(detailUrl, fallbackTeaser) {
  if (!detailUrl) return fallbackTeaser || '';
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return fallbackTeaser || '';

    const parts = [];
    const intro = normalizeSpace(extractSection(html, 'introduction'));
    if (intro) parts.push(intro);

    // The Prospective shell uses `<div class="title"><H2>...</H2></div>` then
    // `<div class="content">...</div>` inside each accordion section. We grab
    // the section verbatim and let `htmlToText` flatten it.
    const tasks = normalizeSpace(extractSection(html, 'tasks'));
    if (tasks) parts.push(tasks);

    const skills = normalizeSpace(extractSection(html, 'skills'));
    if (skills) parts.push(skills);

    const text = parts.filter(Boolean).join('\n\n').trim();
    if (text && text.split(/\s+/).length >= 30) return text.slice(0, 6000);

    // Detail page returned but sections were empty / too short — combine
    // whatever we got with the listing teaser so the description is never
    // worse than the row teaser alone.
    return [fallbackTeaser, text].filter(Boolean).join('\n\n').trim();
  } catch (err) {
    console.warn(`  ⚠️ STS detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return fallbackTeaser || '';
  }
}

/* ── Misc helpers ──────────────────────────────────────────── */

function pickPostalCode(city) {
  const c = normalize(city);
  if (c.includes('zweisimmen')) return '3770';
  if (c.includes('steffisburg')) return '3612';
  if (c.includes('saanen')) return '3792';
  if (c.includes('frutigen')) return '3714';
  return '3600'; // Thun default
}

function parsePostedDate() {
  return new Date().toISOString().slice(0, 10);
}

/* ── Main entry ────────────────────────────────────────────── */

/**
 * Fetch all Spital STS AG jobs by scraping the SSR career page and (best
 * effort) hydrating each row with the matching detail-page description.
 *
 * Returns an array of ParsedJob objects (source-locale = de). Graceful
 * degradation: if the list fetch fails we return [] instead of throwing,
 * matching the contract that every dedicated crawler asserts.
 */
export async function fetchAllSpitalStsJobs() {
  console.log(`🏥 Fetching ${SPITAL_STS_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_LIST_URL} (SSR career list + per-job detail HTML)`);
  console.log(`   Public: ${PUBLIC_CAREER_URL} (iframe → ${CAREER_LIST_URL})\n`);

  let listHtml = '';
  try {
    listHtml = await fetchHtml(CAREER_LIST_URL);
  } catch (err) {
    console.warn(`  ⚠️ STS career list fetch failed: ${err?.message || err}. Returning [].`);
    return [];
  }

  const rows = parseJobListHtml(listHtml);
  console.log(`  ✓ Parsed ${rows.length} job rows from career list HTML`);
  if (!rows.length) return [];

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));

    const description = await fetchDetailDescription(r.detailHref, r.teaser);
    const fallback = `${r.title} — ${SPITAL_STS_COMPANY_NAME}, ${r.location}${r.workload ? ` (${r.workload})` : ''}.`;
    const safeDescription = description && description.split(/\s+/).length >= 30
      ? description
      : [fallback, description].filter(Boolean).join('\n\n');

    const canton = inferSwissTargetCanton(r.location) || 'BE';
    const sourceLang = detectLang(safeDescription || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${SPITAL_STS_KEY} ${r.location}`);

    // The canonical job URL is the Prospective `redirect/{viewkey}/ats/`
    // endpoint (302s to the active applicant flow). We keep this rather than
    // the `jobs.spitalstsag.ch/offene-stellen/...` slug-URL so the link
    // survives slug renames (which Prospective triggers on title edits).
    const url = r.dataHref;
    const applyUrl = `https://jobs.spitalstsag.ch/apply/ats/${r.viewkey}`;
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

    // Employment type: prefer the workload pill (e.g. "80-100%"), fall back to
    // a heuristic over title+description.
    const employmentType = detectHealthcareEmploymentType(r.workload || `${r.title} ${safeDescription}`);

    jobs.push({
      id: `${SPITAL_STS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_STS_COMPANY_NAME,
      companyKey: SPITAL_STS_KEY,
      companyDomain: SPITAL_STS_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: r.location,
      canton,
      url,
      source: 'Spital STS Dedicated Parser (SSR + job-direct)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: r.location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: pickPostalCode(r.location),
      category: detectHealthcareCategory(r.title),
      contract: 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: parsePostedDate(),
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${SPITAL_STS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { CAREER_LIST_URL, PUBLIC_CAREER_URL, PROSPECTIVE_TENANT };
