#!/usr/bin/env node
/**
 * Réseau hospitalier neuchâtelois (RHNE) — Neuchâtel public hospital network.
 *
 * Public career listing (Liferay 7 CMS, server-rendered):
 *   https://www.rhne.ch/espace-emploi/emploi/postuler/tous-les-postes?cat=all
 *
 * The page server-renders an `<div id="jobs">` block containing all open
 * positions as `<a class="jobLink" href="?jobId=...">Title</a>` entries.
 * Each card carries the position TITLE only — RHNE intentionally hides the
 * job description on the public page and reveals it only after the user
 * clicks (the SPA fetches detail content into a modal via a Liferay
 * portlet that requires a session cookie, returning the same listing HTML
 * to anonymous requests).
 *
 * Practical consequence: we can reliably enumerate ALL open positions
 * (title + jobId) but the description must fall back to a brand blurb.
 * This is consistent with the boilerplate guard pattern used by the
 * SuccessFactors and Johdi Suite factories when detail fetch fails.
 *
 * As of May 2026 the listing exposes ~8 active openings.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
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

export async function fetchAllRhneJobs() {
  console.log(`🏥 Fetching ${RHNE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Liferay HTML listing — title-only)\n`);

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
  for (const it of items) {
    const title = it.title;
    const description = `${title} au ${RHNE_COMPANY_NAME} à ${DEFAULT_CITY}.\n\n${FALLBACK_BRAND_BLURB}`;
    const sourceLang = detectLang(`${title} ${description}`, 'fr');
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${RHNE_KEY} ${DEFAULT_CITY}`);
    const employmentType = detectHealthcareEmploymentType(title);

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
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: it.url,
      source: SOURCE_LABEL,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL,
      category: detectHealthcareCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      externalId: it.jobId,
    });
  }

  console.log(`📋 Total ${RHNE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
