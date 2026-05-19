#!/usr/bin/env node
/**
 * Klinik Schloss Mammern (TG) job parser — WordPress + Elementor on `ksm-jobs.ch`.
 *
 * Public career site: https://ksm-jobs.ch/
 *   → individual jobs at /job/{slug}/
 *
 * The WP REST API for the `job` CPT is locked down (401); however, the
 * AIOSEO `/jobs-sitemap.xml` exposes the full list of canonical job URLs.
 * Detail pages are rendered with Elementor — the job body lives between the
 * "Das Aufgabengebiet:" / "Aufgabengebiet:" intro and the in-page benefits
 * block ("Deine Benefits"), which we use as the stop marker.
 *
 * Klinik Schloss Mammern AG is a 440-employee 5-discipline rehabilitation
 * clinic on Lake Constance (Mammern, 8265, canton TG). Family-owned since
 * 1889. ~14 open positions at parser creation, all German-language.
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

export const KLINIK_SCHLOSS_MAMMERN_KEY = 'klinik-schloss-mammern';
export const KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME = 'Klinik Schloss Mammern';
export const KLINIK_SCHLOSS_MAMMERN_COMPANY_DOMAIN = 'klinik-schloss-mammern.ch';

const SITEMAP_URL = 'https://ksm-jobs.ch/jobs-sitemap.xml';
const PUBLIC_CAREER_URL = 'https://ksm-jobs.ch/';

export function isKlinikSchlossMammernJob(job) {
  if (job?.companyKey === KLINIK_SCHLOSS_MAMMERN_KEY) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('ksm-jobs.ch') || url.includes('klinik-schloss-mammern.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ksm-jobs.ch'
      || host.endsWith('.ksm-jobs.ch')
      || host === 'klinik-schloss-mammern.ch'
      || host.endsWith('.klinik-schloss-mammern.ch');
  } catch {
    return false;
  }
}

/**
 * Slugs of evergreen marketing pages exposed in the jobs sitemap that are not
 * real openings (talent pool teaser, generic apprenticeship landing pages…).
 */
const EVERGREEN_SLUGS = new Set([
  'talentierte-fachkraefte',
]);

/** Parse the AIOSEO sitemap → array of canonical job URLs. */
export function parseJobsSitemap(xml = '') {
  const out = [];
  const seen = new Set();
  const rx = /<loc>\s*<!\[CDATA\[([^\]]+)\]\]>\s*<\/loc>/g;
  let m;
  while ((m = rx.exec(xml))) {
    const url = m[1].trim();
    if (!/\/job\/[^/]+\/?$/.test(url)) continue;
    if (seen.has(url)) continue;
    const slug = url.replace(/\/$/, '').split('/').pop();
    if (EVERGREEN_SLUGS.has(slug)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Extract title + description from a KSM detail page.
 * Title = first `<h1 class="elementor-heading-title">…</h1>`.
 * Description = text between "Aufgabengebiet" intro and the benefits/footer
 * sections ("Deine Benefits", "Job-Newsletter", "Impressum").
 */
export function extractKsmDetail(html = '') {
  if (!html) return { title: '', description: '' };

  // Title from the first elementor heading
  const h1 = html.match(/<h1\s+class="elementor-heading-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1 ? normalizeSpace(decodeEntities(h1[1].replace(/<[^>]+>/g, ' '))) : '';

  // Convert body to lines
  const txt = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ');
  const lines = decodeEntities(txt)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const startMarkers = /^(?:Das\s+)?Aufgabengebiet|^Deine Aufgaben|^Ihre Aufgaben|^Aufgaben\s*:/i;
  const stopMarkers = /^Deine Benefits$|^Unser Job-Newsletter|^Impressum\s*\||^Datenschutz\s*\||^Bewerbungsschluss|^Jetzt bewerben$|^Du hast Fragen/i;

  const startIdx = lines.findIndex((l) => startMarkers.test(l));
  if (startIdx < 0) {
    // Fallback: just take the first 30 non-empty lines after the H1.
    return { title, description: lines.slice(0, 30).join('\n') };
  }
  const stopIdx = lines.findIndex((l, i) => i > startIdx && stopMarkers.test(l));
  const slice = lines.slice(startIdx, stopIdx > 0 ? stopIdx : Math.min(lines.length, startIdx + 80));
  const description = slice.join('\n')
    // Collapse the bullet character that the line splitter leaves behind.
    .replace(/^•\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, description };
}

export async function fetchAllKlinikSchlossMammernJobs() {
  console.log(`🏥 Fetching ${KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME} jobs`);
  console.log(`   Sitemap: ${SITEMAP_URL}`);
  console.log(`   Public:  ${PUBLIC_CAREER_URL}\n`);

  const xml = await fetchHtml(SITEMAP_URL);
  const urls = parseJobsSitemap(xml);
  console.log(`  ✓ ${urls.length} job URLs in sitemap`);
  if (!urls.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;

  for (const detailUrl of urls) {
    let title = '';
    let description = '';
    // The sitemap emits already-decoded URLs (raw `+`, accented characters);
    // for fetch we URL-encode the unsafe characters (only `+`, accents, etc.)
    // *before* the URL constructor has a chance to re-encode them. We work
    // on the raw string with a targeted encode pass.
    const fetchUrl = detailUrl
      .replace(/\+/g, '%2B')
      .replace(/[ÄÖÜäöüß]/g, (c) => encodeURIComponent(c));
    try {
      const detailHtml = await fetchHtml(fetchUrl);
      const d = extractKsmDetail(detailHtml);
      title = d.title;
      description = d.description;
      if (description) detailHits++;
    } catch (err) {
      console.log(`     ⚠ detail fetch failed for ${detailUrl}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));

    if (!title) {
      // Derive a title from the slug as a last resort.
      const slugFromUrl = detailUrl.replace(/\/$/, '').split('/').pop() || '';
      title = slugFromUrl.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    if (!description) {
      description = `${title} — ${KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME}, Mammern (TG). Privatklinik für Rehabilitation am Untersee, seit 1889 im Familienbesitz.`;
    }

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${KLINIK_SCHLOSS_MAMMERN_KEY} mammern`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${KLINIK_SCHLOSS_MAMMERN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME,
      companyKey: KLINIK_SCHLOSS_MAMMERN_KEY,
      companyDomain: KLINIK_SCHLOSS_MAMMERN_COMPANY_DOMAIN,
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
      location: 'Mammern',
      canton: 'TG',
      url: detailUrl,
      source: `${KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME} Dedicated Parser (WordPress sitemap + Elementor detail)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Mammern',
      addressRegion: 'TG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8265',
      category: detectHealthcareCategory(title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${urls.length} with rich detail content)`);
  return jobs;
}

export { PUBLIC_CAREER_URL, SITEMAP_URL };
