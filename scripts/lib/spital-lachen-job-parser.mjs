#!/usr/bin/env node
/**
 * Spital Lachen (SZ) job parser — WordPress custom post type `dcwi_jobs`.
 *
 * Public career site: https://spital-lachen.ch/jobs-karriere/offene-stellen/
 *   → individual jobs at /jobs-karriere/offene-stellen/{slug}/
 *
 * The WP REST API exposes the listing but with empty content/excerpt fields:
 *   https://spital-lachen.ch/wp-json/wp/v2/dcwi_jobs?per_page=100
 *
 * Detail pages are rendered with the Elementor `dcwi-accordions` widget — each
 * job section ("Ihre Aufgaben", "Ihr Profil", "Wir bieten") lives inside an
 * `accordion__title` + `accordion__content` pair.
 *
 * Spital Lachen AG is a regional acute hospital at the upper end of Lake
 * Zurich (canton SZ, postal 8853). ~27 open positions at parser creation,
 * majority nursing/medical, all German-language.
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

export const SPITAL_LACHEN_KEY = 'spital-lachen';
export const SPITAL_LACHEN_COMPANY_NAME = 'Spital Lachen';
export const SPITAL_LACHEN_COMPANY_DOMAIN = 'spital-lachen.ch';

const REST_LISTING_URL = 'https://spital-lachen.ch/wp-json/wp/v2/dcwi_jobs?per_page=100&_fields=id,slug,link,title,date,modified,unternehmensbereich';
const PUBLIC_CAREER_URL = 'https://spital-lachen.ch/jobs-karriere/offene-stellen/';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

async function fetchJson(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
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

export function isSpitalLachenJob(job) {
  if (job?.companyKey === SPITAL_LACHEN_KEY) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('spital-lachen.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'spital-lachen.ch' || host.endsWith('.spital-lachen.ch');
  } catch {
    return false;
  }
}

/**
 * Extract accordion sections from the Elementor `dcwi-accordions` widget.
 * Each section pair is:
 *   <h3 class="accordion__title text-medium">{LABEL}</h3>
 *   …surrounding wrapping divs…
 *   <div class="accordion__content">{HTML}</div>
 *
 * We pair each title with the following `accordion__content` block.
 */
export function extractAccordionSections(html = '') {
  const out = [];
  // Iterate title positions, then for each title find the next accordion__content.
  const titleRx = /<h3\s+class="accordion__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/g;
  const contentRx = /<div\s+class="accordion__content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  const titles = [...html.matchAll(titleRx)];
  const contents = [...html.matchAll(contentRx)];
  // Pair by source order (titles & contents alternate).
  const n = Math.min(titles.length, contents.length);
  for (let i = 0; i < n; i++) {
    const label = normalizeSpace(decodeEntities(titles[i][1].replace(/<[^>]+>/g, ' ')));
    const raw = contents[i][1];
    const text = normalizeSpace(decodeEntities(
      raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li>/gi, '')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, ' '),
    )).replace(/\s*•\s*/g, '\n• ');
    if (!label || !text || text.length < 5) continue;
    out.push({ label, text });
  }
  return out;
}

/**
 * Fetch one detail page and build the job description string.
 */
async function fetchDetail(link) {
  let html;
  try {
    html = await fetchHtml(link);
  } catch (err) {
    console.log(`     ⚠ detail fetch failed for ${link}: ${err.message}`);
    return { description: '', tagline: '' };
  }
  const sections = extractAccordionSections(html);
  // Tagline = `hero__description` short text (e.g. "Tagesklinik").
  const tag = html.match(/<p\s+class="hero__description[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const tagline = tag ? normalizeSpace(decodeEntities(tag[1].replace(/<[^>]+>/g, ' '))) : '';
  const desc = sections.map((s) => `${s.label}:\n${s.text}`).join('\n\n');
  return { description: desc, tagline };
}

export async function fetchAllSpitalLachenJobs() {
  console.log(`🏥 Fetching ${SPITAL_LACHEN_COMPANY_NAME} jobs`);
  console.log(`   REST listing: ${REST_LISTING_URL}`);
  console.log(`   Public:       ${PUBLIC_CAREER_URL}\n`);

  const data = await fetchJson(REST_LISTING_URL);
  if (!Array.isArray(data)) {
    console.log('  ⚠ Unexpected REST response (not an array)');
    return [];
  }
  console.log(`  ✓ ${data.length} jobs from REST listing`);
  if (!data.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;

  for (const item of data) {
    const title = normalizeSpace(decodeEntities(String(item?.title?.rendered || '')));
    if (!title || title.length < 3) continue;
    const link = normalizeSpace(String(item?.link || ''));
    if (!link) continue;

    const { description: detailDesc, tagline } = await fetchDetail(link);
    if (detailDesc) detailHits++;
    await new Promise((r) => setTimeout(r, 200));

    const desc = [tagline, detailDesc].filter(Boolean).join('\n\n')
      || `${title} — ${SPITAL_LACHEN_COMPANY_NAME}, Lachen (SZ).`;

    const sourceLang = detectLang(desc || title, 'de');
    const jobSlug = slugify(`${title} ${SPITAL_LACHEN_KEY} lachen`);
    const urlHash = createHash('sha1').update(link).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const raw = item?.date || item?.modified || '';
      const d = new Date(String(raw));
      return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : todayIso;
    })();

    jobs.push({
      id: `${SPITAL_LACHEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_LACHEN_COMPANY_NAME,
      companyKey: SPITAL_LACHEN_KEY,
      companyDomain: SPITAL_LACHEN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Lachen',
      canton: 'SZ',
      url: link,
      source: `${SPITAL_LACHEN_COMPANY_NAME} Dedicated Parser (WordPress dcwi_jobs CPT)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Lachen',
      addressRegion: 'SZ',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8853',
      category: detectHealthcareCategory(title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: link,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${SPITAL_LACHEN_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${data.length} with detail content)`);
  return jobs;
}

export { PUBLIC_CAREER_URL, REST_LISTING_URL };
