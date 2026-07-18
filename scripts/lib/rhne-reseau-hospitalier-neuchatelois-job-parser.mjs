#!/usr/bin/env node
/**
 * Réseau hospitalier neuchâtelois (RHNE) — Neuchâtel public hospital network.
 *
 * Public career listing (Liferay 7 CMS, server-rendered):
 *   https://www.rhne.ch/espace-emploi/emploi/postuler/tous-les-postes?cat=all
 *
 * The page server-renders an `<div id="jobs">` block containing all open
 * positions as `<a class="jobLink" href="?jobId=...">Title</a>` entries.
 *
 * CORRECTION (2026-07, issue #4293/#4063-item-5): a prior investigation
 * assumed the per-job detail modal ("rhne_web_jobup_RHNeWebJobupPortlet")
 * required a client-side session cookie and only returned the same empty
 * listing shell to anonymous requests — this was never actually verified
 * and turned out to be WRONG. A plain, cookie-less `fetch()` of the exact
 * same URL the "jobLink" anchors point to
 * (`.../tous-les-postes?jobId=NNNN&cat=all`) returns a FULLY server-rendered
 * detail page: the Liferay portlet renders the real job body
 * (`<div class="portlet-body">` → intro blurb, `<h1 class="titlepage">`,
 * "Lieu de travail : <postal> <city>", "Date de publication: DD.MM.YYYY",
 * a `Vos missions / Votre profil / Vos compétences` rich-text block, and an
 * outbound `https://www.jobup.ch/fr/application/create/<uuid>` apply link)
 * — confirmed live against 3 different jobIds, no cookies/JS required. No
 * Playwright/browser automation is needed; this is the same plain
 * listing+detail two-stage `fetchHtml()` pattern used by ~40 other hospital
 * crawlers in this codebase (see berner-klinik-montana-job-parser.mjs,
 * cds-savognin-job-parser.mjs, croix-rouge-fribourgeoise-job-parser.mjs).
 *
 * Detail fetch is best-effort per job: on failure (network hiccup, markup
 * drift) we fall back to a brand-blurb description rather than dropping the
 * listing — consistent with the boilerplate guard pattern used by the
 * SuccessFactors and Johdi Suite factories.
 *
 * As of July 2026 the listing exposes ~13 active openings.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  locateTagByAttribute,
  extractBalancedTagBlock,
  parseSwissShortDate,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const RHNE_KEY = 'rhne-reseau-hospitalier-neuchatelois';
export const RHNE_COMPANY_NAME = 'Réseau hospitalier neuchâtelois (RHNE)';
export const RHNE_COMPANY_DOMAIN = 'rhne.ch';

const LISTING_URL = 'https://www.rhne.ch/espace-emploi/emploi/postuler/tous-les-postes?cat=all';
const BASE_URL = 'https://www.rhne.ch';
const DEFAULT_CITY = 'Neuchâtel';
const DEFAULT_CANTON = 'NE';
const DEFAULT_POSTAL = '2000';

const SOURCE_LABEL = 'RHNE Réseau hospitalier neuchâtelois Dedicated Parser (Liferay HTML listing)';

const FALLBACK_BRAND_BLURB = `Le Réseau hospitalier neuchâtelois (RHNe) regroupe les sites de Pourtalès (Neuchâtel), La Chaux-de-Fonds, Val-de-Travers, Val-de-Ruz, Le Locle et La Chrysalide. Plus de 2'600 collaboratrices et collaborateurs assurent les soins aigus, la réadaptation et les soins palliatifs pour la population neuchâteloise.`;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

export function isRhneJob(job) {
  const key = normalize(job?.companyKey || '');
  const url = normalize(job?.url || '');
  return key === RHNE_KEY || url.includes('rhne.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === RHNE_COMPANY_DOMAIN || host.endsWith(`.${RHNE_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

/**
 * Parse the public RHNE listing page. Each opening is rendered as
 *   <a href="/espace-emploi/emploi/postuler/tous-les-postes?jobId=NNNN&cat=all"
 *      class="jobLink"> TITLE </a>
 * inside a `#jobs` container.
 */
export function parseRhneListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /<a[^>]*href="([^"]*jobId=(\d+)[^"]*)"[^>]*class="jobLink"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const relUrl = m[1].replace(/&amp;/g, '&');
    const jobId = m[2];
    const title = normalizeSpace(decodeEntities(m[3].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 3) continue;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    const fullUrl = relUrl.startsWith('http') ? relUrl : `${BASE_URL}${relUrl}`;
    out.push({ jobId, title, url: fullUrl });
  }
  return out;
}

// Minimum word count for a fetched detail body to stand on its own without
// the brand-blurb padding — mirrors the cds-savognin-job-parser.mjs pattern
// and stays well above the AGENTS.md thin-content floor (50 words).
const MIN_DETAIL_WORDS = 40;

/**
 * The "Lieu de travail" field is "<postal> <city>" (e.g. "2000 Neuchâtel",
 * "2400 Le Locle") for every RHNE site (all within canton NE). Split it;
 * fall back to the Pourtalès/Neuchâtel HQ default when absent/unparsable.
 */
function resolveRhneLocation(rawLocation = '') {
  const cleaned = normalizeSpace(decodeEntities(rawLocation));
  const m = cleaned.match(/^(\d{4})\s+(.+)$/);
  if (m) return { postalCode: m[1], city: normalizeSpace(m[2]) };
  return { postalCode: DEFAULT_POSTAL, city: cleaned || DEFAULT_CITY };
}

/**
 * Fetch + parse one job's detail page
 * (`.../tous-les-postes?jobId=NNNN&cat=all`, the same URL the listing
 * "jobLink" anchors point to). This is a PLAIN unauthenticated GET — no
 * session cookie needed (see file header for the verified correction of
 * the earlier session-cookie hypothesis). The Liferay portlet
 * ("rhne_web_jobup_RHNeWebJobupPortlet") server-renders the full job body
 * inside `<div class="portlet-body">`:
 *   [optional intro blurb, `style="font-weight: 500 !important"`]
 *   <h1 class="titlepage">TITLE</h1> ... <span>Lieu de travail : LOCATION</span>
 *   <p class="date">Date de publication: DD.MM.YYYY</p>
 *   <div style="text-align: justify">Vos missions / Votre profil / …</div>
 *   <button id="applyButton">…<a href="https://www.jobup.ch/...">Postuler</a></button>
 * Returns `null` on fetch failure or unrecognised markup — callers fall
 * back to the brand blurb.
 */
export async function fetchRhneJobDetail(detailUrl) {
  const html = await fetchHtml(detailUrl);

  // The page renders several other `class="portlet-body"` containers
  // (top nav, search bar, breadcrumb portlets) before the job-detail one —
  // scope the search to the jobup portlet's own `<section>` so we don't
  // accidentally grab an unrelated nav/search portlet's near-empty body.
  const scopeIdx = html.indexOf('id="portlet_rhne_web_jobup_RHNeWebJobupPortlet');
  if (scopeIdx === -1) return null;
  const scoped = html.slice(scopeIdx);

  const bodyLoc = locateTagByAttribute(scoped, 'class="portlet-body"');
  if (!bodyLoc) return null;
  const inner = extractBalancedTagBlock(bodyLoc.rest, bodyLoc.tagName);

  const titleMatch = inner.match(/<h1 class="titlepage">([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ''))) : '';

  const locationMatch = inner.match(/Lieu de travail\s*:\s*([^<]+)/i);
  const location = locationMatch ? normalizeSpace(decodeEntities(locationMatch[1])) : '';

  const dateMatch = inner.match(/Date de publication\s*:\s*([\d.]+)/i);
  const datePosted = dateMatch ? parseSwissShortDate(dateMatch[1]) : '';

  const applyMatch = inner.match(/id="applyButton"[\s\S]{0,300}?href="([^"]+)"/i);
  const applyUrl = applyMatch ? decodeEntities(applyMatch[1].replace(/&amp;/g, '&')) : '';

  let bodyText = '';
  const contentLoc = locateTagByAttribute(inner, 'style="text-align: justify"');
  if (contentLoc) {
    const contentInner = extractBalancedTagBlock(contentLoc.rest, contentLoc.tagName);
    bodyText = htmlToText(contentInner);
  }
  const introMatch = inner.match(/<div[^>]*style="font-weight: 500[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (introMatch) {
    const introText = htmlToText(introMatch[1]);
    bodyText = [introText, bodyText].filter(Boolean).join('\n\n');
  }

  if (!bodyText) return null;
  return { title, location, datePosted, applyUrl, body: bodyText };
}

export async function fetchAllRhneJobs() {
  console.log(`🏥 Fetching ${RHNE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Liferay HTML listing + per-job detail pages)\n`);

  let html;
  try {
    html = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const items = parseRhneListing(html);
  console.log(`  ✓ ${items.length} offerte trovate`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const it of items) {
    let detail = null;
    try {
      detail = await fetchRhneJobDetail(it.url);
      if (detail) detailHits += 1;
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for jobId=${it.jobId} (${err?.message || err}); using brand blurb fallback.`);
    }
    // Small politeness delay between per-job detail fetches.
    await new Promise((r) => setTimeout(r, 200));

    const title = detail?.title || it.title;
    const { postalCode, city } = resolveRhneLocation(detail?.location);
    const richWordCount = detail?.body ? detail.body.split(/\s+/).filter(Boolean).length : 0;
    const description = richWordCount >= MIN_DETAIL_WORDS
      ? `${detail.body}\n\n${FALLBACK_BRAND_BLURB}`
      : `${title} au ${RHNE_COMPANY_NAME} à ${city}.\n\n${FALLBACK_BRAND_BLURB}`;
    const sourceLang = detectLang(`${title} ${description}`, 'fr');
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${RHNE_KEY} ${city}`);
    const employmentType = detectHealthcareEmploymentType(`${title} ${description}`);

    jobs.push({
      id: `${RHNE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RHNE_COMPANY_NAME,
      companyKey: RHNE_KEY,
      companyDomain: RHNE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton: DEFAULT_CANTON,
      url: it.url,
      source: SOURCE_LABEL,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(`${title} ${description}`),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(`${title} ${description}`),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: detail?.datePosted || todayIso,
      applyUrl: detail?.applyUrl || it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      externalId: it.jobId,
    });
  }

  console.log(`  📄 Detail pages enriched: ${detailHits}/${items.length}`);
  console.log(`📋 Total ${RHNE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
