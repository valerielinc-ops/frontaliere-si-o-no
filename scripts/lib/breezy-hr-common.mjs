#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using **Breezy HR** as their ATS.
 *
 * Breezy is a SaaS hiring product (https://breezy.hr/) used by mid-size
 * European employers. Each tenant gets a subdomain like
 *   https://hopital-fribourgeois.breezy.hr/
 * which hosts an AngularJS SPA. The SPA pulls data from two stable
 * endpoints that are reachable WITHOUT authentication:
 *
 *   GET https://{tenant}.breezy.hr/json
 *      → Array of jobs (id, friendly_id, name, url, published_date, type,
 *        location, department, company, locations) but NO description.
 *
 *   GET https://{tenant}.breezy.hr/p/{friendly_id}
 *      Accept: text/html
 *      User-Agent: Googlebot/2.1
 *      → Pre-rendered HTML with a `<script type="application/ld+json">`
 *        containing the full `JobPosting` schema (title, description,
 *        hiringOrganization, validThrough, employmentType, jobLocation).
 *      With a regular browser UA the SPA shell ships an empty
 *        `<div ng-view>` and content is hydrated client-side — useless
 *        to a crawler. Googlebot UA triggers the server-side prerender.
 *
 * Confirmed Swiss tenants:
 *   - hopital-fribourgeois → Hôpital fribourgeois (HFR), Fribourg
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
// Breezy's server-side prerender only kicks in for crawler UAs. Without
// this, the detail HTML is a SPA shell and `og:description` is truncated
// at 300 chars by the global SEO middleware.
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BROWSER_UA = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

async function fetchJsonWithTimeout(url, { ua = BROWSER_UA, timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json,*/*', 'User-Agent': ua },
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

async function fetchHtmlAsCrawler(url, { timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': CRAWLER_UA,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Extract the JobPosting JSON-LD block from a prerendered Breezy detail page.
 */
export function parseBreezyDetail(html) {
  if (!html || typeof html !== 'string') return null;
  const blocks = [];
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) blocks.push(m[1].trim());
  for (const raw of blocks) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(obj) ? obj : [obj];
    for (const c of candidates) {
      const type = c?.['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
        const title = String(c.title || '').trim();
        const descriptionHtml = String(c.description || '');
        const descriptionText = htmlToText(descriptionHtml);
        const loc = c.jobLocation && c.jobLocation.address ? c.jobLocation.address : {};
        const city = String(loc.addressLocality || '').trim();
        const region = String(loc.addressRegion || '').trim();
        const postalCode = String(loc.postalCode || '').trim();
        const employmentTypeRaw = String(c.employmentType || '').toUpperCase();
        const postedRaw = c.datePosted ? String(c.datePosted) : '';
        const postedDate = (() => {
          if (!postedRaw) return '';
          const d = new Date(postedRaw);
          return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
        })();
        return {
          title,
          descriptionHtml,
          descriptionText,
          city,
          region,
          postalCode,
          employmentTypeRaw,
          postedDate,
        };
      }
    }
  }
  return null;
}

/**
 * Build a parser bundle for one Breezy HR tenant.
 *
 * @param {Object} config
 * @param {string} config.companyKey       Internal slug (e.g. 'hfr-fribourg').
 * @param {string} config.companyName      Brand string.
 * @param {string} config.companyDomain    Public domain (no scheme).
 * @param {string} config.breezyTenant     Subdomain of breezy.hr (e.g. 'hopital-fribourgeois').
 * @param {string} config.defaultCanton    ISO canton code.
 * @param {string} config.defaultCity      Fallback city.
 * @param {string} [config.defaultPostalCode]
 * @param {string} [config.defaultSourceLang='fr']
 * @param {string} [config.sourceLabel]
 * @param {string} [config.fallbackBrandBlurb]  Boilerplate description when detail fetch fails.
 */
export function createBreezyHrParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    breezyTenant,
    defaultCanton,
    defaultCity,
    defaultPostalCode = '',
    defaultSourceLang = 'fr',
    sourceLabel,
    fallbackBrandBlurb = '',
  } = config;

  if (!companyKey || !companyName || !breezyTenant || !defaultCanton) {
    throw new Error('createBreezyHrParser: missing required config');
  }

  const tenantHost = `${breezyTenant}.breezy.hr`;
  const listingUrl = `https://${tenantHost}/json`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const label = sourceLabel || `${companyName} Dedicated Parser (Breezy HR)`;

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const url = normalize(job?.url || '');
    const company = normalize(job?.company || '');
    if (key === companyKey) return true;
    if (url.includes(tenantHost)) return true;
    if (corporateHost && (url.includes(corporateHost) || company.includes(corporateHost.split('.')[0]))) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (host === tenantHost) return true;
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: https://${tenantHost} (Breezy HR)\n`);

    let listing;
    try {
      listing = await fetchJsonWithTimeout(listingUrl);
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
      const friendlyId = String(item.friendly_id || '').trim();
      const id = String(item.id || '').trim();
      const listingTitle = normalizeSpace(decodeEntities(String(item.name || '')));
      const detailUrl = item.url
        || (friendlyId ? `https://${tenantHost}/p/${friendlyId}` : '');
      if (!detailUrl || !listingTitle) {
        failed += 1;
        continue;
      }

      let detail = null;
      try {
        const html = await fetchHtmlAsCrawler(detailUrl);
        detail = parseBreezyDetail(html);
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed (${detailUrl}): ${err?.message || err}`);
      }

      const title = (detail?.title || listingTitle).trim();
      const listingLoc = item.location || (Array.isArray(item.locations) ? item.locations[0] : null) || {};
      const listingCityRaw = String(listingLoc.city || '').trim();
      // Some Breezy tenants stuff the brand into the city field (e.g.
      // "hôpital fribourgeois / freiburger spital"). Reject those and fall
      // back to `defaultCity` so downstream consumers get a real place.
      const looksLikeBrandNoise = (s) => !s
        || /\//.test(s)
        || /\b(spital|hôpital|hospital|clinic|center|centre|réseau|reseau)\b/i.test(s)
        || s.length > 60;
      const detailCity = detail?.city && !looksLikeBrandNoise(detail.city) ? detail.city : '';
      const listingCity = !looksLikeBrandNoise(listingCityRaw) ? listingCityRaw : '';
      const city = detailCity || listingCity || defaultCity;
      const cantonInferred = inferSwissTargetCanton(`${city} ${detail?.region || ''}`) || defaultCanton;
      const postalCode = detail?.postalCode || defaultPostalCode;

      let descriptionRaw = detail?.descriptionText || '';
      // Boilerplate guard
      const uniqueWords = new Set(
        descriptionRaw.toLowerCase().replace(/[^a-zà-ÿäöüß\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
      );
      if (uniqueWords.size < 30) {
        descriptionRaw = fallbackBrandBlurb
          ? `${title} chez ${companyName} à ${city}.\n\n${fallbackBrandBlurb}`
          : `${title} chez ${companyName} à ${city}.`;
      }

      const sourceLang = detectLang(descriptionRaw || title, defaultSourceLang);
      const postedDate = detail?.postedDate
        || (item.published_date ? new Date(item.published_date).toISOString().slice(0, 10) : todayIso);

      let employmentType = 'OTHER';
      if (/FULL_TIME/.test(detail?.employmentTypeRaw || '')) employmentType = 'FULL_TIME';
      else if (/PART_TIME/.test(detail?.employmentTypeRaw || '')) employmentType = 'PART_TIME';
      // Fallback from listing.type
      if (employmentType === 'OTHER') {
        const t = normalize(item.type?.id || '');
        if (t === 'fulltime') employmentType = 'FULL_TIME';
        else if (t === 'parttime') employmentType = 'PART_TIME';
      }
      if (employmentType === 'OTHER') {
        employmentType = detectHealthcareEmploymentType(title);
      }

      const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${title} ${companyKey} ${city}`);

      jobs.push({
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionRaw,
        descriptionByLocale: { [sourceLang]: descriptionRaw },
        needsRetranslation: true,
        location: city,
        canton: cantonInferred,
        url: detailUrl,
        source: label,
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: city,
        addressRegion: cantonInferred,
        addressCountry: 'CH',
        country: 'CH',
        postalCode,
        category: detectHealthcareCategory(title),
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: detailUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
        // diagnostic (matches breezy id for de-dup); not load-bearing
        externalId: id || friendlyId,
      });

      if (!detail) failed += 1;
      if (i < listing.length - 1) {
        await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
      }
    }

    console.log(`📋 Total ${companyName} jobs discovered: ${jobs.length} (${failed} fallbacks/failures)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
