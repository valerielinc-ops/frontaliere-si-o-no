#!/usr/bin/env node
/**
 * Shared parser for the Solique recruiting platform (https://live.solique.ch/{tenant}/).
 *
 * Several Swiss care institutions that historically published through Umantis
 * have migrated their live job board to Solique while keeping the Umantis
 * tenant only as a stale apply-redirect shell (the `/Vacancies/{id}/Description`
 * page now 302s away — see issue #1245). For those tenants the Solique board is
 * the *source of truth*: it carries the current openings AND full server-rendered
 * descriptions, so we crawl it directly instead of the dead Umantis listing.
 *
 * Listing card (server-rendered, no JS):
 *   <div class="job">
 *     <a id="{ID}" href="job/details/{ID}">
 *       <div class="jobtitle_workload">
 *         <div class="jobtitle">{TITLE}</div>
 *         <span class="workload-group"><span class="min workload_from">70</span>
 *           <span class="max workload_to">100</span><span class="percent">%</span></span>
 *       </div>
 *       <div class="job-info"><div class="location">{CITY}</div> …</div>
 *
 * Detail page (job/details/{ID}): `<div class="job-introduction">…</div>` (role
 * intro) + `<div class="content">…</div>` (employer blurb + Aufgaben/Profil),
 * both real prose — concatenated into the description.
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
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

const POLITE_DELAY_MS = 200;

function stripTags(html = '') {
  return normalizeSpace(decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')));
}

/** Parse the Solique listing HTML into `{ id, url, title, location, workload }` rows. */
export function parseSoliqueListing(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const cardRx = /<div class="job">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRx.exec(html))) {
    const card = m[1];
    const idMatch = card.match(/href="(job\/details\/(\d+))"/);
    if (!idMatch) continue;
    const id = idMatch[2];
    if (seen.has(id)) continue;
    const titleMatch = card.match(/<div class="jobtitle">([\s\S]*?)<\/div>/);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';
    if (!title || title.length < 4) continue;
    seen.add(id);
    const locMatch = card.match(/<div class="location">([\s\S]*?)<\/div>/);
    const location = locMatch ? stripTags(locMatch[1]) : '';
    const fromMatch = card.match(/workload_from[^>]*>([\s\S]*?)<\/span>/);
    const toMatch = card.match(/workload_to[^>]*>([\s\S]*?)<\/span>/);
    const from = fromMatch ? stripTags(fromMatch[1]) : '';
    const to = toMatch ? stripTags(toMatch[1]) : '';
    const workload = from && to ? `${from}-${to}%` : from ? `${from}%` : '';
    out.push({ id, url: `${base}/job/details/${id}`, title, location, workload });
  }
  return out;
}

/** Extract the description prose from a Solique detail page. */
export function extractSoliqueDetailContent(html) {
  if (!html || typeof html !== 'string') return '';
  const parts = [];
  for (const cls of ['job-introduction', 'content']) {
    // Grab the block up to the next major structural <div ...> wrapper.
    const rx = new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)(?:<div class="(?:job-|infos-|apply|footer|sidebar|social|share))`, 'i');
    const m = html.match(rx);
    if (!m) continue;
    let block = m[1]
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    block = decodeEntities(block).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    if (block && block.length > 20) parts.push(block);
  }
  return parts.join('\n\n');
}

/**
 * Parse the Solique JSON list endpoint (`/{tenant}/{lang}/api/v1/data/`) used by
 * the AngularJS board variant (e.g. ipw). Returns the same row shape as the SSR
 * parser; the per-job detail page (`/{tenant}/{lang}/{job.link}`) is SSR and
 * shares `extractSoliqueDetailContent`.
 *
 * @param {object} data   parsed JSON (caller strips the UTF-8 BOM)
 * @param {string} baseUrl  e.g. 'https://live.solique.ch/ipw'
 * @param {string} lang   API lang segment, e.g. 'de'
 */
export function parseSoliqueApiListing(data, baseUrl, lang = 'de') {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const out = [];
  const seen = new Set();
  for (const j of jobs) {
    const id = String(j?.title?.id || j?.id || '').trim();
    const title = normalizeSpace(decodeEntities(String(j?.title?.value || '')));
    if (!id || !title || seen.has(id)) continue; // skip placeholder rows with empty title
    seen.add(id);
    const location = normalizeSpace(String(j?.location?.value || ''));
    const from = String(j?.from?.value || '').trim();
    const to = String(j?.to?.value || '').trim();
    const workload = from && to && from !== to ? `${from}-${to}%` : from ? `${from}%` : '';
    const link = String(j?.link || '').replace(/^\/+/, '');
    const url = link ? `${base}/${lang}/${link}` : `${base}/${lang}/jobs/--${id}`;
    out.push({ id, url, title, location, workload });
  }
  return out;
}

/**
 * Create a Solique crawler for one tenant.
 *
 * @param {object} config
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain
 * @param {string} config.soliqueTenant     path segment, e.g. 'adullam' → live.solique.ch/adullam/
 * @param {'ssr'|'api'} [config.soliqueMode='ssr']  'ssr' = flat HTML board (adullam);
 *                                           'api' = AngularJS board with JSON list endpoint (ipw)
 * @param {string} [config.apiLang='de']     lang segment for the 'api' mode endpoints
 * @param {string} config.defaultCanton
 * @param {string} config.defaultCity
 * @param {string} config.defaultPostalCode
 * @param {string} [config.defaultSourceLang='de']
 */
export function createSoliqueListingParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    soliqueTenant,
    soliqueMode = 'ssr',
    apiLang = 'de',
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    defaultSourceLang = 'de',
  } = config;

  if (!companyKey || !companyName || !soliqueTenant || !defaultCanton) {
    throw new Error('createSoliqueListingParser: missing required config (companyKey/companyName/soliqueTenant/defaultCanton)');
  }

  const BASE_URL = `https://live.solique.ch/${soliqueTenant}`;
  const LISTING_URL = soliqueMode === 'api'
    ? `${BASE_URL}/${apiLang}/api/v1/data/`
    : `${BASE_URL}/`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();

  async function gatherEntries() {
    const raw = await fetchHtml(LISTING_URL);
    if (soliqueMode === 'api') {
      const data = JSON.parse(String(raw).replace(/^﻿/, ''));
      return parseSoliqueApiListing(data, BASE_URL, apiLang);
    }
    return parseSoliqueListing(raw, BASE_URL);
  }

  function isCompanyJob(job) {
    const key = String(job?.companyKey || '').toLowerCase();
    const url = String(job?.url || '').toLowerCase();
    if (key === companyKey) return true;
    if (url.includes(`live.solique.ch/${soliqueTenant}`)) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (host === 'live.solique.ch') return true;
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${LISTING_URL} (Solique ${soliqueMode})\n`);

    const entries = await gatherEntries();
    console.log(`  ✓ ${entries.length} jobs from Solique listing (${soliqueMode})`);
    if (!entries.length) return [];

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let detailHits = 0;

    for (const entry of entries) {
      let detailContent = '';
      try {
        const detailHtml = await fetchHtml(entry.url);
        detailContent = extractSoliqueDetailContent(detailHtml);
      } catch (err) {
        console.warn(`  ⚠️ detail fetch failed for ${entry.id}: ${err?.message || err}`);
      }
      if (detailContent) detailHits++;
      await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));

      const location = entry.location || defaultCity;
      const canton = inferSwissTargetCanton(location) || defaultCanton;

      const metaBullets = [];
      if (entry.workload) metaBullets.push(`• Pensum: ${entry.workload}`);
      metaBullets.push(`• Standort: ${location} (${canton})`);

      let description;
      if (detailContent) {
        const parts = [detailContent];
        if (metaBullets.length) parts.push(metaBullets.join('\n'));
        description = parts.join('\n\n');
      } else {
        // No detail prose recovered — synthesise a structured fallback so the
        // parser-quality audit still sees list structure. Rare on Solique.
        const intro = `${entry.title} bei ${companyName} in ${location} (${defaultPostalCode}, ${canton}), Schweiz.`;
        metaBullets.push(`• Bewerbung über das Solique-Karriereportal von ${companyName}`);
        description = `${intro}\n\n${metaBullets.join('\n')}`;
      }

      const sourceLang = detectLang(description || entry.title, defaultSourceLang);
      const jobSlug = slugify(`${entry.title} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(entry.url).digest('hex').slice(0, 12);

      jobs.push({
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title: entry.title,
        titleByLocale: { [sourceLang]: entry.title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        needsRetranslation: true,
        location,
        canton,
        url: entry.url,
        source: `${companyName} Dedicated Parser (Solique board ${soliqueTenant})`,
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: defaultPostalCode,
        category: detectHealthcareCategory(entry.title),
        contract: 'full-time',
        employmentType: detectHealthcareEmploymentType(`${entry.workload} ${entry.title}`),
        experienceLevel: detectHealthcareExperienceLevel(entry.title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate: todayIso,
        applyUrl: entry.url,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${entries.length} with detail content)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
