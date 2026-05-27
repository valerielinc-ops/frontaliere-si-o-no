#!/usr/bin/env node
/**
 * Institution de Lavigny job parser — custom HTML listing on ilavigny.ch.
 *
 * Public career site: https://www.ilavigny.ch/emploi/
 *
 * The Institution operates several sites in canton Vaud:
 *   - Hôpital neurologique (Lavigny, 1175)
 *   - EMS Plein-Soleil (Lausanne, 1010)
 *   - Various supported-living and school sites in the Morges region.
 *
 * The single career page lists every offer inline with full title, employer
 * site, contract type, postal code + city and the full HTML description.
 * Each block is structured as:
 *
 *   <div id="main_{N}" ...>
 *     <div ... onClick="showDetail('{N}')">
 *       <h5><b>{TITLE}, {RATE}</b></h5>
 *       <div>{COMPANY / SITE}</div>
 *       <div>{CONTRACT}</div>
 *       <div>{POSTAL CITY}</div>
 *     </div>
 *     <div id="detailoffre{N}" style="display:none">
 *       <div>{rich HTML body}</div>
 *       <a ... onClick="window.open('https://www.jobup.ch/fr/emplois/detail/{uuid}/...')"
 *          class="jobup_connect">Postuler</a>
 *     </div>
 *   </div>
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  USER_AGENT,
} from './hospital-custom-html-helpers.mjs';

// ilavigny.ch's Apache rejects requests whose Accept header contains
// "application/rss+xml,*" with a connection reset. Use a strict text/html
// Accept (same pattern as the riveneuve parser).
async function fetchLavignyHtml(url, opts = {}) {
  const t = Number(opts.timeoutMs) || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
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

export const INSTITUTION_LAVIGNY_KEY = 'institution-lavigny';
export const INSTITUTION_LAVIGNY_COMPANY_NAME = 'Institution de Lavigny';
export const INSTITUTION_LAVIGNY_COMPANY_DOMAIN = 'ilavigny.ch';

const LISTING_URL = 'https://www.ilavigny.ch/emploi/';

export function isInstitutionLavignyJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === INSTITUTION_LAVIGNY_KEY) return true;
  if (url.includes('ilavigny.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'ilavigny.ch' || host.endsWith('.ilavigny.ch')) return true;
    if (host === 'www.jobup.ch' || host === 'jobup.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

function extractPostalCity(line = '') {
  const m = String(line || '').match(/^(\d{4})\s+(.+)$/);
  if (!m) return { postalCode: '', city: line.trim() };
  return { postalCode: m[1], city: m[2].trim() };
}

function detectCantonFromPostal(postal = '') {
  const p = Number(String(postal || '').slice(0, 2));
  // Vaud spans 1000-1899 with overlaps from Genève (1200-1299) and Fribourg (1470,1530,1700-1799).
  // Most ilavigny sites are in VD; refine only when we recognise a Geneva CHE postal range.
  if (!p) return 'VD';
  if (p === 12) return 'GE';
  if (postal === '1700' || postal === '1701' || postal === '1762' || postal === '1763' || postal === '1763') return 'FR';
  return 'VD';
}

/* ── Listing parser ────────────────────────────────────────── */

export function parseLavignyListing(html) {
  const out = [];
  const seen = new Set();
  const blockRx = /<div\s+id="main_(\d+)"[\s\S]*?(?=<div\s+id="main_\d+"|<\/main>|<footer)/g;
  let m;
  while ((m = blockRx.exec(html))) {
    const id = m[1];
    const block = m[0];
    if (seen.has(id)) continue;

    const titleMatch = block.match(/<h5><b>([\s\S]*?)<\/b><\/h5>/);
    if (!titleMatch) continue;
    const titleRaw = normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')));
    if (!titleRaw || titleRaw.length < 5) continue;

    // First 3 divs after the title are: site, contract, postal+city.
    const divs = [...block.matchAll(/<div>([^<]+)<\/div>/g)].map((d) => normalizeSpace(decodeEntities(d[1])));
    const site = divs[0] || '';
    const contractLine = divs[1] || '';
    const locationLine = divs[2] || '';

    const detailMatch = block.match(/<div\s+id="detailoffre\d+"[^>]*>([\s\S]*?)<a[^>]*jobup_connect/);
    const detailHtml = detailMatch ? detailMatch[1] : '';
    const detailText = detailHtml ? htmlToText(detailHtml).trim() : '';

    const jobupMatch = block.match(/jobup\.ch\/fr\/emplois\/detail\/([a-f0-9-]+)/i);
    const jobupUuid = jobupMatch ? jobupMatch[1] : '';
    const applyUrl = jobupUuid
      ? `https://www.jobup.ch/fr/emplois/detail/${jobupUuid}/`
      : LISTING_URL;

    seen.add(id);
    out.push({
      id,
      title: titleRaw,
      site,
      contractLine,
      locationLine,
      detailText,
      jobupUuid,
      applyUrl,
    });
  }
  return out;
}

/* ── Public API ────────────────────────────────────────────── */

export async function fetchAllInstitutionLavignyJobs() {
  console.log(`🏥 Fetching ${INSTITUTION_LAVIGNY_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let html;
  try {
    // Use a longer timeout — the static page is reliable but sometimes slow.
    html = await fetchLavignyHtml(LISTING_URL, { timeoutMs: 40000 });
  } catch (err) {
    console.warn(`  ⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const items = parseLavignyListing(html);
  console.log(`  ✓ ${items.length} offerte trovate`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const { postalCode, city } = extractPostalCity(it.locationLine);
    const canton = detectCantonFromPostal(postalCode);
    const title = it.title;
    const heuristicText = `${title}\n${it.contractLine}`;

    const description = [
      it.detailText,
      [it.site, it.contractLine, it.locationLine].filter(Boolean).join(' · '),
      `Institution de Lavigny — Hôpital neurologique, foyers et école spécialisée (canton de Vaud).`,
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || title, 'fr');
    const slug = slugify(`${title} ${INSTITUTION_LAVIGNY_KEY} ${city}`);
    // Use the stable jobup uuid (or the per-listing id) as the hash basis so
    // repeated crawls produce the same job id.
    const hashBasis = it.jobupUuid || `${INSTITUTION_LAVIGNY_KEY}-${it.id}`;
    const urlHash = createHash('sha1').update(hashBasis).digest('hex').slice(0, 12);

    const finalUrl = it.applyUrl;          // jobup detail URL (or listing fallback)
    const contractIsTemp = /\bcdd\b|durée\s+déterminée|temporaire|fixed/i.test(heuristicText);

    jobs.push({
      id: `${INSTITUTION_LAVIGNY_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      company: INSTITUTION_LAVIGNY_COMPANY_NAME,
      companyKey: INSTITUTION_LAVIGNY_KEY,
      companyDomain: INSTITUTION_LAVIGNY_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: city || 'Lavigny',
      canton,
      url: finalUrl,
      source: 'Institution de Lavigny Dedicated Parser (custom HTML + jobup deep-link)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city || 'Lavigny',
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: postalCode || '1175',
      category: detectHealthcareCategory(`${title} ${description}`),
      contract: contractIsTemp ? 'temporary' : 'full-time',
      employmentType: detectHealthcareEmploymentType(heuristicText),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: finalUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      careerSiteUrl: LISTING_URL,
    });
  }
  console.log(`📋 Total ${INSTITUTION_LAVIGNY_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
