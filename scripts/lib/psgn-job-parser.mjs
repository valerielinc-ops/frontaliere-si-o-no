#!/usr/bin/env node
/**
 * Psychiatrie St.Gallen (PSGN) job parser — Prospective.ch careercenter HTML scrape
 * + JSON-LD JobPosting from detail pages.
 *
 * The PSGN Prospective tenant (medium 1005765) exposes the public careercenter
 * SSR endpoint at:
 *
 *   https://ohws.prospective.ch/public/v1/careercenter/1005765/?lang=de
 *
 * The `/medium/1005765/jobs` JSON endpoint (used by `prospective-ch-job-parser-common.mjs`)
 * returns HTTP 400 (deprecated schema, same failure mode as Spital STS — see
 * lesson L6 in docs/plans/crawlers-batch-16-and-followup.md). The careercenter
 * HTML lists ~10 active jobs with stable links to custom job pages on
 * `jobs.psychiatrie-sg.ch/karriere/offene-stellen/{slug}/{viewkey}`.
 *
 * Each detail page embeds a JSON-LD JobPosting object with `responsibilities`
 * + `qualifications` HTML and `validThrough`, which we use to build a rich
 * description.
 *
 * Pattern mirrors `scripts/lib/spital-sts-job-parser.mjs` (the Bern equivalent
 * that survived the same Prospective 400 outage by scraping HTML directly).
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

export const PSGN_KEY = 'psgn';
export const PSGN_COMPANY_NAME = 'Psychiatrie St.Gallen';
export const PSGN_COMPANY_DOMAIN = 'psychiatrie-sg.ch';

const PROSPECTIVE_TENANT = '1005765';
const CAREER_LIST_URL = `https://ohws.prospective.ch/public/v1/careercenter/${PROSPECTIVE_TENANT}/?lang=de`;
const PUBLIC_CAREER_URL = 'https://www.psychiatrie-sg.ch/karriere-jobs';
const DETAIL_DELAY_MS = 250;

/* ── Company matchers ──────────────────────────────────────── */

export function isPsgnJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === PSGN_KEY ||
    company.includes('psychiatrie st.gallen') ||
    company.includes('psychiatrie st gallen') ||
    company.includes('psychiatrie sg') ||
    url.includes('jobs.psychiatrie-sg.ch') ||
    url.includes('psychiatrie-sg.ch') ||
    url.includes(`/${PROSPECTIVE_TENANT}/`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'psychiatrie-sg.ch' || host.endsWith('.psychiatrie-sg.ch')) return true;
    if (host === 'jobs.psychiatrie-sg.ch') return true;
    if (host === 'ohws.prospective.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── HTML extractors ───────────────────────────────────────── */

/**
 * Parse the careercenter SSR listing into one row per `<a class="job">` block.
 * The Prospective careercenter shell looks like:
 *
 *   <a class="job" href="https://jobs.psychiatrie-sg.ch/karriere/offene-stellen/{slug}/{viewkey}">
 *     <div class="jobTitle">
 *       <span>{Department}</span>
 *       <h2>{Title}</h2>
 *       <span>{Subdepartment}</span>
 *     </div>
 *     <div class="jobArbeitsOrt">… {City}</div>
 *   </a>
 */
export function parseJobListHtml(html = '') {
  const out = [];
  const seen = new Set();
  // Match each `<a class="job" href="https://jobs.psychiatrie-sg.ch/karriere/offene-stellen/…">…</a>`
  const blockRe =
    /<a\s+[^>]*class="job"[^>]*href="(https:\/\/jobs\.psychiatrie-sg\.ch\/karriere\/offene-stellen\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const detailHref = m[1];
    const body = m[2];

    // Viewkey = trailing UUID segment in the URL.
    const vk = detailHref.match(/\/([a-f0-9-]{36})(?:[/?#]|$)/i);
    if (!vk) continue;
    const viewkey = vk[1];
    if (seen.has(viewkey)) continue;
    seen.add(viewkey);

    // Title is the h2 inside .jobTitle.
    const titleMatch = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = normalizeSpace(decodeEntities(titleMatch ? titleMatch[1] : ''));
    if (!title || title.length < 3) continue;

    // jobTitle spans → department + subdepartment.
    const spanMatches = [...body.matchAll(
      /<div[^>]*class="jobTitle"[^>]*>([\s\S]*?)<\/div>/gi,
    )];
    let department = '';
    if (spanMatches.length) {
      const inner = spanMatches[0][1];
      const spans = [...inner.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
        .map((sm) => normalizeSpace(decodeEntities(sm[1])))
        .filter(Boolean);
      department = spans.join(' / ');
    }

    // Location is the visible text inside .jobArbeitsOrt (after the inline SVG).
    const locMatch = body.match(/<div[^>]*class="jobArbeitsOrt"[^>]*>([\s\S]*?)<\/div>/i);
    let location = 'Wil SG';
    if (locMatch) {
      // Strip nested SVG + tags, keep last non-empty line.
      const txt = locMatch[1]
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      const cleaned = normalizeSpace(decodeEntities(txt));
      if (cleaned) location = cleaned;
    }

    out.push({
      viewkey,
      detailHref,
      title,
      department,
      location,
    });
  }
  return out;
}

/**
 * Extract the JobPosting JSON-LD block from a detail page and return its
 * `responsibilities` + `qualifications` (both HTML strings) flattened into
 * text. Falls back to the `<section id="introduction">` + `<section id="aufgabeProfil">`
 * Prospective accordions when JSON-LD is missing.
 */
function extractDetailDescription(html) {
  const parts = [];

  // Try JSON-LD first.
  for (const m of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = m[1].trim();
    if (!raw.includes('responsibilities') && !raw.includes('qualifications')) continue;
    try {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && (item.responsibilities || item.qualifications || item.description)) {
          const intro = normalizeSpace(htmlToText(String(item.description || '')));
          const resp = normalizeSpace(htmlToText(String(item.responsibilities || '')));
          const qual = normalizeSpace(htmlToText(String(item.qualifications || '')));
          if (intro) parts.push(intro);
          if (resp) parts.push(`Aufgaben:\n${resp}`);
          if (qual) parts.push(`Anforderungen:\n${qual}`);
          if (parts.length) return parts.join('\n\n');
        }
      }
    } catch {
      // Fall through to section scrape.
    }
  }

  // Fallback: HTML sections.
  for (const id of ['introduction', 'aufgabeProfil', 'benefits']) {
    const re = new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/section>`, 'i');
    const sm = html.match(re);
    if (sm) {
      const txt = normalizeSpace(htmlToText(sm[1]));
      if (txt) parts.push(txt);
    }
  }
  return parts.join('\n\n');
}

async function fetchDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return '';
    return extractDetailDescription(html);
  } catch (err) {
    console.warn(`  ⚠️ PSGN detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return '';
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

function pickPostalCode(city) {
  const c = normalize(city);
  if (c.includes('pfäfers') || c.includes('pfafers')) return '7312';
  if (c.includes('st.gallen') || c.includes('st gallen') || c.includes('sankt gallen')) return '9000';
  if (c.includes('rorschach')) return '9400';
  if (c.includes('walenstadt')) return '8880';
  return '9500'; // Wil SG default (PSGN HQ)
}

function pickCanton(city) {
  const inferred = inferSwissTargetCanton(city);
  return inferred || 'SG';
}

function parsePostedDate() {
  return new Date().toISOString().slice(0, 10);
}

/* ── Main entry ────────────────────────────────────────────── */

/**
 * Fetch all Psychiatrie St.Gallen jobs by scraping the Prospective careercenter
 * SSR endpoint and (best effort) hydrating each row with the detail-page
 * JobPosting JSON-LD.
 *
 * Returns an array of ParsedJob objects (source-locale = de). Graceful
 * degradation: if the list fetch fails we return [] instead of throwing.
 */
export async function fetchAllPsgnJobs() {
  console.log(`🏥 Fetching ${PSGN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_LIST_URL} (Prospective careercenter HTML)`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  let listHtml = '';
  try {
    listHtml = await fetchHtml(CAREER_LIST_URL);
  } catch (err) {
    console.warn(`  ⚠️ PSGN careercenter fetch failed: ${err?.message || err}. Returning [].`);
    return [];
  }

  const rows = parseJobListHtml(listHtml);
  console.log(`  ✓ Parsed ${rows.length} job rows from careercenter HTML`);
  if (!rows.length) return [];

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));

    const detailText = await fetchDetail(r.detailHref);
    const fallback = `${r.title} — ${PSGN_COMPANY_NAME}, ${r.location}${r.department ? ` (${r.department})` : ''}.`;
    const safeDescription = detailText && detailText.split(/\s+/).length >= 30
      ? detailText
      : [fallback, detailText].filter(Boolean).join('\n\n');

    const canton = pickCanton(r.location);
    const sourceLang = detectLang(safeDescription || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${PSGN_KEY} ${r.location}`);
    const url = r.detailHref;
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

    const employmentType = detectHealthcareEmploymentType(`${r.title} ${safeDescription}`);

    jobs.push({
      id: `${PSGN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PSGN_COMPANY_NAME,
      companyKey: PSGN_KEY,
      companyDomain: PSGN_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      needsRetranslation: true,
      location: r.location,
      canton,
      url,
      source: 'Psychiatrie St.Gallen Dedicated Parser (Prospective careercenter HTML)',
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
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${PSGN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { CAREER_LIST_URL, PUBLIC_CAREER_URL, PROSPECTIVE_TENANT };
