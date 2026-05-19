#!/usr/bin/env node
/**
 * Klinik Adelheid (ZG) job parser — bespoke CMS (MODX-based, no public ATS).
 *
 * Public career site: https://www.klinik-adelheid.ch/jobs-und-karriere/offene-stellen/
 *   → individual jobs at /job/{slug}/
 *
 * The listing page renders a `<table class="table-link">` with two columns:
 *   <tr><td><a href="/job/{slug}/">{TITLE}</a></td>
 *       <td><a href="/job/{slug}/">{BEREICH}</a></td></tr>
 *
 * Detail pages have free-form prose between the H1 + intro line "Wir suchen
 * nach Vereinbarung einen / eine" and the in-page Bewerbungsformular.
 *
 * Klinik Adelheid AG is a 140-bed musculoskeletal/neurological/oncological/
 * geriatric rehabilitation clinic above Lake Ägeri (Unterägeri, 6314, canton
 * ZG). Part of the Gemeinnützige Gesellschaft Zug. ~18 open positions at
 * parser creation, all German-language.
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

export const KLINIK_ADELHEID_KEY = 'klinik-adelheid';
export const KLINIK_ADELHEID_COMPANY_NAME = 'Klinik Adelheid';
export const KLINIK_ADELHEID_COMPANY_DOMAIN = 'klinik-adelheid.ch';

const PUBLIC_CAREER_URL = 'https://www.klinik-adelheid.ch/jobs-und-karriere/offene-stellen/';
const SITE_BASE = 'https://www.klinik-adelheid.ch';

export function isKlinikAdelheidJob(job) {
  if (job?.companyKey === KLINIK_ADELHEID_KEY) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('klinik-adelheid.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'klinik-adelheid.ch' || host.endsWith('.klinik-adelheid.ch');
  } catch {
    return false;
  }
}

/**
 * Parse the `<table class="table-link">` listing → [{ slug, title, bereich }].
 */
export function parseAdelheidListing(html = '') {
  const out = [];
  const seen = new Set();
  const rowRx = /<tr>\s*<td>\s*<a\s+href="(\/job\/[a-z0-9-]+\/)"[^>]*>([^<]+)<\/a>\s*<\/td>\s*<td>\s*<a\s+href="\/job\/[a-z0-9-]+\/"[^>]*>([^<]+)<\/a>\s*<\/td>\s*<\/tr>/gi;
  let m;
  while ((m = rowRx.exec(html))) {
    const path = m[1];
    const title = normalizeSpace(decodeEntities(m[2]));
    const bereich = normalizeSpace(decodeEntities(m[3]));
    if (!title || title.length < 3) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, title, bereich });
  }
  return out;
}

/**
 * Extract the job-description paragraph block from a detail page.
 * Bounds: from "Wir suchen nach Vereinbarung" (intro line) to the in-page
 * application form (`Online-Bewerbung` / Bewerbungsformular).
 */
export function extractAdelheidDetail(html = '') {
  if (!html) return '';
  // Strip noise
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '');

  const text = cleaned
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ');

  const decoded = decodeEntities(text);
  const lines = decoded.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const startIdx = lines.findIndex((l) => /Wir suchen|Zur Verstärkung|Wir suchen nach Vereinbarung/i.test(l));
  const stopRx = /Online[- ]?Bewerbung|Bewerbungsformular|Spamschutz|Lebenslauf|Motivationsschreiben|Weitere Beilagen|Mit Klick auf|Datenschutzerkl/i;
  const stopIdx = lines.findIndex((l, i) => i > startIdx && stopRx.test(l));
  const slice = startIdx >= 0
    ? lines.slice(startIdx, stopIdx > 0 ? stopIdx : lines.length)
    : lines;
  return slice.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function fetchAllKlinikAdelheidJobs() {
  console.log(`🏥 Fetching ${KLINIK_ADELHEID_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL}\n`);

  const html = await fetchHtml(PUBLIC_CAREER_URL);
  const rows = parseAdelheidListing(html);
  console.log(`  ✓ ${rows.length} jobs from listing`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;

  for (const row of rows) {
    const detailUrl = `${SITE_BASE}${row.path}`;
    let description = '';
    try {
      const detailHtml = await fetchHtml(detailUrl);
      description = extractAdelheidDetail(detailHtml);
      if (description) detailHits++;
    } catch (err) {
      console.log(`     ⚠ detail fetch failed for ${row.path}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));

    if (!description) {
      description = [
        `${row.title} — ${KLINIK_ADELHEID_COMPANY_NAME}, Unterägeri (ZG).`,
        row.bereich ? `Bereich: ${row.bereich}.` : '',
        'Die Klinik Adelheid ist eine 140-Betten Rehabilitationsklinik der Zentralschweiz mit Spezialisierung in muskuloskelettaler, neurologischer, internistisch-onkologischer und geriatrischer Rehabilitation.',
      ].filter(Boolean).join('\n\n');
    } else if (row.bereich) {
      description = `Bereich: ${row.bereich}.\n\n${description}`;
    }

    const sourceLang = detectLang(description || row.title, 'de');
    const jobSlug = slugify(`${row.title} ${KLINIK_ADELHEID_KEY} unteraegeri`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${KLINIK_ADELHEID_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_ADELHEID_COMPANY_NAME,
      companyKey: KLINIK_ADELHEID_KEY,
      companyDomain: KLINIK_ADELHEID_COMPANY_DOMAIN,
      title: row.title,
      titleByLocale: { [sourceLang]: row.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Unterägeri',
      canton: 'ZG',
      url: detailUrl,
      source: `${KLINIK_ADELHEID_COMPANY_NAME} Dedicated Parser (bespoke CMS)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Unterägeri',
      addressRegion: 'ZG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '6314',
      category: detectHealthcareCategory(`${row.title} ${row.bereich}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(row.title),
      experienceLevel: detectHealthcareExperienceLevel(row.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${KLINIK_ADELHEID_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${rows.length} with rich detail content)`);
  return jobs;
}

export { PUBLIC_CAREER_URL };
