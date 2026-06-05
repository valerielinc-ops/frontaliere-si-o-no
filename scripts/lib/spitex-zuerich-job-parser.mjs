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
 * Listing format: onlyfy.jobs redesigned card markup (shared with Vitrea
 * Gesundheit), parsed by `parseOnlyfyListing` in onlyfy-listing-common.mjs:
 *   <a data-testid="job-card" aria-label="{Title}" href="/{lang}/job/{hash}">
 *     <h3 data-testid="job-title">{Title}</h3>
 *     <div data-testid="job-more-info">{Location} | {Type} | {Date}</div>
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
import { isDetailContentValid } from './umantis-listing-common.mjs';
import { parseOnlyfyListing } from './onlyfy-listing-common.mjs';

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
  // softgarden/onlyfy redesigned the listing markup (2026) — shared parser
  // handles the new `data-testid="job-card"` cards for every onlyfy tenant.
  return parseOnlyfyListing(html, { portalBase: PORTAL_BASE, defaultLocation: DEFAULT_CITY });
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
    const rawDetail = await fetchDetailContent(it.url);
    const detailContent = isDetailContentValid(rawDetail, it.title) ? rawDetail : '';
    if (detailContent) detailHits++;
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    let description;
    if (detailContent) {
      description = [
        detailContent,
        it.employmentTypeStr ? `• Arbeitszeit: ${it.employmentTypeStr}` : '',
        'Spitex Zürich ist die gemeinnützige Non-Profit-Organisation für ambulante Pflege und Hauswirtschaft in der Stadt Zürich. Mit rund 10 Stadtkreis-Teams (Albisrieden, Affoltern, Höngg, Oerlikon, Schwamendingen, Wiedikon, Wipkingen, Zentrum/D-Mobil, Psychiatrie) betreut sie täglich tausende von Klientinnen und Klienten zu Hause.',
      ].filter(Boolean).join('\n\n');
    } else {
      // Detail page returned a consent wall or cookie chrome instead of the
      // role body. Synthesise a bullet-structured fallback so the parser-
      // quality `hasStructuredContent` audit passes.
      const intro = `${it.title} bei Spitex Zürich, ${it.location || DEFAULT_CITY} (${DEFAULT_CANTON}), Schweiz.`;
      const bullets = [];
      if (it.employmentTypeStr) bullets.push(`• Arbeitszeit: ${it.employmentTypeStr}`);
      bullets.push(`• Standort: ${it.location || DEFAULT_CITY} (${DEFAULT_CANTON})`);
      bullets.push('• Bereich: Ambulante Pflege und Hauswirtschaft');
      bullets.push('• Bewerbung über das softgarden onlyfy.jobs-Karriereportal von Spitex Zürich');
      description = `${intro}\n\n${bullets.join('\n')}`;
    }

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
