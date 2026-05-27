#!/usr/bin/env node
/**
 * Clinique de La Source, Lausanne — eRecruit ATS.
 *
 * Public career site:  https://emploi.lasource.ch/
 *   RSS feed:          https://emploi.lasource.ch/rss.php
 *   Detail page:       https://emploi.lasource.ch/?page=advertisement_display&id={N}
 *
 * Largest private clinic in canton Vaud, founded 1891. Independent foundation,
 * comprehensive acute care + ambulatory surgery + radio-oncology.
 *
 * Same minimal-ATS as Hôpital ophtalmique (sister parser), but title/body are
 * fetched from the detail page (og:title + `<div id="advert">`).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { parseErecruitRss, fetchErecruitRss, fetchErecruitDetail } from './erecruit-common.mjs';

export const CLINIQUE_LA_SOURCE_KEY = 'clinique-la-source';
export const CLINIQUE_LA_SOURCE_COMPANY_NAME = 'Clinique de La Source';
export const CLINIQUE_LA_SOURCE_COMPANY_DOMAIN = 'lasource.ch';

const RSS_URL = 'https://emploi.lasource.ch/rss.php';
const CAREER_URL = 'https://emploi.lasource.ch/';

export function isCliniqueLaSourceJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === CLINIQUE_LA_SOURCE_KEY) return true;
  if (url.includes('lasource.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'lasource.ch' || host.endsWith('.lasource.ch');
  } catch {
    return false;
  }
}

function normalizeDetailUrl(rawLink) {
  return rawLink.replace(/^http:\/\//i, 'https://');
}

export async function fetchAllCliniqueLaSourceJobs() {
  console.log(`🏥 Fetching ${CLINIQUE_LA_SOURCE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${RSS_URL}\n`);

  let rss;
  try {
    rss = await fetchErecruitRss(RSS_URL);
  } catch (err) {
    console.warn(`  ⚠️ RSS feed fetch failed: ${err?.message || err}`);
    return [];
  }
  const items = parseErecruitRss(rss);
  console.log(`  ✓ ${items.length} annunci nel feed RSS`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const it of items) {
    const url = normalizeDetailUrl(it.link);
    const detail = await fetchErecruitDetail(url);
    await new Promise((r) => setTimeout(r, 250));
    if (!detail || !detail.title) continue;
    if (detail.description && detail.description.length > 30) detailHits++;

    const title = detail.title;
    const description = [
      detail.description,
      `Clinique de La Source — Plus grande clinique privée du canton de Vaud, Lausanne.`,
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || title, 'fr');
    const jobSlug = slugify(`${title} ${CLINIQUE_LA_SOURCE_KEY} lausanne`);
    const urlHash = createHash('sha1').update(`${CLINIQUE_LA_SOURCE_KEY}-${it.id}`).digest('hex').slice(0, 12);
    const heuristicText = `${title}\n${description.slice(0, 800)}`;

    jobs.push({
      id: `${CLINIQUE_LA_SOURCE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CLINIQUE_LA_SOURCE_COMPANY_NAME,
      companyKey: CLINIQUE_LA_SOURCE_KEY,
      companyDomain: CLINIQUE_LA_SOURCE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, `translate-pending.yml` picks the job up.
      needsRetranslation: true,
      location: 'Lausanne',
      canton: 'VD',
      url,
      source: 'Clinique de La Source Dedicated Parser (eRecruit RSS + advertisement_display detail)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Lausanne',
      addressRegion: 'VD',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '1004',
      category: detectHealthcareCategory(heuristicText),
      contract: /\bcdd\b|durée\s+déterminée|temporaire/i.test(heuristicText) ? 'temporary' : 'full-time',
      employmentType: detectHealthcareEmploymentType(heuristicText),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      careerSiteUrl: CAREER_URL,
    });
  }
  console.log(`📋 Total ${CLINIQUE_LA_SOURCE_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}
