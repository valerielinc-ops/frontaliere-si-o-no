#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using **Johdi Suite** (johdisuite.ch)
 * as their ATS. Johdi is a Swiss-built recruitment SaaS that ships an
 * embeddable Vue.js widget. The widget calls a single public REST API.
 *
 * Public endpoints (no authentication):
 *
 *   GET https://ats.johdisuite.ch/api/company/{HASH}/publicationFlows/{FLOW}/offers/{LOCALE}
 *      → Array of offers with id, title, introduction, contract_type,
 *        work_place, city, sector, canton, activity_from/to, slug, logo_path,
 *        publication_date.
 *
 *   GET https://ats.johdisuite.ch/api/company/{HASH}/publicationFlows/{FLOW}/offer/{ID}/{LOCALE}
 *      → Full offer including `description` (rich HTML), `subtitle`, `ref`,
 *        contact fields, expiration_date, entry_date.
 *
 * `HASH` is an encrypted Laravel payload exposed as `data-company-hash-key`
 * on the widget mount node (`<div id="ats-offers" data-locale="fr"
 *   data-company-hash-key="…" data-flow="web">`). It is a STABLE identifier
 * tied to the tenant — once captured from the corporate site once it can
 * be hard-coded for years.
 * `FLOW` is the publication flow ("web" for the public board, others for
 * spontaneous submissions).
 *
 * Confirmed tenants (May 2026):
 *   - Hôpital du Jura (H-JU) → ats.johdisuite.ch (flow=web, locale=fr)
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

const DETAIL_DELAY_MS = 250;
const API_HOST = 'https://ats.johdisuite.ch';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

async function fetchJson(url, { timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json,*/*',
        'Content-type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Build a parser bundle for one Johdi Suite tenant.
 *
 * @param {Object} config
 * @param {string} config.companyKey      Internal slug.
 * @param {string} config.companyName     Brand string.
 * @param {string} config.companyDomain   Public domain (no scheme).
 * @param {string} config.companyHashKey  The opaque `data-company-hash-key`
 *                                        value lifted from the widget host page.
 * @param {string} [config.publicationFlow='web']
 * @param {string} [config.locale='fr']   Locale to request (fr | de | it | en).
 * @param {string} [config.publicCareerUrl] Optional human-facing career URL
 *                                        used for the per-job `applyUrl`.
 * @param {string} config.defaultCanton   ISO canton.
 * @param {string} config.defaultCity     Fallback city.
 * @param {string} [config.defaultPostalCode]
 * @param {string} [config.sourceLabel]
 * @param {string} [config.fallbackBrandBlurb]
 */
export function createJohdiSuiteParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    companyHashKey,
    publicationFlow = 'web',
    locale = 'fr',
    publicCareerUrl = '',
    defaultCanton,
    defaultCity,
    defaultPostalCode = '',
    sourceLabel,
    fallbackBrandBlurb = '',
  } = config;

  if (!companyKey || !companyName || !companyHashKey || !defaultCanton) {
    throw new Error('createJohdiSuiteParser: missing required config');
  }

  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const label = sourceLabel || `${companyName} Dedicated Parser (Johdi Suite)`;
  const baseApiUrl = `${API_HOST}/api/company/${companyHashKey}/publicationFlows/${publicationFlow}`;
  const sourceLang = /^(de|fr|it|en)$/.test(locale) ? locale : 'fr';

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (host === 'ats.johdisuite.ch' || host === 'johdisuite.ch' || host.endsWith('.johdisuite.ch')) return true;
      return false;
    } catch {
      return false;
    }
  }

  function buildPublicUrl(offer) {
    if (publicCareerUrl) {
      // The corporate widget host page typically deep-links via `#offer/{id}/{slug}`
      // but we prefer the API id as canonical to keep URLs stable across slug changes.
      return `${publicCareerUrl.replace(/\/$/, '')}#offer/${offer.id}/${offer.slug || ''}`;
    }
    return `${API_HOST}/offer/${offer.id}/${offer.slug || ''}`;
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${API_HOST}/api/company/${companyHashKey}/.../${publicationFlow}/offers/${locale} (Johdi Suite)\n`);

    const listingUrl = `${baseApiUrl}/offers/${locale}`;
    let listing;
    try {
      listing = await fetchJson(listingUrl);
    } catch (err) {
      console.warn(`⚠️ Listing fetch failed (${listingUrl}): ${err?.message || err}`);
      return [];
    }
    if (!Array.isArray(listing) || !listing.length) {
      console.warn(`⚠️ Empty / unexpected listing payload for ${companyName}`);
      return [];
    }
    console.log(`  ✓ ${listing.length} openings in listing JSON`);

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let failed = 0;
    for (let i = 0; i < listing.length; i += 1) {
      const item = listing[i] || {};
      const id = item.id;
      if (!id) {
        failed += 1;
        continue;
      }
      // Detail fetch — yields full description
      let detail = null;
      try {
        detail = await fetchJson(`${baseApiUrl}/offer/${id}/${locale}`);
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed (offer ${id}): ${err?.message || err}`);
      }

      const title = normalizeSpace(decodeEntities(String(detail?.title || item.title || '')));
      if (!title) {
        failed += 1;
        if (i < listing.length - 1) {
          await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
        }
        continue;
      }

      const introHtml = String(detail?.introduction || item.introduction || '');
      const descHtml = String(detail?.description || '');
      const richHtml = [introHtml, descHtml].filter(Boolean).join('\n\n');
      let descriptionRaw = htmlToText(richHtml);
      const uniqueWords = new Set(
        descriptionRaw.toLowerCase().replace(/[^a-zà-ÿäöüß\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
      );
      if (uniqueWords.size < 30) {
        descriptionRaw = fallbackBrandBlurb
          ? `${title} chez ${companyName} à ${detail?.work_place || item.work_place || defaultCity}.\n\n${fallbackBrandBlurb}`
          : `${title} chez ${companyName} à ${detail?.work_place || item.work_place || defaultCity}.`;
      }

      const city = String(detail?.city || item.city || detail?.work_place || item.work_place || defaultCity).trim();
      const cantonInferred = inferSwissTargetCanton(`${city} ${detail?.canton || item.canton || ''}`) || defaultCanton;

      // Activity rate (%): use min/max
      const actMin = Number(detail?.activity_from ?? item.activity_from ?? 0);
      const actMax = Number(detail?.activity_to ?? item.activity_to ?? actMin);
      const activityText = actMin === actMax ? `${actMin}%` : `${actMin}% - ${actMax}%`;
      const employmentType = detectHealthcareEmploymentType(`${title} ${activityText}`);

      // Publication date
      const pubRaw = detail?.publication_date || item.publication_date || '';
      const postedDate = pubRaw
        ? (() => {
            const d = new Date(pubRaw);
            return Number.isNaN(d.getTime()) ? todayIso : d.toISOString().slice(0, 10);
          })()
        : todayIso;

      const detailLang = detectLang(descriptionRaw || title, sourceLang);
      const publicUrl = buildPublicUrl({ ...item, ...detail, slug: detail?.slug || item.slug });
      const urlHash = createHash('sha1').update(`${companyKey}:${id}`).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${title} ${companyKey} ${city}`);

      jobs.push({
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [detailLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [detailLang]: title },
        description: descriptionRaw,
        descriptionByLocale: { [detailLang]: descriptionRaw },
        needsRetranslation: true,
        location: city,
        canton: cantonInferred,
        url: publicUrl,
        source: label,
        sourceLang: detailLang,
        crawledAt: new Date().toISOString(),
        addressLocality: city,
        addressRegion: cantonInferred,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: defaultPostalCode,
        category: detectHealthcareCategory(title),
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: publicUrl,
        requirements: [],
        requirementsByLocale: { [detailLang]: [] },
        externalId: String(id),
      });

      if (i < listing.length - 1) {
        await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
      }
    }

    console.log(`📋 Total ${companyName} jobs discovered: ${jobs.length} (${failed} skipped)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
