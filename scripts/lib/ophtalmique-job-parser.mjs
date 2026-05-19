#!/usr/bin/env node
/**
 * Hôpital ophtalmique Jules-Gonin / Fondation Asile des aveugles (FAA).
 *
 * Public career site:  https://emploi.ophtalmique.ch/
 *   RSS feed:          https://emploi.ophtalmique.ch/rss.php
 *   Detail page:       https://emploi.ophtalmique.ch/?page=advertisement_display&id={N}
 *
 * Specialised ophthalmology hospital + low-vision rehabilitation + EMS, all
 * belonging to the Fondation Asile des aveugles in Lausanne (VD).
 *
 * The minimal-ATS RSS feed exposes only JobID + link (title/location are empty)
 * so we fetch each detail page to extract title (from og:title) and the body
 * from the `<div id="advert">` block.
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

export const OPHTALMIQUE_KEY = 'ophtalmique';
export const OPHTALMIQUE_COMPANY_NAME = 'Hôpital ophtalmique Jules-Gonin (Fondation Asile des aveugles)';
export const OPHTALMIQUE_COMPANY_DOMAIN = 'ophtalmique.ch';

const RSS_URL = 'https://emploi.ophtalmique.ch/rss.php';
const CAREER_URL = 'https://emploi.ophtalmique.ch/';

export function isOphtalmiqueJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === OPHTALMIQUE_KEY) return true;
  if (url.includes('ophtalmique.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ophtalmique.ch' || host.endsWith('.ophtalmique.ch');
  } catch {
    return false;
  }
}

function normalizeDetailUrl(rawLink) {
  // RSS feed historically uses http://; force https on our canonical URL.
  return rawLink.replace(/^http:\/\//i, 'https://');
}

export async function fetchAllOphtalmiqueJobs() {
  console.log(`🏥 Fetching ${OPHTALMIQUE_COMPANY_NAME} jobs`);
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
      `Fondation Asile des aveugles — Hôpital ophtalmique Jules-Gonin, Lausanne (VD).`,
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || title, 'fr');
    const jobSlug = slugify(`${title} ${OPHTALMIQUE_KEY} lausanne`);
    const urlHash = createHash('sha1').update(`${OPHTALMIQUE_KEY}-${it.id}`).digest('hex').slice(0, 12);
    const heuristicText = `${title}\n${description.slice(0, 800)}`;

    jobs.push({
      id: `${OPHTALMIQUE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: OPHTALMIQUE_COMPANY_NAME,
      companyKey: OPHTALMIQUE_KEY,
      companyDomain: OPHTALMIQUE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Lausanne',
      canton: 'VD',
      url,
      source: 'Ophtalmique Dedicated Parser (eRecruit RSS + advertisement_display detail)',
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
  console.log(`📋 Total ${OPHTALMIQUE_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}
