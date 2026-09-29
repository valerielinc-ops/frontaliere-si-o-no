#!/usr/bin/env node
/**
 * Spitex Schweiz job parser — federation-level home care job board.
 *
 * Public career site: https://www.spitexjobs.ch/
 *
 * Spitex Schweiz is the Swiss federation of non-profit Spitex (home care)
 * organizations. `spitexjobs.ch` is their consolidated job board, listing
 * positions from all member organizations (community Spitex services across
 * all 26 cantons).
 *
 * Crawl strategy:
 *
 *   1. GET https://www.spitexjobs.ch/suche/page/{N} — paginated server-
 *      rendered HTML, ~23-24 jobs per page. Each card has
 *      `data-url="https://www.spitexjobs.ch/job/{slug}/J{jobId}"`. The first
 *      few pages may include sticky/featured jobs that repeat across pages —
 *      we dedupe by jobId.
 *
 *      The page also exposes the total count via `data-total="{N}"` on the
 *      pagination wrapper — we use it as a stop condition.
 *
 *   2. For each unique job URL, GET the detail page. Each detail page contains
 *      a clean `<script type="application/ld+json">` JobPosting block with
 *      `title`, `description` (HTML), `jobLocation.address`, `datePosted`,
 *      `validThrough`, `employmentType`, `hiringOrganization`, `industry`,
 *      `educationRequirements`. The hiringOrganization.name is the actual
 *      Spitex org (e.g. "Spitex Aare") — we capture it but bucket all jobs
 *      under the federation slug `spitex-ch` because they share the same
 *      published-by entity.
 *
 * All parsed jobs ship with `needsRetranslation: true` so the shared AI
 * localization step fills the remaining 3 locales.
 *
 * Implements the 4 exports required by the standard crawler template.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const SPITEX_CH_KEY = 'spitex-ch';
export const SPITEX_CH_COMPANY_NAME = 'Spitex Schweiz';
export const SPITEX_CH_COMPANY_DOMAIN = 'spitexjobs.ch';
const BASE_URL = 'https://www.spitexjobs.ch';
const DETAIL_DELAY_MS = 200;
const MAX_LISTING_PAGES = 30;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/* ── Listing pages ────────────────────────────────────────── */

export function parseSpitexListing(html = '') {
  if (!html) return { urls: [], total: 0 };
  const urls = new Set();
  const urlRe = /data-url=["'](https?:\/\/www\.spitexjobs\.ch\/job\/[^"']+\/J(\d+))["']/gi;
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    urls.add(m[1]);
  }
  let total = 0;
  const totalMatch = html.match(/data-total=["'](\d+)["']/i);
  if (totalMatch) total = parseInt(totalMatch[1], 10);
  return { urls: Array.from(urls), total };
}

/* ── Detail page parser ───────────────────────────────────── */

export function extractJobPostingJsonLd(html = '') {
  if (!html) return null;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && (obj['@type'] === 'JobPosting' || (Array.isArray(obj) && obj.find((o) => o && o['@type'] === 'JobPosting')))) {
        return Array.isArray(obj) ? obj.find((o) => o && o['@type'] === 'JobPosting') : obj;
      }
    } catch {
      // try next
    }
  }
  return null;
}

const COUNTRY_TO_CC = { Schweiz: 'CH', Switzerland: 'CH', Suisse: 'CH', Svizzera: 'CH' };

/* ── Factory-style exports ────────────────────────────────── */

function sectionByClass(html, cls) {
  const match = new RegExp(`<section\\b[^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</section>`, 'i').exec(html);
  return match ? match[1] : '';
}

function pillLabel(sectionHtml) {
  return normalizeSpace(stripHtml(/<h2\b[^>]*wwj-pill-label[^>]*>([\s\S]*?)<\/h2>/i.exec(sectionHtml)?.[1] || ''));
}

/**
 * The employer sections of a spitexjobs.ch vacancy page that belong to the ad
 * but not to its JobPosting JSON-LD: the organisation portrait
 * (`wwj-profile-bidder-description`) and the benefit cards
 * (`wwj-benefits-section`, one `<article>` per benefit: heading + text), each
 * under the label the page gives it ("Porträt", "Benefits").
 *
 * The JSON-LD `description` carries the intro and the role lists only, so
 * the published ad lost the offer — holidays, allowances, paid travel time,
 * car, training budget — and the organisation paragraph (J990528: 1,518
 * published characters against a 4,889-character ad, 2026-09-29). Contact
 * details, map, media and metadata stay out.
 *
 * @param {string} html
 * @returns {string} HTML, '' when the page has neither section
 */
export function extractSpitexEmployerSectionsHtml(html = '') {
  // Icons first: each benefit card's inline `<svg>` draws with `<line>`
  // elements, which the `<li…>` → bullet rule of the text converters reads as
  // list items ("• • • Fixe Dienste …").
  const source = String(html || '').replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
  const parts = [];
  const profile = sectionByClass(source, 'wwj-profile-bidder-section');
  const portrait = /<div\b[^>]*class="[^"]*wwj-profile-bidder-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(profile)?.[1] || '';
  const portraitText = normalizeSpace(stripHtml(portrait));
  if (portraitText) {
    parts.push(`<h3>${pillLabel(profile) || 'Porträt'}</h3><p>${portraitText}</p>`);
  }
  const benefitsSection = sectionByClass(source, 'wwj-benefits-section');
  const items = [];
  for (const card of benefitsSection.matchAll(/<article\b[^>]*class="[^"]*wwj-benefit\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi)) {
    const heading = normalizeSpace(stripHtml(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(card[1])?.[1] || ''));
    const text = normalizeSpace(stripHtml(card[1].replace(/<h3\b[^>]*>[\s\S]*?<\/h3>/i, '')));
    if (heading || text) items.push(`<li>${[heading, text].filter(Boolean).join(': ')}</li>`);
  }
  if (items.length) {
    parts.push(`<h3>${pillLabel(benefitsSection) || 'Benefits'}</h3><ul>${items.join('')}</ul>`);
  }
  return parts.join('\n');
}

export async function fetchAllSpitexChJobs() {
  console.log(`🏥 Fetching ${SPITEX_CH_COMPANY_NAME} jobs`);
  console.log(`   Source: ${BASE_URL}/suche (federation home-care board)\n`);

  // Step 1 — walk paginated listing
  const seenUrls = new Set();
  let total = 0;
  for (let page = 1; page <= MAX_LISTING_PAGES; page += 1) {
    const url = `${BASE_URL}/suche/page/${page}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      if (page === 1) throw err;
      console.warn(`  ⚠️ Pagination failed at page=${page}: ${err?.message || err}`);
      break;
    }
    const { urls, total: t } = parseSpitexListing(html);
    if (t > total) total = t;
    let added = 0;
    for (const u of urls) {
      if (seenUrls.has(u)) continue;
      seenUrls.add(u);
      added += 1;
    }
    console.log(`  📄 page=${page}: +${added} (unique: ${seenUrls.size}${total ? `/${total}` : ''})`);
    if (added === 0 && page >= 2) break; // no new jobs → end of pagination
    if (total > 0 && seenUrls.size >= total) break;
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }

  if (!seenUrls.size) {
    console.warn('⚠️ No Spitex job URLs found');
    return [];
  }
  console.log(`  📋 Total unique job URLs: ${seenUrls.size}\n`);

  // Step 2 — fetch detail pages
  const jobs = [];
  for (const jobUrl of seenUrls) {
    let posting = null;
    let employerHtml = '';
    try {
      const detailHtml = await fetchHtml(jobUrl);
      posting = extractJobPostingJsonLd(detailHtml);
      employerHtml = extractSpitexEmployerSectionsHtml(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${jobUrl}: ${err?.message || err}`);
    }
    if (!posting) continue;

    const title = decodeEntities(posting.title || '').trim();
    if (!title) continue;

    const addr = posting.jobLocation?.address || {};
    const city = decodeEntities(addr.addressLocality || '').trim() || 'Bern';
    const postalCode = String(addr.postalCode || '').trim() || '3000';
    const cantonGuess = String(addr.addressRegion || '').toUpperCase().trim();
    // Validate against the real canton registry — a well-formed-but-wrong
    // 2-letter code must not be trusted verbatim (AGENTS.md #6 sibling class
    // shared with ghol/holcim/stadler-rail/breitling).
    const canton = normalizeCantonCode(cantonGuess) || inferSwissTargetCanton(city) || 'BE';
    const country = COUNTRY_TO_CC[addr.addressCountry] || 'CH';

    const descHtml = posting.description || '';
    // The posting's own text, whatever its length, with the employer's
    // sections of the same ad. Under 30 distinct words the parser used to
    // replace it with "<Titel> bei <Arbeitgeber> in <Ort>. Spitex-Stelle in der
    // Schweizer Hauspflege…" (SPITEX_CH_FABRICATED_DESCRIPTION_RE); a posting
    // without text now gets no description and takes the thin-source path.
    let description = htmlToText(descHtml);
    const hiringOrg = posting.hiringOrganization?.name
      ? decodeEntities(String(posting.hiringOrganization.name)).trim()
      : '';
    if (description.trim() && employerHtml) {
      description = htmlToText(`${descHtml}\n${employerHtml}`);
    }

    const sourceLang = detectLang(description || title, 'de');
    const postedDate = (() => {
      const raw = posting.datePosted || '';
      if (!raw) return new Date().toISOString().slice(0, 10);
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
    })();
    const validThrough = (() => {
      const raw = posting.validThrough || '';
      if (!raw) return '';
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    })();
    const employmentTypeRaw = String(posting.employmentType || '').toUpperCase();
    const employmentType = employmentTypeRaw === 'PART_TIME' || /\b(20|30|40|50|60|70|80)\s?%/.test(title)
      ? 'PART_TIME'
      : (employmentTypeRaw === 'FULL_TIME' ? 'FULL_TIME' : detectHealthcareEmploymentType(title));

    const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${SPITEX_CH_KEY} ${city}`);

    const job = {
      id: `${SPITEX_CH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: hiringOrg || SPITEX_CH_COMPANY_NAME,
      companyKey: SPITEX_CH_KEY,
      companyDomain: SPITEX_CH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: 'Spitex Schweiz Dedicated Parser (spitexjobs.ch federation board)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: country,
      country,
      postalCode,
      category: detectHealthcareCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      ...(validThrough ? { validThrough } : {}),
      applyUrl: jobUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };
    jobs.push(job);

    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }

  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const k = job.url.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(job);
  }
  console.log(`\n📋 Total unique ${SPITEX_CH_COMPANY_NAME} jobs: ${deduped.length}`);
  return deduped;
}

export function isSpitexChJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  if (key === SPITEX_CH_KEY) return true;
  if (url.includes('spitexjobs.ch')) return true;
  if (company.startsWith('spitex ')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'spitexjobs.ch'
      || host === 'www.spitexjobs.ch'
      || host === 'api.spitexjobs.ch'
      || host.endsWith('.spitexjobs.ch');
  } catch {
    return false;
  }
}

/** Fragment only the parser's former substitute description wrote. */
export const SPITEX_CH_FABRICATED_DESCRIPTION_RE =
  /Spitex-Stelle in der Schweizer Hauspflege\. Diese Position bietet ein modernes Arbeitsumfeld/;
