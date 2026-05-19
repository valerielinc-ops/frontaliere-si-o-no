#!/usr/bin/env node
/**
 * Hôpital de Lavaux job parser — Beehire ATS.
 *
 * Public career site:  https://www.hopitaldelavaux.ch/jcms/lav_5237/emplois
 *                      (Jalios JCMS page that links to the Beehire career page)
 *   Beehire portal:    https://app.beehire.com/career/hopitaldelavaux
 *   Public JSON feed:  https://app.beehire.com/users/getPublicCampaigns/hopitaldelavaux
 *
 * Private foundation hospital recognised of public interest, in Cully (Bourg-en-
 * Lavaux), canton Vaud. Member of the Fédération des Hôpitaux Vaudois.
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

export const HOPITAL_DE_LAVAUX_KEY = 'hopital-de-lavaux';
export const HOPITAL_DE_LAVAUX_COMPANY_NAME = 'Hôpital de Lavaux';
export const HOPITAL_DE_LAVAUX_COMPANY_DOMAIN = 'hopitaldelavaux.ch';

const BEEHIRE_SLUG = 'hopitaldelavaux';
const PREFERRED_LANGS = [1, 0, 2, 3, 4, 5, 6];   // 1 = French
const FALLBACK_CITY = 'Cully';
const FALLBACK_CANTON = 'VD';
const FALLBACK_POSTAL = '1096';
const CORPORATE_CAREER_URL = 'https://www.hopitaldelavaux.ch/jcms/lav_5237/emplois';

export function isHopitalDeLavauxJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === HOPITAL_DE_LAVAUX_KEY) return true;
  if (url.includes('hopitaldelavaux.ch')) return true;
  if (url.includes(`/career/${BEEHIRE_SLUG}`)) return true;
  if (url.includes(`/invite/`) && String(job?.company || '').toLowerCase().includes('lavaux')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'hopitaldelavaux.ch' || host.endsWith('.hopitaldelavaux.ch')) return true;
    if (host === 'app.beehire.com') return true;
    return false;
  } catch {
    return false;
  }
}

function buildPublicJobUrl(campaign) {
  // Beehire's public job URL is the inviteLink (apply-as-candidate page).
  if (campaign?.inviteLink) return campaign.inviteLink;
  if (campaign?.publicLink) return campaign.publicLink;
  return `https://app.beehire.com/career/${BEEHIRE_SLUG}`;
}

export async function fetchAllHopitalDeLavauxJobs() {
  console.log(`🏥 Fetching ${HOPITAL_DE_LAVAUX_COMPANY_NAME} jobs`);
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
    // Skip the "Candidature spontanée" (spontaneous application) placeholder.
    if (/candidature\s+spontan/i.test(title)) continue;

    const description = [
      beehireDescriptionToText(c.description),
      `Hôpital de Lavaux — Fondation privée reconnue d'intérêt public, Cully (Bourg-en-Lavaux, VD).`,
    ].filter(Boolean).join('\n\n');

    const city = beehireLocationCity(c) || FALLBACK_CITY;
    const canton = (c?.location?.state || '').toString().toUpperCase() || FALLBACK_CANTON;
    const url = buildPublicJobUrl(c);
    const sourceLang = detectLang(description || title, 'fr');
    const slug = slugify(`${title} ${HOPITAL_DE_LAVAUX_KEY} ${city}`);
    const urlHash = createHash('sha1').update(`${HOPITAL_DE_LAVAUX_KEY}-${c._id || url}`).digest('hex').slice(0, 12);

    const contractRaw = c?.details?.contract?.type || '';
    const durationRaw = c?.details?.contract?.duration || '';

    jobs.push({
      id: `${HOPITAL_DE_LAVAUX_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      company: HOPITAL_DE_LAVAUX_COMPANY_NAME,
      companyKey: HOPITAL_DE_LAVAUX_KEY,
      companyDomain: HOPITAL_DE_LAVAUX_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url,
      source: 'Hôpital de Lavaux Dedicated Parser (Beehire JSON)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: FALLBACK_POSTAL,
      category: detectHealthcareCategory(`${title} ${description}`),
      contract: mapBeehireContract(contractRaw),
      employmentType: mapBeehireEmploymentType(durationRaw) || detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      careerSiteUrl: CORPORATE_CAREER_URL,
    });
  }
  console.log(`📋 Total ${HOPITAL_DE_LAVAUX_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
