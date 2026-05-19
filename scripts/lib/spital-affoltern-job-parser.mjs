#!/usr/bin/env node
/**
 * Spital Affoltern job parser.
 *
 * Public career site: https://www.spitalaffoltern.ch/jobs-bildung/offene-stellen
 *   → loads 7 Dualoo job portals via <script src="https://jobs.dualoo.com/portal/{portalId}">.
 *
 * Each portal page is server-rendered HTML where each job row looks like:
 *
 *   <a class="row jobElement ..."
 *      href="{portalId}/{uuid}/detail?lang=DE"
 *      data-eventData="{&quot;jobName&quot;:&quot;...&quot;,&quot;startDate&quot;:&quot;...&quot;,&quot;location&quot;:&quot;...&quot;}">
 *     <span class="jobName">{TITLE}</span>
 *     <span class="cityName">{LOCATION}</span>
 *     <span class="workPeriod"><span>{CONTRACT}</span></span>
 *     <span class="jobDate" data-date="{TYPE}">{START_DATE}</span>
 *   </a>
 *
 * Detail page URL: https://jobs.dualoo.com/portal/{portalId}/{uuid}/detail?lang=DE
 *
 * The 7 portals map to different departments of Spital Affoltern AG
 * (Affoltern am Albis, ZH): central acute hospital with ~600 employees,
 * Zentrum für Altersmedizin und Palliative Care, Zentrum für Psychiatrie und
 * Psychotherapie, MPA/Ambulatorien, Lehrstellen, IT/Verwaltung.
 *
 * Polite delay: 250 ms between detail-page fetches.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const SPITAL_AFFOLTERN_KEY = 'spital-affoltern';
export const SPITAL_AFFOLTERN_COMPANY_NAME = 'Spital Affoltern AG';
export const SPITAL_AFFOLTERN_COMPANY_DOMAIN = 'spitalaffoltern.ch';

const DUALOO_BASE = 'https://jobs.dualoo.com';
const PORTAL_IDS = [
  '8n6b8ihk',
  '9dfy7ms4',
  'ais9urem',
  'e9akb9vi',
  'f1il0n9x',
  'gjjv3bg7',
  'vnt8c9rs',
];
const PUBLIC_CAREER_URL = 'https://www.spitalaffoltern.ch/jobs-bildung/offene-stellen';
const DETAIL_DELAY_MS = 250;

export function isSpitalAffolternJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === SPITAL_AFFOLTERN_KEY) return true;
  if (url.includes('spitalaffoltern.ch')) return true;
  if (url.includes('jobs.dualoo.com') && /\b(spital affoltern|affoltern am albis)\b/i.test(String(job?.company || ''))) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'spitalaffoltern.ch' || host.endsWith('.spitalaffoltern.ch')) return true;
    if (host === 'jobs.dualoo.com') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse one Dualoo portal HTML page into a list of `{ url, title, location,
 * startDate }` rows.
 */
export function parseDualooPortal(portalId, html) {
  const out = [];
  const seen = new Set();
  // The `data-eventData` and `href` attributes appear in either order on the
  // <a class="jobElement"> tag — match each anchor block, then extract both
  // attributes from it separately.
  const anchorRe = /<a[^>]*class="[^"]*\bjobElement\b[^"]*"[^>]*>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const tag = m[0];
    const hrefMatch = tag.match(/\shref="([^"]+)"/);
    const evMatch = tag.match(/\sdata-eventData="([^"]+)"/);
    if (!hrefMatch || !evMatch) continue;
    const rel = hrefMatch[1];
    const evRaw = evMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    let meta = {};
    try { meta = JSON.parse(evRaw); } catch { meta = {}; }
    const title = normalizeSpace(decodeEntities(String(meta.jobName || '')));
    if (!title) continue;
    const url = `${DUALOO_BASE}/portal/${rel}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      portalId,
      title,
      location: normalizeSpace(decodeEntities(String(meta.location || ''))),
      startDate: normalizeSpace(decodeEntities(String(meta.startDate || ''))),
    });
  }
  return out;
}

async function fetchDetailDescription(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return '';
    // Dualoo detail pages render the offer text inside `<div id="container">`
    // (top-level wrapper) — drop chrome (back/apply buttons, footer, etc.) by
    // taking the inner body and stripping all anchors with class `back` /
    // `apply`. We're conservative: strip scripts/styles, then convert.
    const noScripts = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');
    const containerMatch = noScripts.match(/<div[^>]*id="container"[^>]*>([\s\S]*?)<\/div>\s*<script/i)
      || noScripts.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const block = containerMatch ? containerMatch[1] : noScripts;
    const text = htmlToText(block);
    return normalizeSpace(text).slice(0, 6000);
  } catch (err) {
    console.warn(`  ⚠️ Dualoo detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return '';
  }
}

function parsePostedDate() {
  return new Date().toISOString().slice(0, 10);
}

export async function fetchAllSpitalAffolternJobs() {
  console.log(`🏥 Fetching ${SPITAL_AFFOLTERN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${DUALOO_BASE}/portal/{${PORTAL_IDS.length} portal IDs}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  const allRows = [];
  for (const portalId of PORTAL_IDS) {
    try {
      const portalUrl = `${DUALOO_BASE}/portal/${portalId}`;
      const html = await fetchHtml(portalUrl);
      const rows = parseDualooPortal(portalId, html);
      console.log(`  ✓ ${portalId}: ${rows.length} jobs`);
      allRows.push(...rows);
    } catch (err) {
      console.warn(`  ⚠️ portal ${portalId} failed: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }
  // De-dupe: occasionally the same job is shown in multiple portals.
  const dedup = new Map();
  for (const r of allRows) if (!dedup.has(r.url)) dedup.set(r.url, r);
  const rows = Array.from(dedup.values());
  console.log(`\n  Total unique rows: ${rows.length}`);

  if (!rows.length) return [];

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((r2) => setTimeout(r2, DETAIL_DELAY_MS));
    const description = await fetchDetailDescription(r.url);
    const fallback = `${r.title} — Spital Affoltern AG, ${r.location || 'Affoltern am Albis'} (Start: ${r.startDate}).`;
    const safeDescription = description && description.split(/\s+/).length >= 30
      ? description
      : [fallback, description].filter(Boolean).join('\n\n');

    const cityRaw = (r.location || 'Affoltern am Albis').replace(/^.*-\s*/, '').trim();
    const sourceLang = detectLang(safeDescription || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${SPITAL_AFFOLTERN_KEY} ${cityRaw}`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${SPITAL_AFFOLTERN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_AFFOLTERN_COMPANY_NAME,
      companyKey: SPITAL_AFFOLTERN_KEY,
      companyDomain: SPITAL_AFFOLTERN_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: cityRaw,
      canton: 'ZH',
      url: r.url,
      source: `${SPITAL_AFFOLTERN_COMPANY_NAME} Dedicated Parser (Dualoo)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: cityRaw,
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8910',
      category: detectHealthcareCategory(r.title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(r.title),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: parsePostedDate(),
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${SPITAL_AFFOLTERN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { PUBLIC_CAREER_URL, DUALOO_BASE, PORTAL_IDS };
