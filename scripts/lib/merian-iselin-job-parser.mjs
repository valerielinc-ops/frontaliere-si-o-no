#!/usr/bin/env node
/**
 * Merian Iselin Klinik Basel job parser.
 *
 * Public career site: https://merianiselin.ch/klinik/jobs/offene-stellen
 *
 * Private surgical hospital in Basel (~700 staff, focus on orthopaedics +
 * gynaecology). Static HTML listing with `<li class="jobs-list__item">`
 * cards; each links to a detail page at
 * `/klinik/jobs/offene-stellen/jobs/{uuid}`.
 *
 * Card structure:
 *   <li class="jobs-list__item">
 *     <a href=".../jobs/{uuid}" class="jobs-list__link">
 *       <span>{TITLE}</span>
 *       <span class="jobs-list__type">{TYPE}</span>     (e.g. Festanstellung, Ausbildung)
 *       <span class="jobs-list__range">{PERCENT}</span> (e.g. 80%-100%)
 *     </a>
 *   </li>
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

export const MERIAN_ISELIN_KEY = 'merian-iselin';
export const MERIAN_ISELIN_COMPANY_NAME = 'Merian Iselin Klinik';
export const MERIAN_ISELIN_COMPANY_DOMAIN = 'merianiselin.ch';

const LISTING_URL = 'https://merianiselin.ch/klinik/jobs/offene-stellen';

export function isMerianIselinJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === MERIAN_ISELIN_KEY || url.includes('merianiselin.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'merianiselin.ch' || host.endsWith('.merianiselin.ch');
  } catch {
    return false;
  }
}

export function parseMerianListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /<li class="jobs-list__item">[\s\S]*?<a href="([^"]+\/jobs\/([a-f0-9-]{36}))" class="jobs-list__link">([\s\S]*?)<\/a>\s*<\/li>/g;
  let m;
  while ((m = rx.exec(html))) {
    const url = m[1];
    const uuid = m[2];
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const innerHtml = m[3];
    // Extract spans inside link-content
    const spans = innerHtml.match(/<span[^>]*>[\s\S]*?<\/span>/g) || [];
    const texts = spans.map((s) => normalizeSpace(decodeEntities(s.replace(/<[^>]+>/g, ''))));
    const title = texts.find((t) => t && t.length > 5 && !/^\d{2,3}%/.test(t) && !/^(Festanstellung|Ausbildung|Praktikum|Aushilfe|Lehrstelle)$/i.test(t)) || '';
    const type = texts.find((t) => /^(Festanstellung|Ausbildung|Praktikum|Aushilfe|Lehrstelle|Temporär)$/i.test(t)) || '';
    const range = texts.find((t) => /\d{2,3}%/.test(t)) || '';
    if (!title) continue;
    out.push({ uuid, url, title, type, range });
  }
  return out;
}

async function fetchDetailContent(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    // Extract main content sections (Aufgaben/Anforderungen-style)
    const strip = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');
    const parts = [];
    const proseRx = /<(p|li|h[2-6])[^>]*>([\s\S]*?)<\/\1>/g;
    let pm;
    while ((pm = proseRx.exec(strip))) {
      const text = normalizeSpace(decodeEntities(pm[2].replace(/<[^>]+>/g, ' ')));
      if (!text || text.length < 12) continue;
      if (/cookie|privacy|impressum|telefon|fax\s*\+/i.test(text.slice(0, 30))) continue;
      parts.push(pm[1].match(/^li$/i) ? `• ${text}` : text);
    }
    return parts.slice(0, 30).join('\n');
  } catch {
    return '';
  }
}

export async function fetchAllMerianIselinJobs() {
  console.log(`🏥 Fetching ${MERIAN_ISELIN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseMerianListing(html);
  console.log(`  ✓ ${items.length} job cards parsed`);
  if (!items.length) return [];
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const it of items) {
    const detailContent = await fetchDetailContent(it.url);
    if (detailContent) detailHits++;
    await new Promise((r) => setTimeout(r, 200));
    const description = [
      detailContent,
      it.type ? `Anstellungsart: ${it.type}` : '',
      it.range ? `Beschäftigungsgrad: ${it.range}` : '',
      'Merian Iselin Klinik — private Belegklinik in Basel mit Schwerpunkten Orthopädie und Gynäkologie.',
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || it.title, 'de');
    const jobSlug = slugify(`${it.title} ${MERIAN_ISELIN_KEY} basel`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    jobs.push({
      id: `${MERIAN_ISELIN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MERIAN_ISELIN_COMPANY_NAME,
      companyKey: MERIAN_ISELIN_KEY,
      companyDomain: MERIAN_ISELIN_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Basel',
      canton: 'BS',
      url: it.url,
      source: 'Merian Iselin Dedicated Parser (custom HTML)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Basel',
      addressRegion: 'BS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '4054',
      category: detectHealthcareCategory(`${it.title} ${it.type}`),
      contract: /temporär|temporary/i.test(it.type) ? 'temporary' : 'full-time',
      employmentType: detectHealthcareEmploymentType(`${it.range} ${it.type} ${it.title}`),
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
  console.log(`📋 Total ${MERIAN_ISELIN_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}
