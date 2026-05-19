#!/usr/bin/env node
/**
 * Spitex Zürich job parser — softgarden onlyfy.jobs.
 *
 * Spitex Zürich is the non-profit home-care provider for the city of Zürich,
 * operating ~10 neighborhood teams (Albisrieden, Affoltern, Höngg, Oerlikon,
 * Schwamendingen, Wiedikon, Wipkingen, Zentrum/D-Mobil, Psychiatrie). One of
 * the largest Swiss spitex services with several hundred nursing and FaGe
 * staff. Funded by the City of Zürich + cantonal Krankenkasse contracts.
 *
 * Public career site:
 *   https://www.spitex-zuerich.ch/jobs    (corporate)
 *   https://spitex-zuerich.onlyfy.jobs/   (onlyfy portal, server-rendered HTML)
 *
 * Listing format: same softgarden HTML as Vitrea Gesundheit
 *   <strong class="job-title"><a href="/job/{hash}">Title</a></strong>
 *   followed by `<i class="icon-map-marker">Location</i>` and
 *   `<i class="icon-time">Employment type</i>` cells.
 *
 * Detail page: rich `<p>/<li>/<h2-6>` content blocks describing the role.
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

export const SPITEX_ZUERICH_KEY = 'spitex-zuerich';
export const SPITEX_ZUERICH_COMPANY_NAME = 'Spitex Zürich';
export const SPITEX_ZUERICH_COMPANY_DOMAIN = 'spitex-zuerich.ch';

const PORTAL_BASE = 'https://spitex-zuerich.onlyfy.jobs';
const LISTING_URL = `${PORTAL_BASE}/`;
const POLITE_DELAY_MS = 250;
const DEFAULT_CITY = 'Zürich';
const DEFAULT_CANTON = 'ZH';
const DEFAULT_POSTAL = '8000';

export function isSpitexZuerichJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  return (
    key === SPITEX_ZUERICH_KEY ||
    url.includes('spitex-zuerich.ch') ||
    url.includes('spitex-zuerich.onlyfy.jobs') ||
    (company.includes('spitex') && company.includes('z') && company.includes('rich'))
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'spitex-zuerich.ch'
      || host.endsWith('.spitex-zuerich.ch')
      || host === 'spitex-zuerich.onlyfy.jobs';
  } catch {
    return false;
  }
}

export function parseSpitexZuerichListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /<strong class="job-title">\s*<a\s+href="(\/job\/[a-z0-9]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = rx.exec(html))) {
    const path = m[1];
    const title = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 5) continue;
    const url = `${PORTAL_BASE}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const followIdx = m.index + m[0].length;
    const window = html.slice(followIdx, followIdx + 1200);
    const locMatch = window.match(/icon-map-marker[\s\S]*?>\s*([^<]+?)\s*</);
    const typeMatch = window.match(/icon-time[\s\S]*?>\s*([^<]+?)\s*</);
    const location = locMatch ? normalizeSpace(decodeEntities(locMatch[1])) : DEFAULT_CITY;
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

export async function fetchAllSpitexZuerichJobs() {
  console.log(`🏠 Fetching ${SPITEX_ZUERICH_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);
  let html;
  try {
    html = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Spitex Zürich listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const items = parseSpitexZuerichListing(html);
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
      'Spitex Zürich ist die gemeinnützige Non-Profit-Organisation für ambulante Pflege und Hauswirtschaft in der Stadt Zürich. Mit rund 10 Stadtkreis-Teams (Albisrieden, Affoltern, Höngg, Oerlikon, Schwamendingen, Wiedikon, Wipkingen, Zentrum/D-Mobil, Psychiatrie) betreut sie täglich tausende von Klientinnen und Klienten zu Hause.',
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || it.title, 'de');
    const jobSlug = slugify(`${it.title} ${SPITEX_ZUERICH_KEY} ${it.location}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${SPITEX_ZUERICH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITEX_ZUERICH_COMPANY_NAME,
      companyKey: SPITEX_ZUERICH_KEY,
      companyDomain: SPITEX_ZUERICH_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship source-locale-only; AI step clears this flag
      // once it fills the 3 remaining locales, otherwise translate-pending
      // picks them up.
      needsRetranslation: true,
      location: it.location || DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: it.url,
      source: 'Spitex Zürich Dedicated Parser (softgarden onlyfy.jobs)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: it.location || DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL,
      category: detectHealthcareCategory(it.title),
      contract: detectHealthcareEmploymentType(it.employmentTypeStr + ' ' + it.title) === 'PART_TIME'
        ? 'part-time'
        : 'full-time',
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
  console.log(`📋 Total ${SPITEX_ZUERICH_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}
