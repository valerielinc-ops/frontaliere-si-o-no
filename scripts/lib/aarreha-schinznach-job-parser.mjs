#!/usr/bin/env node
/**
 * aarReha Schinznach — Klinik für interdisziplinäre Rehabilitation (AG).
 *
 * Public career site: https://aarreha.ch/jobs/offene-stellen/
 * Talentsoft portal:  https://aarreha-bewerber.talent-soft.com/
 * All-jobs listing:   /stelle/liste-aller-stellen.aspx?all=1&mode=list
 *
 * Cegid/Talentsoft ATS (same family as REHAB Basel). The list page renders
 * each offer as a server-rendered `<li class="ts-offer-list-item">` whose
 * description `<ul>` carries the department (German label) and the city.
 * No posted date in the listing, so we default to today. Detail page content
 * lives under `id="contenu-ficheoffre"` and contains structured German prose
 * (Funktion / Pensum / Aufgaben / Profil / Einsatzort).
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

export const AARREHA_SCHINZNACH_KEY = 'aarreha-schinznach';
export const AARREHA_SCHINZNACH_COMPANY_NAME = 'aarReha Schinznach';
export const AARREHA_SCHINZNACH_COMPANY_DOMAIN = 'aarreha.ch';

const PORTAL_BASE = 'https://aarreha-bewerber.talent-soft.com';
const LISTING_URL = `${PORTAL_BASE}/stelle/liste-aller-stellen.aspx?all=1&mode=list`;
const DETAIL_DELAY_MS = 250;

export function isAarrehaSchinznachJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === AARREHA_SCHINZNACH_KEY
    || url.includes('aarreha.ch')
    || url.includes('aarreha-bewerber.talent-soft.com');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'aarreha.ch'
      || host.endsWith('.aarreha.ch')
      || host === 'aarreha-bewerber.talent-soft.com';
  } catch {
    return false;
  }
}

/**
 * Parse the Talentsoft listing into `{ detailUrl, title, ref, department, city }`.
 * Format (aarReha variant — no posted-date column):
 *
 *   <li class="ts-offer-list-item ..." onclick="location.href='{REL_URL}';">
 *     <h3><a href="{REL_URL}" title="...">{TITLE}</a></h3>
 *     <span ... data-reference="{YYYY-NNN}" ...></span>
 *     <ul class="ts-offer-list-item__description">
 *       <li>{DEPARTMENT}</li><li>{CITY}</li>
 *     </ul>
 *   </li>
 */
export function parseAarrehaListing(html) {
  const out = [];
  const seen = new Set();
  const itemRe = /<li class="ts-offer-list-item[^"]*"[^>]*onclick="location\.href='([^']+)';"[^>]*>([\s\S]*?)<\/ul>\s*<\/li>/g;
  let m;
  while ((m = itemRe.exec(html))) {
    const rel = m[1];
    const block = m[2];
    const detailUrl = rel.startsWith('http') ? rel : `${PORTAL_BASE}${rel}`;

    const titleMatch = block.match(/<a\s+class="ts-offer-list-item__title-link[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch
      ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')))
      : '';
    if (!title || title.length < 3) continue;

    const refMatch = block.match(/data-reference="([0-9-]+)"/);
    const ref = refMatch ? refMatch[1] : '';

    const descLis = [];
    const ulMatch = block.match(/<ul class="ts-offer-list-item__description[^"]*">([\s\S]*)$/);
    if (ulMatch) {
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
      let lm;
      while ((lm = liRe.exec(ulMatch[1]))) {
        descLis.push(normalizeSpace(decodeEntities(lm[1].replace(/<[^>]+>/g, ''))));
      }
    }
    const [department = '', city = ''] = descLis;

    const key = ref || detailUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ detailUrl, title, ref, department, city });
  }
  return out;
}

async function fetchDetailDescription(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return '';
    // The job-detail block sits inside id="contenu-ficheoffre". Take everything
    // up to the share/actions/footer panel.
    const startMatch = html.match(/id="contenu-ficheoffre"[^>]*>([\s\S]+)/);
    if (!startMatch) return '';
    const block = startMatch[1].slice(0, 14000);
    // Cut off boilerplate footer (Sitemap / Rechtliche Hinweise / Cookies).
    const cutMatch = block.match(/[\s\S]+?(?=Rechtliche\s+Hinweise|<\/main>|<footer)/);
    const trimmed = cutMatch ? cutMatch[0] : block;
    const text = htmlToText(trimmed);
    return normalizeSpace(text).slice(0, 6000);
  } catch (err) {
    console.warn(`  ⚠️ aarReha detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return '';
  }
}

export async function fetchAllAarrehaSchinznachJobs() {
  console.log(`🏥 Fetching ${AARREHA_SCHINZNACH_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);

  // Talentsoft paginates ~10 jobs per page; the listing title declares
  // "(N Stellenangebote, Seite 1)". We walk pages until we get an empty page
  // or hit the documented total. Cap at 20 pages for safety.
  const MAX_PAGES = 20;
  const rows = [];
  const seenKeys = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = page === 1 ? LISTING_URL : `${LISTING_URL}&page=${page}`;
    const html = await fetchHtml(url);
    const pageRows = parseAarrehaListing(html);
    if (!pageRows.length) break;
    let added = 0;
    for (const r of pageRows) {
      const key = r.ref || r.detailUrl;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      rows.push(r);
      added += 1;
    }
    console.log(`  · page ${page}: ${pageRows.length} parsed (+${added} new)`);
    if (added === 0) break;
  }
  console.log(`  ✓ ${rows.length} Talentsoft offers (deduped across pages)`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detailText = await fetchDetailDescription(r.detailUrl);

    const summaryPieces = [
      r.department ? `Bereich: ${r.department}` : '',
      r.city ? `Standort: ${r.city}` : '',
      r.ref ? `Referenz: ${r.ref}` : '',
    ].filter(Boolean);
    const description = detailText && detailText.split(/\s+/).length >= 30
      ? detailText
      : [
        ...summaryPieces,
        `${AARREHA_SCHINZNACH_COMPANY_NAME} — Zentrum für interdisziplinäre Rehabilitation in Schinznach-Bad (AG).`,
      ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${AARREHA_SCHINZNACH_KEY} ${r.city || 'schinznach'}`);
    const urlHash = createHash('sha1').update(r.detailUrl).digest('hex').slice(0, 12);

    // aarReha is fully in canton Aargau; "Schinznach-Bad" / "Zofingen" are the
    // two sites. Default postal code follows the main Schinznach-Bad campus
    // (5116). Detail pages can mention "Aargau, Schinznach-Bad" or "Zofingen".
    const cityLabel = r.city || 'Schinznach-Bad';
    const postalCode = /zofingen/i.test(cityLabel) ? '4800' : '5116';

    jobs.push({
      id: `${AARREHA_SCHINZNACH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: AARREHA_SCHINZNACH_COMPANY_NAME,
      companyKey: AARREHA_SCHINZNACH_KEY,
      companyDomain: AARREHA_SCHINZNACH_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: cityLabel,
      canton: 'AG',
      url: r.detailUrl,
      source: `${AARREHA_SCHINZNACH_COMPANY_NAME} Dedicated Parser (Talentsoft)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: cityLabel,
      addressRegion: 'AG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(`${r.title} ${r.department}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(`${r.title} ${description}`),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`\n📋 Total ${AARREHA_SCHINZNACH_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
