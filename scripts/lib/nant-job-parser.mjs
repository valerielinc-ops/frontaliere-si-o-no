#!/usr/bin/env node
/**
 * Fondation de Nant — Beehire ATS.
 *
 * Public career page: https://nant.ch/carrieres/  (links to Beehire app)
 *   Beehire portal:   https://app.beehire.com/career/nant
 *   Public JSON feed: https://app.beehire.com/users/getPublicCampaigns/nant
 *
 * Foundation Vaud (canton VD), psychiatric care site at Corsier-sur-Vevey.
 * Sites: SPAUL (Lausanne unit), main campus at Corsier-sur-Vevey.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import {
  fetchBeehireCampaigns,
  beehireTitle,
  beehireDescriptionToText,
  beehireLocationCity,
  mapBeehireContract,
  mapBeehireEmploymentType,
} from './beehire-common.mjs';

export const NANT_KEY = 'nant';
export const NANT_COMPANY_NAME = 'Fondation de Nant';
export const NANT_COMPANY_DOMAIN = 'nant.ch';

const BEEHIRE_SLUG = 'nant';
const PREFERRED_LANGS = [1, 0, 2, 3, 4, 5, 6]; // 1 = French
const FALLBACK_CITY = 'Corsier-sur-Vevey';
const FALLBACK_CANTON = 'VD';
const FALLBACK_POSTAL = '1804';
const CORPORATE_CAREER_URL = 'https://nant.ch/carrieres/';

export function isNantJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === NANT_KEY) return true;
  if (url.includes('nant.ch')) return true;
  if (url.includes(`/career/${BEEHIRE_SLUG}`)) return true;
  if (
    url.includes(`/invite/`) &&
    String(job?.company || '').toLowerCase().includes('nant')
  ) {
    return true;
  }
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'nant.ch' || host.endsWith('.nant.ch')) return true;
    if (host === 'app.beehire.com') return true;
    return false;
  } catch {
    return false;
  }
}

function buildPublicJobUrl(campaign) {
  if (campaign?.inviteLink) return campaign.inviteLink;
  if (campaign?.publicLink) return campaign.publicLink;
  return `https://app.beehire.com/career/${BEEHIRE_SLUG}`;
}

export async function fetchAllNantJobs() {
  console.log(`🏥 Fetching ${NANT_COMPANY_NAME} jobs`);
  console.log(`   Source: app.beehire.com/users/getPublicCampaigns/${BEEHIRE_SLUG}\n`);

  let campaigns = [];
  try {
    campaigns = await fetchBeehireCampaigns(BEEHIRE_SLUG);
  } catch (err) {
    console.warn(`  ⚠️ Beehire feed fetch failed: ${err?.message || err}`);
    return [];
  }
  console.log(`  ✓ ${campaigns.length} campaigns in Beehire feed`);
  if (!campaigns.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const c of campaigns) {
    const title = beehireTitle(c, PREFERRED_LANGS);
    if (!title || title.length < 5) continue;
    if (/candidature\s+spontan/i.test(title)) continue;

    const body = beehireDescriptionToText(c.description);
    const description = [
      body,
      `Fondation de Nant — Établissement psychiatrique au cœur du canton de Vaud, sites de Corsier-sur-Vevey et SPAUL (Lausanne).`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const city = beehireLocationCity(c) || FALLBACK_CITY;
    const canton =
      (c?.location?.state || '').toString().toUpperCase() || FALLBACK_CANTON;
    const url = buildPublicJobUrl(c);
    const sourceLang = detectLang(description || title, 'fr');
    const slug = slugify(`${title} ${NANT_KEY} ${city}`);
    const urlHash = createHash('sha1')
      .update(`${NANT_KEY}-${c._id || url}`)
      .digest('hex')
      .slice(0, 12);

    const contractRaw = c?.details?.contract?.type || '';
    const durationRaw = c?.details?.contract?.duration || '';

    jobs.push({
      id: `${NANT_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      company: NANT_COMPANY_NAME,
      companyKey: NANT_KEY,
      companyDomain: NANT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url,
      source: 'Fondation de Nant Dedicated Parser (Beehire JSON)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: FALLBACK_POSTAL,
      category: detectHealthcareCategory(`${title} ${description}`),
      contract: mapBeehireContract(contractRaw),
      employmentType:
        mapBeehireEmploymentType(durationRaw) || detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Santé mentale / Psychiatrie',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      careerSiteUrl: CORPORATE_CAREER_URL,
    });
  }
  console.log(`📋 Total ${NANT_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
