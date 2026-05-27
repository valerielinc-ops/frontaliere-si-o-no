#!/usr/bin/env node
/**
 * Clinique CIC — private surgical group operating two Romandie clinics:
 *   - Clinique CIC Saxon (1907 Saxon, VS) — flagship hospitalised surgery
 *   - Clinique CIC Clarens (1815 Clarens, Montreux, VD) — ambulatory surgery
 *
 * Public corporate site: https://www.cliniquecic-saxon.ch/fr/emplois
 *   The careers page embeds a jobup.ch "company mask" iframe:
 *     https://www.jobup.ch/masks/clinique-cic/list_clinique-cic.asp
 *
 * The mask returns server-rendered HTML (charset = iso-8859-1, no JSON
 * variant) where each row is structured as:
 *
 *   <div class=job_offer>
 *     <a href="https://www.jobup.ch/fr/emplois/detail/{uuid}/"
 *        title="{TITLE} - {ZIP} {CITY} [/ {ZIP2} {CITY2}]" target=_blank>{TITLE_UC}</a>
 *   </div>
 *   <div class=job_location …>Clinique CIC {Site}</div>
 *   <div class=job_lvlmin …>{CONTRACT} / {OCCUPATION}%</div>
 *
 * The full job detail lives on the public jobup.ch page (we keep that as
 * the canonical `url`). We DROP "Offres spontanées" placeholders because
 * they are not real openings.
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

export const CIC_KEY = 'clinique-cic';
export const CIC_COMPANY_NAME = 'Clinique CIC (Saxon & Clarens)';
export const CIC_COMPANY_DOMAIN = 'cliniquecic-saxon.ch';

const MASK_URL = 'https://www.jobup.ch/masks/clinique-cic/list_clinique-cic.asp';
const PUBLIC_CAREER_URL = 'https://www.cliniquecic-saxon.ch/fr/emplois';
const DETAIL_DELAY_MS = 250;

export function isCicJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === CIC_KEY) return true;
  if (url.includes('cliniquecic-saxon.ch') || url.includes('cliniquecic.ch')) return true;
  if (url.includes('jobup.ch') && /clinique[\s-]?cic/i.test(String(job?.company || ''))) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'cliniquecic-saxon.ch' || host.endsWith('.cliniquecic-saxon.ch')) return true;
    if (host === 'cliniquecic.ch' || host.endsWith('.cliniquecic.ch')) return true;
    if (host === 'jobup.ch' || host === 'www.jobup.ch') return true;
    return false;
  } catch {
    return false;
  }
}

async function fetchMaskHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT
          || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    // The mask returns iso-8859-1 — decode explicitly so accented chars
    // (è, é, à, …) render correctly downstream.
    const buf = await res.arrayBuffer();
    return new TextDecoder('iso-8859-1').decode(buf);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse the jobup mask HTML into a list of rows. Each row is one offer
 * with its jobup.ch detail URL, title, originating CIC site, contract and
 * occupation rate.
 */
export function parseMaskHtml(html) {
  const out = [];
  const seen = new Set();
  // Each offer is a sequence of three sibling <div>s. Match the anchor in
  // div.job_offer plus the next two info divs (location + lvlmin).
  const re = /<div\s+class=job_offer>\s*<a[^>]*href="([^"]+)"[^>]*title="([^"]+)"[^>]*>([^<]+)<\/a>\s*<\/div>\s*<div\s+class=job_location[^>]*>([^<]+)<\/div>\s*<div\s+class=job_lvlmin[^>]*>([^<]+)<\/div>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = normalizeSpace(decodeEntities(m[1]));
    const titleFull = normalizeSpace(decodeEntities(m[2]));
    const titleUc = normalizeSpace(decodeEntities(m[3]));
    const site = normalizeSpace(decodeEntities(m[4]));
    const lvl = normalizeSpace(decodeEntities(m[5]));
    if (!url || !titleFull || seen.has(url)) continue;
    // Drop spontaneous-application placeholders
    if (/offres?\s+spontan/i.test(titleFull)) continue;
    seen.add(url);
    // Title before " - " is the real job name (the suffix is "1907 Saxon" or
    // "1815 Clarens / 1907 Saxon"); keep proper case from `titleFull`.
    const titleClean = titleFull.split(/\s+-\s+\d{4}/)[0].trim() || titleUc;
    out.push({ url, title: titleClean, site, contract: lvl });
  }
  return out;
}

function inferLocalityFromSite(site = '', titleFull = '') {
  const s = `${site} ${titleFull}`.toLowerCase();
  if (/clarens|montreux|1815/.test(s)) return { city: 'Clarens', postalCode: '1815', canton: 'VD' };
  if (/saxon|1907/.test(s)) return { city: 'Saxon', postalCode: '1907', canton: 'VS' };
  return { city: 'Saxon', postalCode: '1907', canton: 'VS' };
}

async function fetchDetailDescription(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return '';
    // jobup.ch detail pages render the description inside a JSON-LD
    // schema.org/JobPosting block — prefer that for clean text. Fall back
    // to a generic main-content extraction.
    const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try {
        const data = JSON.parse(ldMatch[1]);
        const desc = Array.isArray(data) ? data.find((d) => d['@type'] === 'JobPosting')?.description : data.description;
        if (desc && typeof desc === 'string') {
          return normalizeSpace(htmlToText(desc)).slice(0, 6000);
        }
      } catch { /* swallow JSON parse */ }
    }
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) return normalizeSpace(htmlToText(mainMatch[1])).slice(0, 6000);
    return '';
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return '';
  }
}

export async function fetchAllCicJobs() {
  console.log(`🏥 Fetching ${CIC_COMPANY_NAME} jobs`);
  console.log(`   Mask: ${MASK_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  let html;
  try {
    html = await fetchMaskHtml(MASK_URL);
  } catch (err) {
    console.warn(`⚠️ Mask fetch failed: ${err?.message || err}`);
    return [];
  }
  const rows = parseMaskHtml(html);
  console.log(`  ✓ ${rows.length} real openings (spontaneous-application rows dropped)`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const description = await fetchDetailDescription(r.url);
    const loc = inferLocalityFromSite(r.site, r.title);
    const fallback = `${r.title} chez ${r.site || CIC_COMPANY_NAME}, ${loc.city} (${loc.canton}). Contrat: ${r.contract || 'permanent'}.`;
    const safeDescription = description && description.split(/\s+/).length >= 30
      ? description
      : [fallback, description].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(safeDescription || r.title, 'fr');
    const jobSlug = slugify(`${r.title} ${CIC_KEY} ${loc.city}`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${CIC_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: r.site || CIC_COMPANY_NAME,
      companyKey: CIC_KEY,
      companyDomain: CIC_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: loc.city,
      canton: loc.canton,
      url: r.url,
      source: `${CIC_COMPANY_NAME} Dedicated Parser (jobup.ch mask)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: loc.city,
      addressRegion: loc.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postalCode,
      category: detectHealthcareCategory(`${r.title} ${safeDescription.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*-\s*\d{2,3}\s*%\b/.test(r.contract)
        ? 'part-time'
        : (/\b100\s*%/.test(r.contract) ? 'full-time' : 'full-time'),
      employmentType: detectHealthcareEmploymentType(`${r.title} ${r.contract}`),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${CIC_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { MASK_URL, PUBLIC_CAREER_URL };
