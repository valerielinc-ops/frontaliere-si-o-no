#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using **Solique** (live.solique.ch)
 * as their careers-portal SaaS. Solique is a Swiss-built recruiting
 * platform that server-renders the entire job list in one HTML payload
 * (no JSON API, no pagination — verified May 2026: /api/v1, /feed all 404).
 *
 * Public endpoints (no authentication):
 *
 *   GET https://live.solique.ch/{TENANT}/
 *     → HTML listing with `<div class="job">` tiles. Tile structure varies
 *       by tenant template:
 *
 *       a) "Anchor-wrap" template (Spital Emmental):
 *          <div class="job">
 *            <a href="job/details/{ID}" id="{ID}">
 *              <div class="jobtitle">…</div>
 *              <span class="workload-group">…</span>
 *              <div class="job-details">
 *                <div class="location">…</div>
 *                <div class="area">…</div>
 *                <div class="employment">…</div>
 *              </div>
 *            </a>
 *          </div>
 *
 *       b) "Link-button" template (SVAR Spitalverbund AR):
 *          <div class="job">
 *            <div class="job-group">
 *              <h3 class="jobtitle">…</h3>
 *              <div class="location">…</div>
 *              <div class="startdate">…</div>
 *              <div class="link"><a id="{ID}" href="job/details/{ID}">…</a></div>
 *            </div>
 *          </div>
 *
 *   GET https://live.solique.ch/{TENANT}/job/details/{ID}
 *     → Server-rendered detail HTML. Body content varies:
 *
 *       Template "intro+title-green" (Spital Emmental):
 *         `<div class="intro">…</div>` × N
 *         `<div class="title-green">…</div><ul class="list">…</ul>` × N
 *
 *       Template "offer-section" (SVAR):
 *         `<div class="offer">…</div>` with `<h4 class="sub-subtitle">…</h4>`
 *         then `<ul>…</ul>` content.
 *
 * Confirmed tenants (May 2026):
 *   - Spital Emmental (`spital-emmental`) ~50 active openings — see
 *     `scripts/lib/spital-emmental-job-parser.mjs`.
 *   - SVAR Spitalverbund Appenzell Ausserrhoden (`svar`) ~10 active
 *     openings — see `scripts/lib/svar-spitalverbund-ar-job-parser.mjs`.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, normalizeSpace, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  decodeEntities,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  fetchHtml,
} from './hospital-custom-html-helpers.mjs';

const DETAIL_DELAY_MS = 250;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/**
 * Parse the Solique listing HTML into structured tiles. Handles both the
 * "anchor-wrap" and "link-button" templates seen across tenants.
 */
export function parseSoliqueListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();

  // Template (a): anchor-wrap. The `<a href="job/details/{ID}">` wraps the
  // tile body.
  const tileWrapRx = /<div\s+class="job">\s*<a\s+href="job\/details\/(\d+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/g;
  let m;
  while ((m = tileWrapRx.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(parseSoliqueTileBody(id, m[2]));
  }

  // Template (b): link-button. The `<a href="job/details/{ID}">` lives in
  // a `<div class="link">` sibling inside the tile.
  const tileLinkRx = /<div\s+class="job">([\s\S]*?)<div\s+class="link">\s*<a[^>]+href="job\/details\/(\d+)"[^>]*>[\s\S]*?<\/a>\s*<\/div>\s*[\s\S]*?(?=<div\s+class="job">|$)/g;
  while ((m = tileLinkRx.exec(html))) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(parseSoliqueTileBody(id, m[1]));
  }

  return out.filter((t) => t && t.title && t.title.length >= 3);
}

function parseSoliqueTileBody(id, body) {
  if (!body) return null;
  const titleMatch = body.match(/<(?:div|h[1-6])\s+class="jobtitle"[^>]*>([\s\S]*?)<\/(?:div|h[1-6])>/i);
  const title = titleMatch ? normalizeSpace(decodeEntities(stripHtml(titleMatch[1]))) : '';
  const minMatch = body.match(/<span\s+class="min[^"]*"[^>]*>\s*(\d{1,3})\s*<\/span>/);
  const maxMatch = body.match(/<span\s+class="max[^"]*"[^>]*>\s*(\d{1,3})\s*<\/span>/);
  const minPct = minMatch ? parseInt(minMatch[1], 10) : null;
  const maxPct = maxMatch ? parseInt(maxMatch[1], 10) : null;
  const locationMatch = body.match(/<div\s+class="location"[^>]*>([\s\S]*?)<\/div>/);
  const location = locationMatch ? normalizeSpace(decodeEntities(stripHtml(locationMatch[1]))) : '';
  const areaMatch = body.match(/<div\s+class="area"[^>]*>([\s\S]*?)<\/div>/);
  const area = areaMatch ? normalizeSpace(decodeEntities(stripHtml(areaMatch[1]))) : '';
  const employmentMatch = body.match(/<div\s+class="employment"[^>]*>([\s\S]*?)<\/div>/);
  const employment = employmentMatch ? normalizeSpace(decodeEntities(stripHtml(employmentMatch[1]))) : '';
  const startMatch = body.match(/<div\s+class="startdate"[^>]*>([\s\S]*?)<\/div>/);
  const startDate = startMatch ? normalizeSpace(decodeEntities(stripHtml(startMatch[1]))) : '';
  return { id, title, minPct, maxPct, location, area, employment, startDate };
}

/**
 * Pull a substantive description text from a Solique detail page. Covers
 * both the "intro+title-green" template (Spital Emmental) and the
 * "offer-section" template (SVAR), with bullet preservation.
 */
export function extractSoliqueDetailContent(html = '') {
  if (!html || typeof html !== 'string') return '';
  const sections = [];

  // Template (i): .intro blocks
  const introRx = /<div\s+class="intro"[^>]*>([\s\S]*?)<\/div>/g;
  let im;
  while ((im = introRx.exec(html))) {
    let text = im[1]
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    text = normalizeSpace(decodeEntities(text));
    if (text && text.length > 25) sections.push(text);
  }

  // Template (i): .title-green blocks
  const titledRx = /<div\s+class="title-green"[^>]*>([\s\S]*?)<\/div>([\s\S]*?)(?=<div\s+class="title-green"|$)/g;
  let tm;
  while ((tm = titledRx.exec(html))) {
    const title = normalizeSpace(decodeEntities(stripHtml(tm[1])));
    if (!title) continue;
    let body = tm[2]
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
    if (body && body.length > 5) sections.push(`${title}\n${body}`);
  }

  // Template (ii): <div class="offer"> with <h4 class="sub-subtitle"> headings
  const offerRx = /<div\s+class="offer(?:\s+[^"]*)?"[^>]*>([\s\S]*?)<\/div>\s*(?=<div\s+class="offer(?:\s+[^"]*)?"|<div\s+class="offer-additional"|<\/div>\s*<\/div>|$)/g;
  let om;
  while ((om = offerRx.exec(html))) {
    const inner = om[1];
    // Look for sub-subtitle headings, otherwise treat the whole block as a single section.
    const headingRx = /<h[1-6][^>]*class="sub-subtitle"[^>]*>([\s\S]*?)<\/h[1-6]>([\s\S]*?)(?=<h[1-6][^>]*class="sub-subtitle"|$)/g;
    let hm;
    let captured = false;
    while ((hm = headingRx.exec(inner))) {
      const title = normalizeSpace(decodeEntities(stripHtml(hm[1])));
      if (!title) continue;
      captured = true;
      let body = hm[2]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 5) sections.push(`${title}\n${body}`);
    }
    if (!captured) {
      let body = inner
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 25) sections.push(body);
    }
  }

  return sections.join('\n\n');
}

/**
 * Build a parser bundle for one Solique tenant.
 *
 * @param {Object} config
 * @param {string} config.soliqueTenant      Tenant slug (e.g. `spital-emmental`).
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain
 * @param {string} config.defaultCanton
 * @param {string} config.defaultCity
 * @param {string} [config.defaultPostalCode]
 * @param {string} [config.publicCareerUrl]
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.sourceLabel]
 * @param {Array<string>} [config.extraTrustedHosts]
 * @param {function(string):string} [config.postalCodeForCity]  Optional mapper
 *                                              from primary city → postal code.
 */
export function createSoliqueParser(config) {
  const {
    soliqueTenant,
    companyKey,
    companyName,
    companyDomain,
    defaultCanton,
    defaultCity,
    defaultPostalCode = '',
    publicCareerUrl = '',
    defaultSourceLang = 'de',
    sourceLabel,
    extraTrustedHosts = [],
    postalCodeForCity,
  } = config;

  if (!soliqueTenant || !companyKey || !companyName || !defaultCanton) {
    throw new Error('createSoliqueParser: missing required config');
  }

  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const label = sourceLabel || `${companyName} Dedicated Parser (Solique careers portal)`;
  const listingUrl = `https://live.solique.ch/${soliqueTenant}/`;
  const detailUrlPrefix = `https://live.solique.ch/${soliqueTenant}/job/details/`;
  const trustedHostSet = new Set([
    'live.solique.ch',
    'solique.ch',
    ...extraTrustedHosts.map((h) => String(h || '').toLowerCase()),
  ].filter(Boolean));

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    if (url.includes(`live.solique.ch/${soliqueTenant}`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (trustedHostSet.has(host)) {
        if (host === 'live.solique.ch' || host === 'solique.ch' || host.endsWith('.solique.ch')) {
          return new RegExp(`\\/${soliqueTenant}(\\/|$)`, 'i').test(rawUrl);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${listingUrl} (Solique)\n`);

    let listingHtml;
    try {
      listingHtml = await fetchHtml(listingUrl);
    } catch (err) {
      console.warn(`⚠️ Solique listing fetch failed: ${err?.message || err}`);
      return [];
    }
    const tiles = parseSoliqueListing(listingHtml);
    if (!tiles.length) {
      console.warn(`⚠️ No openings parsed from Solique listing for ${soliqueTenant}`);
      return [];
    }
    console.log(`  ✓ ${tiles.length} jobs from Solique listing`);

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let detailHits = 0;
    let failed = 0;

    for (let i = 0; i < tiles.length; i += 1) {
      const tile = tiles[i];
      const detailUrl = `${detailUrlPrefix}${tile.id}`;
      let detailContent = '';
      try {
        const detailHtml = await fetchHtml(detailUrl);
        detailContent = extractSoliqueDetailContent(detailHtml);
        if (detailContent) detailHits += 1;
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed (${detailUrl}): ${err?.message || err}`);
      }

      const title = tile.title;
      if (!title) {
        failed += 1;
        if (i < tiles.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
        continue;
      }

      const descParts = [];
      if (detailContent) descParts.push(detailContent);
      if (tile.area) descParts.push(`Bereich: ${tile.area}`);
      if (tile.employment) descParts.push(`Anstellung: ${tile.employment}`);
      if (Number.isFinite(tile.maxPct)) {
        const pStr = Number.isFinite(tile.minPct) && tile.minPct !== tile.maxPct
          ? `${tile.minPct}-${tile.maxPct}%`
          : `${tile.maxPct}%`;
        descParts.push(`Pensum: ${pStr}`);
      }
      if (tile.startDate) descParts.push(`Eintritt: ${tile.startDate}`);
      const description = descParts.length
        ? descParts.join('\n\n')
        : `${title} — ${companyName} (${tile.location || defaultCity}).`;

      const rawLocation = tile.location || defaultCity;
      const primaryCity = rawLocation.split(/[&,/]|·/)[0].trim() || defaultCity;
      const canton = inferSwissTargetCanton(`${primaryCity} ${rawLocation}`) || defaultCanton;
      const postal = (postalCodeForCity ? postalCodeForCity(primaryCity) : '') || defaultPostalCode;

      const sourceLang = detectLang(description || title, defaultSourceLang);
      const employmentType = Number.isFinite(tile.maxPct) && tile.maxPct < 90
        ? 'PART_TIME'
        : detectHealthcareEmploymentType(`${title} ${tile.employment || ''}`);
      const isTemporary = /befristet/i.test(tile.employment) && !/unbefristet/i.test(tile.employment);
      const contract = isTemporary ? 'temporary' : 'full-time';

      const jobSlug = slugify(`${title} ${companyKey} ${primaryCity}`);
      const urlHash = createHash('sha1').update(`${companyKey}:${tile.id}`).digest('hex').slice(0, 12);

      const job = {
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        needsRetranslation: true,
        location: rawLocation,
        canton,
        url: detailUrl,
        source: label,
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: primaryCity,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: postal,
        category: detectHealthcareCategory(`${title} ${tile.area || ''}`),
        contract,
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate: todayIso,
        applyUrl: detailUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
        externalId: String(tile.id),
      };

      if (tile.area) job.department = tile.area;
      if (Number.isFinite(tile.minPct) || Number.isFinite(tile.maxPct)) {
        const mn = Number.isFinite(tile.minPct) ? tile.minPct : tile.maxPct;
        const mx = Number.isFinite(tile.maxPct) ? tile.maxPct : tile.minPct;
        job.pensumMin = mn;
        job.pensumMax = mx;
        job.pensum = mn === mx ? `${mx}%` : `${mn} - ${mx}%`;
      }
      if (isTemporary) job.contractDuration = 'temporary';
      else if (/unbefristet/i.test(tile.employment)) job.contractDuration = 'permanent';

      jobs.push(job);
      if (i < tiles.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    console.log(`📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${tiles.length} with rich detail content, ${failed} skipped)`);
    return jobs;
  }

  return {
    fetchAllJobs,
    isCompanyJob,
    isTrustedDomain,
    listingUrl,
    detailUrlPrefix,
    publicCareerUrl,
  };
}
