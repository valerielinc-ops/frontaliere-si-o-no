#!/usr/bin/env node
/**
 * Centro Sanitario Bregaglia (CSB) job parser.
 *
 * Public career site: https://www.csbregaglia.ch/it/centro-sanitario/offerte-di-lavoro
 * RSS feed (used here): https://www.csbregaglia.ch/it/centro-sanitario/offerte-di-lavoro?format=feed&type=rss
 *
 * Joomla-based site in Italian-speaking Grisons (Val Bregaglia). Native
 * Joomla RSS feed exposes the offer titles + permalinks, which is much more
 * reliable than scraping the HTML listing page.
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
import { htmlToTextLines } from './html-to-text-lines.mjs';

export const CS_BREGAGLIA_KEY = 'cs-bregaglia';
export const CS_BREGAGLIA_COMPANY_NAME = 'Centro Sanitario Bregaglia';
export const CS_BREGAGLIA_COMPANY_DOMAIN = 'csbregaglia.ch';

const FEED_URL = 'https://www.csbregaglia.ch/it/centro-sanitario/offerte-di-lavoro?format=feed&type=rss';

export function isCsBregagliaJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === CS_BREGAGLIA_KEY || url.includes('csbregaglia.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'csbregaglia.ch' || host.endsWith('.csbregaglia.ch');
  } catch {
    return false;
  }
}

export function parseRssFeed(xml) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml))) {
    const body = m[1];
    const titleMatch = body.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkMatch = body.match(/<link>([\s\S]*?)<\/link>/);
    const dateMatch = body.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const descMatch = body.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    if (!titleMatch || !linkMatch) continue;
    items.push({
      title: normalizeSpace(decodeEntities(titleMatch[1])),
      url: normalizeSpace(linkMatch[1]),
      pubDate: dateMatch ? normalizeSpace(dateMatch[1]) : '',
      description: descMatch ? normalizeSpace(htmlToText(descMatch[1])) : '',
    });
  }
  return items;
}

// Joomla renders each obfuscated address as an empty `mailto:` anchor followed
// by a `cloak…` span whose text is a "protected from spambots" notice and whose
// real value is written by an inline script. Keep the address from the anchor
// and drop the notice, so the body carries the contact instead of the warning.
function uncloakJoomlaEmails(html = '') {
  return String(html || '')
    .replace(/<span\b[^>]*\bid=["']cloak[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<a\b[^>]*\bhref=["']mailto:([^"'?]+)[^"']*["'][^>]*>\s*<\/a>/gi, ' $1 ');
}

/**
 * The RSS `<description>` is Joomla's intro text only — the "Offerta di lavoro
 * in breve" facts list — while the vacancy page carries the whole posting
 * (clinic presentation, `Requisiti`, `Offriamo`, application note). Read the
 * `<article class="uk-article">` body after its title heading.
 */
export function parseCsBregagliaDetailBody(html = '') {
  const start = String(html || '').search(/<article\b[^>]*\buk-article\b[^>]*>/i);
  if (start < 0) return '';
  const end = html.indexOf('</article>', start);
  let body = html.slice(start, end > start ? end : undefined);
  body = body.replace(/^<article\b[^>]*>/i, '').replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, '');
  return htmlToTextLines(uncloakJoomlaEmails(body));
}

export async function fetchAllCsBregagliaJobs() {
  console.log(`🏥 Fetching ${CS_BREGAGLIA_COMPANY_NAME} jobs`);
  console.log(`   Feed: ${FEED_URL}\n`);
  const xml = await fetchHtml(FEED_URL);
  const items = parseRssFeed(xml);
  console.log(`  ✓ ${items.length} items from RSS feed`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const title = it.title.replace(/^Offerta di lavoro:\s*/i, '');
    if (!title || title.length < 3) continue;
    let detailBody = '';
    try {
      detailBody = parseCsBregagliaDetailBody(await fetchHtml(it.url));
    } catch (err) {
      console.warn(`  ⚠️ detail fetch failed for ${it.url}: ${err?.message || err}`);
    }
    // The source's own text only: the detail body or the RSS description.
    // Without either the parser used to write "<titolo> — Centro Sanitario
    // Bregaglia, Promontogno (GR)."; the job now takes the thin-source path.
    const description = (detailBody.length > it.description.length ? detailBody : '')
      || it.description
      || '';
    const postedDate = (() => {
      const d = new Date(it.pubDate || '');
      return Number.isNaN(d.getTime()) ? todayIso : d.toISOString().slice(0, 10);
    })();
    const sourceLang = detectLang(description || title, 'it');
    const jobSlug = slugify(`${title} ${CS_BREGAGLIA_KEY} promontogno`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    jobs.push({
      id: `${CS_BREGAGLIA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CS_BREGAGLIA_COMPANY_NAME,
      companyKey: CS_BREGAGLIA_KEY,
      companyDomain: CS_BREGAGLIA_COMPANY_DOMAIN,
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
      location: 'Promontogno',
      canton: 'GR',
      url: it.url,
      source: 'CS Bregaglia Dedicated Parser (Joomla RSS feed)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Promontogno',
      addressRegion: 'GR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '7606',
      category: detectHealthcareCategory(title + ' ' + description),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title + ' ' + description),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${CS_BREGAGLIA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

/**
 * The whole one-line description the parser used to write without a body:
 * "<titolo> — Centro Sanitario Bregaglia, Promontogno (GR)." (anchored at both
 * ends; a body that names the centre is not taken for it).
 */
export const CS_BREGAGLIA_FABRICATED_DESCRIPTION_RE = /^[^\n]{3,300} — Centro Sanitario Bregaglia, Promontogno \(GR\)\.\s*$/;
