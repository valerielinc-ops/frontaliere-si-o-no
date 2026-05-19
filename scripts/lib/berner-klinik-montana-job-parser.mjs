#!/usr/bin/env node
/**
 * Berner Klinik Montana — Clinique Bernoise Montana (VS Crans-Montana).
 *
 * Public career site: https://bernerklinik.ch/fr/emploi-et-carriere/offres-demploi/
 *
 * 110-bed rehabilitation clinic specialising in neurology, psychosomatics,
 * musculoskeletal disorders, and internal medicine + oncology. Wordpress
 * site using the bmg-page-list plugin: each offer is rendered as
 *   <article class="page-list-item">
 *     <a class="post-link" href=".../carriere/offres-d-emploi/{slug}/">
 *       <h3 class="post-title post-title-in-data">{TITLE}</h3>
 *       <span class="post-resume-wrapper">{INTRO}</span>
 *     </a>
 *   </article>
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

export const BERNER_KLINIK_MONTANA_KEY = 'berner-klinik-montana';
export const BERNER_KLINIK_MONTANA_COMPANY_NAME = 'Berner Klinik Montana';
export const BERNER_KLINIK_MONTANA_COMPANY_DOMAIN = 'bernerklinik.ch';

const LISTING_URL = 'https://bernerklinik.ch/fr/emploi-et-carriere/offres-demploi/';

export function isBernerKlinikMontanaJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === BERNER_KLINIK_MONTANA_KEY || url.includes('bernerklinik.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bernerklinik.ch' || host.endsWith('.bernerklinik.ch');
  } catch {
    return false;
  }
}

export function parseBernerKlinikListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /<article class="page-list-item[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = rx.exec(html))) {
    const body = m[1];
    const linkMatch = body.match(/<a\s+class="post-link"[^>]*href="([^"]+)"/);
    if (!linkMatch) continue;
    const url = linkMatch[1];
    if (seen.has(url)) continue;
    seen.add(url);

    // Prefer post-title-in-data over the duplicate in-thumbnail
    const titleMatch = body.match(/<h3\s+class="[^"]*post-title-in-data[^"]*"[^>]*>([\s\S]*?)<\/h3>/);
    const title = titleMatch
      ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')))
      : '';
    if (!title || title.length < 3) continue;

    const introMatch = body.match(/<span class="post-resume-wrapper">([\s\S]*?)<\/span>/);
    const intro = introMatch
      ? normalizeSpace(decodeEntities(introMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';

    out.push({ url, title, intro });
  }
  return out;
}

async function fetchDetailContent(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
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
      if (/cookie|privacy|impressum|réseaux sociaux/i.test(text.slice(0, 40))) continue;
      parts.push(pm[1].match(/^li$/i) ? `• ${text}` : text);
    }
    return parts.slice(0, 25).join('\n');
  } catch {
    return '';
  }
}

export async function fetchAllBernerKlinikMontanaJobs() {
  console.log(`🏥 Fetching ${BERNER_KLINIK_MONTANA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseBernerKlinikListing(html);
  console.log(`  ✓ ${items.length} offres trouvées`);
  if (!items.length) return [];
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const it of items) {
    const detailContent = await fetchDetailContent(it.url);
    if (detailContent) detailHits++;
    await new Promise((r) => setTimeout(r, 250));
    const description = [
      detailContent,
      it.intro,
      'Berner Klinik Montana — Clinique bernoise spécialisée en réadaptation à Crans-Montana (VS).',
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || it.title, 'fr');
    const jobSlug = slugify(`${it.title} ${BERNER_KLINIK_MONTANA_KEY} crans-montana`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    jobs.push({
      id: `${BERNER_KLINIK_MONTANA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BERNER_KLINIK_MONTANA_COMPANY_NAME,
      companyKey: BERNER_KLINIK_MONTANA_KEY,
      companyDomain: BERNER_KLINIK_MONTANA_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Crans-Montana',
      canton: 'VS',
      url: it.url,
      source: 'Berner Klinik Montana Dedicated Parser (WordPress bmg-page-list)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Crans-Montana',
      addressRegion: 'VS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '3963',
      category: detectHealthcareCategory(`${it.title} ${it.intro}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(`${it.title} ${it.intro}`),
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
  console.log(`📋 Total ${BERNER_KLINIK_MONTANA_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}
