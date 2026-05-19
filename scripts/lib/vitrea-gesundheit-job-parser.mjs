#!/usr/bin/env node
/**
 * Vitrea Gesundheit (formerly VAMED Schweiz) job parser.
 *
 * Public career site: https://www.vitrea-gesundheit.ch/karriere
 *                   → https://vamed-ag-ch.onlyfy.jobs/ (softgarden onlyfy.jobs)
 *
 * Vitrea Gesundheit operates several Swiss rehab/care facilities including
 * Rehaklinik Seewis (covered separately via Rehaklinik Seewis parser?).
 * The onlyfy.jobs portal aggregates listings server-side as HTML rows with
 * `<strong class="job-title"><a href="/job/{hash}">{TITLE}</a></strong>`
 * plus an `icon-map-marker` location line and `icon-time` employment type.
 *
 * Detail pages live at `https://vamed-ag-ch.onlyfy.jobs/job/{hash}` and
 * carry rich description sections (Aufgaben/Profil/Wir bieten).
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

export const VITREA_GESUNDHEIT_KEY = 'vitrea-gesundheit';
export const VITREA_GESUNDHEIT_COMPANY_NAME = 'Vitrea Gesundheit';
export const VITREA_GESUNDHEIT_COMPANY_DOMAIN = 'vitrea-gesundheit.ch';

const PORTAL_BASE = 'https://vamed-ag-ch.onlyfy.jobs';
const LISTING_URL = `${PORTAL_BASE}/`;
const POLITE_DELAY_MS = 250;

export function isVitreaGesundheitJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === VITREA_GESUNDHEIT_KEY
    || url.includes('vitrea-gesundheit.ch')
    || url.includes('vamed-ag-ch.onlyfy.jobs');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'vitrea-gesundheit.ch'
      || host.endsWith('.vitrea-gesundheit.ch')
      || host === 'vamed-ag-ch.onlyfy.jobs';
  } catch {
    return false;
  }
}

export function parseVitreaListing(html) {
  const out = [];
  const seen = new Set();
  // Match `<strong class="job-title"> <a href="/job/{hash}">{TITLE}</a>`
  const rx = /<strong class="job-title">\s*<a\s+href="(\/job\/[a-z0-9]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = rx.exec(html))) {
    const path = m[1];
    const title = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 5) continue;
    const url = `${PORTAL_BASE}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    // Capture the location and employment-type lines that follow the title row
    const followIdx = m.index + m[0].length;
    const window = html.slice(followIdx, followIdx + 1200);
    const locMatch = window.match(/icon-map-marker[\s\S]*?>\s*([^<]+?)\s*</);
    const typeMatch = window.match(/icon-time[\s\S]*?>\s*([^<]+?)\s*</);
    const location = locMatch ? normalizeSpace(decodeEntities(locMatch[1])) : 'Schweiz';
    const employmentTypeStr = typeMatch ? normalizeSpace(decodeEntities(typeMatch[1])) : '';
    out.push({ url, title, location, employmentTypeStr });
  }
  return out;
}

async function fetchDetailContent(url) {
  try {
    const html = await fetchHtml(url);
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');
    const parts = [];
    const proseRx = /<(p|li|h[2-6])[^>]*>([\s\S]*?)<\/\1>/g;
    let pm;
    while ((pm = proseRx.exec(stripped))) {
      const text = normalizeSpace(decodeEntities(pm[2].replace(/<[^>]+>/g, ' ')));
      if (!text || text.length < 12) continue;
      if (/cookie|privacy|impressum|datenschutz/i.test(text.slice(0, 40))) continue;
      parts.push(pm[1].match(/^li$/i) ? `• ${text}` : text);
    }
    return parts.slice(0, 30).join('\n');
  } catch {
    return '';
  }
}

function inferCantonFromLocation(loc) {
  const l = String(loc).toLowerCase();
  if (/seewis|davos|chur|graubünden|grigioni/.test(l)) return 'GR';
  if (/zürich|zurich/.test(l)) return 'ZH';
  if (/bern\b|berne/.test(l)) return 'BE';
  if (/luzern|lucerne/.test(l)) return 'LU';
  if (/basel|basilea/.test(l)) return 'BS';
  if (/aargau|argovia/.test(l)) return 'AG';
  if (/wallis|valais/.test(l)) return 'VS';
  if (/tessin|ticino/.test(l)) return 'TI';
  if (/sankt|st\.\s*gallen|san gallo/.test(l)) return 'SG';
  return 'GR'; // Vitrea HQ Rehaklinik Seewis is GR
}

export async function fetchAllVitreaGesundheitJobs() {
  console.log(`🏥 Fetching ${VITREA_GESUNDHEIT_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseVitreaListing(html);
  console.log(`  ✓ ${items.length} jobs from softgarden onlyfy listing`);
  if (!items.length) return [];
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const it of items) {
    const detailContent = await fetchDetailContent(it.url);
    if (detailContent) detailHits++;
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    const description = [
      detailContent,
      it.employmentTypeStr ? `Arbeitszeit: ${it.employmentTypeStr}` : '',
      'Vitrea Gesundheit (ehemals VAMED Schweiz) — Rehabilitations- und Pflegedienstleister mit mehreren Standorten in der Schweiz, u.a. Rehaklinik Seewis GR.',
    ].filter(Boolean).join('\n\n');

    const canton = inferCantonFromLocation(it.location);
    const sourceLang = detectLang(description || it.title, 'de');
    const jobSlug = slugify(`${it.title} ${VITREA_GESUNDHEIT_KEY} ${it.location}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${VITREA_GESUNDHEIT_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VITREA_GESUNDHEIT_COMPANY_NAME,
      companyKey: VITREA_GESUNDHEIT_KEY,
      companyDomain: VITREA_GESUNDHEIT_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, `translate-pending.yml` picks the job up.
      needsRetranslation: true,
      location: it.location,
      canton,
      url: it.url,
      source: 'Vitrea Gesundheit Dedicated Parser (softgarden onlyfy.jobs)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: it.location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '',
      category: detectHealthcareCategory(it.title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(it.employmentTypeStr + ' ' + it.title),
      experienceLevel: detectHealthcareExperienceLevel(it.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${VITREA_GESUNDHEIT_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}
