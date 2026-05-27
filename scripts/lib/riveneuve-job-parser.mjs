#!/usr/bin/env node
/**
 * Fondation Rive-Neuve job parser — Jalios JCMS, server-rendered "card" layout.
 *
 * Public career site: https://www.riveneuve.ch/jcms/rivd_7358/fr/emplois
 *
 * Specialised hospital in Blonay (VD), recognised palliative-care competence
 * centre. Each offer is a Jalios JCMS publication of type `OffreEmploi` rendered
 * inside a `<div class="card card-default">`:
 *
 *   <div class="card card-default">
 *     <a href="jcms/rivd_{ID}/fr/{slug}" class="image-link">...</a>
 *     <div class="article-title">
 *       <a class="card-link" href="jcms/rivd_{ID}/fr/{slug}">{TITLE}</a>
 *     </div>
 *     <div class="article-summary">{optional summary}</div>
 *   </div>
 *
 * Detail page has:
 *   <h1 class="publication-title" itemprop="name">{TITLE}</h1>
 *   <div class="publication-metas">
 *     <strong>Référence</strong>:..  <strong>Type de Contrat</strong>:CDI..
 *     <strong>Taux</strong>: 100 %.. <strong>Date d'entrée</strong>:..
 *   </div>
 *   <div class="publication-body">
 *     <div class="wysiwyg">...rich HTML...</div>
 *   </div>
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  USER_AGENT,
} from './hospital-custom-html-helpers.mjs';

// Rive-Neuve's Apache/Tomcat resets the connection if the Accept header
// includes "application/rss+xml" with a wildcard fallback (the value used
// by the shared fetchHtml helper). Use a strict "text/html" Accept instead.
async function fetchRiveneuveHtml(url) {
  const t = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export const RIVENEUVE_KEY = 'riveneuve';
export const RIVENEUVE_COMPANY_NAME = 'Fondation Rive-Neuve';
export const RIVENEUVE_COMPANY_DOMAIN = 'riveneuve.ch';

const LISTING_URL = 'https://www.riveneuve.ch/jcms/rivd_7358/fr/emplois';
const BASE_URL = 'https://www.riveneuve.ch';
const SPONTANEOUS_SLUG = 'candidature-spontanee';

export function isRiveneuveJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === RIVENEUVE_KEY) return true;
  if (url.includes('riveneuve.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'riveneuve.ch' || host.endsWith('.riveneuve.ch');
  } catch {
    return false;
  }
}

/**
 * Extract job-link entries from the listing page. We look only at links that
 * follow the OffreEmploi-only routing path — concretely: a link inside
 * `<div class="article-title">` whose URL is `jcms/rivd_{id}/fr/{slug}`.
 */
export function parseRiveneuveListing(html) {
  const out = [];
  const seen = new Set();
  const articleTitleRx = /<div\s+class="article-title">\s*<a\s+class="card-link[^"]*"\s+href="(jcms\/rivd_(\d+)\/fr\/([^"]+))">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = articleTitleRx.exec(html))) {
    const rel = m[1];
    const id = m[2];
    const slug = m[3];
    if (seen.has(id)) continue;
    if (slug === SPONTANEOUS_SLUG) continue;          // skip "candidature spontanée"
    const title = normalizeSpace(decodeEntities(m[4].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 5) continue;
    seen.add(id);
    out.push({ id, url: `${BASE_URL}/${rel}`, title, slug });
  }
  return out;
}

/** Extract title + structured metadata + wysiwyg body from a detail page. */
async function fetchDetailContent(detailUrl) {
  let html;
  try {
    html = await fetchRiveneuveHtml(detailUrl);
  } catch {
    return { title: '', meta: '', description: '' };
  }

  let title = '';
  const titleMatch = html.match(/<h1\s+class="publication-title"[^>]*>([\s\S]*?)<\/h1>/);
  if (titleMatch) title = normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')));

  // Metas block (Référence / Type de Contrat / Taux / Date d'entrée)
  let meta = '';
  const metaBlockMatch = html.match(/<div\s+class="publication-metas[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  if (metaBlockMatch) {
    const metaText = normalizeSpace(htmlToText(metaBlockMatch[1]));
    // Drop the "//" leftover from the comment-styled second column.
    meta = metaText.replace(/\/\//g, '').replace(/\s+/g, ' ').trim();
  }

  // Body: <div class="publication-body"> ... <div class="wysiwyg">{body}</div> ...
  let description = '';
  const bodyMatch = html.match(/<div\s+class="publication-body[^"]*"[^>]*>([\s\S]*?)<div\s+class="publication-footer/);
  if (bodyMatch) {
    description = htmlToText(bodyMatch[1]).trim();
  } else {
    const wysiwygMatch = html.match(/<div\s+class="wysiwyg"[^>]*>([\s\S]*?)<\/div>/);
    if (wysiwygMatch) description = htmlToText(wysiwygMatch[1]).trim();
  }
  return { title, meta, description };
}

export async function fetchAllRiveneuveJobs() {
  console.log(`🏥 Fetching ${RIVENEUVE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchRiveneuveHtml(LISTING_URL);
  } catch (err) {
    console.warn(`  ⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const entries = parseRiveneuveListing(listingHtml);
  console.log(`  ✓ ${entries.length} offerte trovate (incl. spontaneous filter)`);
  if (!entries.length) return [];
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const e of entries) {
    const detail = await fetchDetailContent(e.url);
    if (detail.description) detailHits++;
    await new Promise((r) => setTimeout(r, 250));

    const title = detail.title || e.title;
    const description = [
      detail.description,
      detail.meta,
      'Fondation Rive-Neuve — Hôpital spécialisé en soins palliatifs, Blonay (VD).',
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || title, 'fr');
    const jobSlug = slugify(`${title} ${RIVENEUVE_KEY} blonay`);
    const urlHash = createHash('sha1').update(e.url).digest('hex').slice(0, 12);
    const heuristicText = `${title}\n${detail.meta}`;

    jobs.push({
      id: `${RIVENEUVE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RIVENEUVE_COMPANY_NAME,
      companyKey: RIVENEUVE_KEY,
      companyDomain: RIVENEUVE_COMPANY_DOMAIN,
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
      location: 'Blonay',
      canton: 'VD',
      url: e.url,
      source: 'Rive-Neuve Dedicated Parser (Jalios JCMS publication-body)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Blonay',
      addressRegion: 'VD',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '1807',
      category: detectHealthcareCategory(heuristicText),
      contract: /\bcdd\b|durée\s+déterminée|temporaire/i.test(heuristicText) ? 'temporary' : 'full-time',
      employmentType: detectHealthcareEmploymentType(heuristicText),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: e.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${RIVENEUVE_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${entries.length} with rich detail content)`);
  return jobs;
}
