#!/usr/bin/env node
/**
 * Centro Sanitario Valposchiavo (CSVP) — Ospedale San Sisto, Poschiavo (GR).
 *
 * Public career site: https://www.csvp.ch/it/lavora-con-noi/cerchiamo
 *
 * Joomla-based site with `<article>` blocks per offer. Title link in `<h1>`,
 * intro paragraph with employment %/start date + PDF download link.
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

export const CSVP_POSCHIAVO_KEY = 'csvp-poschiavo';
export const CSVP_POSCHIAVO_COMPANY_NAME = 'Centro Sanitario Valposchiavo (CSVP)';
export const CSVP_POSCHIAVO_COMPANY_DOMAIN = 'csvp.ch';

const LISTING_URL = 'https://www.csvp.ch/it/lavora-con-noi/cerchiamo';
const BASE_URL = 'https://www.csvp.ch';

export function isCsvpPoschiavoJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === CSVP_POSCHIAVO_KEY || url.includes('csvp.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'csvp.ch' || host.endsWith('.csvp.ch');
  } catch {
    return false;
  }
}

export function parseCsvpListing(html) {
  const out = [];
  const seen = new Set();
  const articleRx = /<article[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = articleRx.exec(html))) {
    const body = m[1];
    // Title: <h1>...<a href="/it/lavora-con-noi/cerchiamo/N-slug" title="TITLE">TITLE</a></h1>
    const titleMatch = body.match(/<h1[^>]*>[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const url = titleMatch[1].startsWith('http') ? titleMatch[1] : `${BASE_URL}${titleMatch[1]}`;
    const title = normalizeSpace(decodeEntities(titleMatch[2].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 5) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // Intro paragraph (next <p>)
    const introMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const intro = introMatch ? normalizeSpace(htmlToText(introMatch[1])) : '';

    // PDF link if present
    const pdfMatch = body.match(/href="([^"]+\.pdf)"/i);
    const pdfUrl = pdfMatch ? (pdfMatch[1].startsWith('http') ? pdfMatch[1] : `${BASE_URL}${pdfMatch[1]}`) : '';

    out.push({ url, title, intro, pdfUrl });
  }
  return out;
}

export async function fetchAllCsvpPoschiavoJobs() {
  console.log(`🏥 Fetching ${CSVP_POSCHIAVO_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseCsvpListing(html);
  console.log(`  ✓ ${items.length} offerte trovate`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const title = it.title;
    const description = [
      it.intro,
      it.pdfUrl ? `Dettagli (PDF): ${it.pdfUrl}` : '',
      'Centro Sanitario Valposchiavo — Ospedale San Sisto, Poschiavo (GR).',
    ].filter(Boolean).join('\n\n');
    const sourceLang = detectLang(description || title, 'it');
    const jobSlug = slugify(`${title} ${CSVP_POSCHIAVO_KEY} poschiavo`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    jobs.push({
      id: `${CSVP_POSCHIAVO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CSVP_POSCHIAVO_COMPANY_NAME,
      companyKey: CSVP_POSCHIAVO_KEY,
      companyDomain: CSVP_POSCHIAVO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Poschiavo',
      canton: 'GR',
      url: it.url,
      source: 'CSVP Dedicated Parser (Joomla HTML)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Poschiavo',
      addressRegion: 'GR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '7742',
      category: detectHealthcareCategory(title + ' ' + it.intro),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title + ' ' + it.intro),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${CSVP_POSCHIAVO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
