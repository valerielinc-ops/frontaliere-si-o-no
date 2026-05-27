#!/usr/bin/env node
/**
 * Arsanté Group — Genevan medical/clinic federation that runs the
 * **Clinique de Carouge**, the Maison de Santé d'Onex, Centre Médical des
 * Eaux-Vives, Centre Médical de Lancy, Groupe Médical d'Onex and a couple
 * of smaller centres. All openings — across every site — are published on
 * the same `arsante.ch/emploi` board, which the corporate site
 * `cliniquedecarouge.ch/emploi` links to directly.
 *
 * Public career site:
 *   https://arsante.ch/emploi (paginated: ?page=2, ?page=3)
 *   Mirror redirect: https://www.cliniquedecarouge.ch/emploi
 *
 * The listing pages are static HTML with proper
 * `schema.org/JobPosting` microdata wrappers. Each card looks like:
 *
 *   <div itemscope itemtype="https://schema.org/JobPosting">
 *     <h2 itemprop="title">{TITLE}</h2>
 *     <div class="pb-2" itemprop="description"> <p>{TEASER}</p>
 *       <a href="/emploi/{slug}-{id}" itemprop="url">Plus d'informations</a>
 *     </div>
 *   </div>
 *
 * Detail page (`/emploi/{slug}-{id}`) renders the full job description in
 * the `<main>` section of the site. The clinic subtitle is exposed as an
 * `<h2 class="post__subtitle …">{ENTITY}</h2>` block (e.g. "Groupe Médical
 * d'Onex", "Maison de Santé d'Onex", "Clinique de Carouge", …).
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

export const ARSANTE_KEY = 'arsante-clinique-de-carouge';
export const ARSANTE_COMPANY_NAME = 'Arsanté (Clinique de Carouge)';
export const ARSANTE_COMPANY_DOMAIN = 'arsante.ch';

const LISTING_BASE = 'https://arsante.ch/emploi';
const MAX_PAGES = 6;
const DETAIL_DELAY_MS = 250;

export function isArsanteJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === ARSANTE_KEY) return true;
  if (url.includes('arsante.ch')) return true;
  if (url.includes('cliniquedecarouge.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'arsante.ch' || host.endsWith('.arsante.ch')) return true;
    if (host === 'cliniquedecarouge.ch' || host.endsWith('.cliniquedecarouge.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse one listing HTML page into a list of `{ url, title, teaser }` rows.
 * Uses the schema.org/JobPosting microdata wrapper which is stable and
 * survives any minor template change to the listing CSS.
 */
export function parseListing(html) {
  const out = [];
  const seen = new Set();
  // Each card block: capture from itemtype start to the closing </div>
  // immediately before the next JobPosting (or end of section).
  const re = /<div[^>]*itemscope[^>]*itemtype="https:\/\/schema\.org\/JobPosting"[^>]*>([\s\S]*?)(?=<div[^>]*itemtype="https:\/\/schema\.org\/JobPosting"|<nav|<\/main|<\/section)/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const titleMatch = body.match(/itemprop="title"[^>]*>([\s\S]*?)<\/h\d>/i);
    const urlMatch = body.match(/<a[^>]*href="(\/emploi\/[^"]+)"[^>]*itemprop="url"/i)
      || body.match(/<a[^>]*itemprop="url"[^>]*href="(\/emploi\/[^"]+)"/i);
    const descMatch = body.match(/itemprop="description"[^>]*>([\s\S]*?)<a[^>]*itemprop="url"/i);
    if (!titleMatch || !urlMatch) continue;
    const title = normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')));
    const url = new URL(urlMatch[1], 'https://arsante.ch').href;
    if (!title || seen.has(url)) continue;
    seen.add(url);
    const teaser = descMatch ? normalizeSpace(htmlToText(descMatch[1])) : '';
    out.push({ url, title, teaser });
  }
  return out;
}

function extractEntity(html) {
  // `<h2 class="post__subtitle …">{ENTITY}</h2>` — the clinic / centre name.
  const m = html.match(/<h\d[^>]*class="[^"]*post__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h\d>/i);
  if (!m) return '';
  return normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
}

function extractDetailBody(html) {
  // The full description sits inside a JobPosting microdata block on the
  // detail page too. Prefer it; otherwise fall back to <main>.
  const micro = html.match(/itemtype="https:\/\/schema\.org\/JobPosting"[\s\S]*?(<div[^>]*itemprop="description"[\s\S]*?<\/div>\s*<\/div>)/i);
  if (micro) {
    return normalizeSpace(htmlToText(micro[1])).slice(0, 6000);
  }
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return normalizeSpace(htmlToText(mainMatch[1])).slice(0, 6000);
  return '';
}

async function fetchDetail(url) {
  try {
    const html = await fetchHtml(url);
    return {
      entity: extractEntity(html),
      body: extractDetailBody(html),
    };
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
    return { entity: '', body: '' };
  }
}

/**
 * Locality inference for an Arsanté sub-brand. All sites are in canton
 * Geneva (GE) — we just pick a representative city for the schema.
 */
function inferLocality(entity = '') {
  const e = entity.toLowerCase();
  if (/onex/.test(e)) return { city: 'Onex', postalCode: '1213' };
  if (/eaux.vives/.test(e)) return { city: 'Genève', postalCode: '1207' };
  if (/lancy/.test(e)) return { city: 'Lancy', postalCode: '1212' };
  if (/carouge/.test(e)) return { city: 'Carouge', postalCode: '1227' };
  if (/genève|geneva|geneve/.test(e)) return { city: 'Genève', postalCode: '1204' };
  return { city: 'Carouge', postalCode: '1227' }; // group HQ
}

export async function fetchAllArsanteJobs() {
  console.log(`🏥 Fetching ${ARSANTE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_BASE} (paginated ?page=N)\n`);

  const allRows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = page === 1 ? LISTING_BASE : `${LISTING_BASE}?page=${page}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`  ⚠️ Listing page ${page} fetch failed: ${err?.message || err}`);
      break;
    }
    const rows = parseListing(html);
    console.log(`  ✓ page ${page}: ${rows.length} jobs`);
    if (!rows.length) break;
    // Dedupe across pagination overlap
    const beforeCount = allRows.length;
    const known = new Set(allRows.map((r) => r.url));
    for (const r of rows) if (!known.has(r.url)) allRows.push(r);
    // If the page added zero new rows we've cycled — stop.
    if (allRows.length === beforeCount) break;
    if (page < MAX_PAGES) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
  }
  console.log(`\n  Total unique rows: ${allRows.length}`);
  if (!allRows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < allRows.length; i += 1) {
    const r = allRows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detail = await fetchDetail(r.url);

    const entity = detail.entity || 'Arsanté';
    const loc = inferLocality(entity);
    const fallback = `${r.title} chez ${entity} (groupe Arsanté), ${loc.city} (GE). ${r.teaser || ''}`.trim();
    const description = detail.body && detail.body.split(/\s+/).length >= 30
      ? detail.body
      : [fallback, detail.body].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || r.title, 'fr');
    const jobSlug = slugify(`${r.title} ${ARSANTE_KEY} ${loc.city}`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${ARSANTE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: `${ARSANTE_COMPANY_NAME} — ${entity}`,
      companyKey: ARSANTE_KEY,
      companyDomain: ARSANTE_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: loc.city,
      canton: 'GE',
      url: r.url,
      source: `${ARSANTE_COMPANY_NAME} Dedicated Parser (Custom HTML — schema.org/JobPosting)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: loc.city,
      addressRegion: 'GE',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postalCode,
      category: detectHealthcareCategory(`${r.title} ${description.slice(0, 600)}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(`${r.title} ${description.slice(0, 400)}`),
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

  console.log(`📋 Total ${ARSANTE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_BASE };
