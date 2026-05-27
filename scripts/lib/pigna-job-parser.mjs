#!/usr/bin/env node
/**
 * Stiftung Pigna — disability-services foundation, Kloten (ZH).
 *
 * HQ in Wallisellen but the residential / day-care sites are in Kloten
 * (Graswinkelstrasse). About 9 currently-open positions in agogic care,
 * residential support and day programmes for people with disabilities.
 *
 * Public career site:
 *   https://www.pigna.ch/stiftung/stellen/personalstellen
 *     → embeds Refline widget at https://app.reflinejobs.io/1531/refline.js
 *
 * Listing source (HTML, easy to parse):
 *   https://app.reflinejobs.io/1531/positions.html?lang=de
 *
 * Each job is a `<div class="listblock listcontent">` carrying:
 *   <a href="https://app.reflinejobs.io/1531/{posId}/pub/{rev}/index.html">TITLE</a>
 *   <div class="item workName">{Arbeitsort}</div>
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
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

export const PIGNA_KEY = 'pigna';
export const PIGNA_COMPANY_NAME = 'Stiftung Pigna';
export const PIGNA_COMPANY_DOMAIN = 'pigna.ch';

const REFLINE_TENANT = '1531';
const LISTING_URL = `https://app.reflinejobs.io/${REFLINE_TENANT}/positions.html?lang=de`;
const DEFAULT_CITY = 'Kloten';
const DEFAULT_CANTON = 'ZH';
const DEFAULT_POSTAL = '8302';

export function isPignaJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  return (
    key === PIGNA_KEY ||
    url.includes('pigna.ch') ||
    url.includes(`app.reflinejobs.io/${REFLINE_TENANT}`) ||
    url.includes(`apply.refline.ch/${REFLINE_TENANT}`) ||
    company.includes('pigna')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'pigna.ch' || host.endsWith('.pigna.ch')) return true;
    if ((host === 'app.reflinejobs.io' || host === 'apply.refline.ch' || host === 'pub.refline.ch')
      && rawUrl.includes(`/${REFLINE_TENANT}/`)) return true;
    return false;
  } catch {
    return false;
  }
}

export function parsePignaReflineListing(html) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const blockRx = /<div class="listblock listcontent">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let m;
  while ((m = blockRx.exec(html))) {
    const body = m[1];
    const linkMatch = body.match(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const url = linkMatch[1];
    const title = normalizeSpace(decodeEntities(linkMatch[2].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 3) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const workNameMatch = body.match(/<div class="item workName"[^>]*>([\s\S]*?)<\/div>/);
    const workplace = workNameMatch ? normalizeSpace(decodeEntities(workNameMatch[1].replace(/<[^>]+>/g, ''))) : '';

    const idMatch = url.match(/\/(\d+)\/pub\/(\d+)\/index\.html/);
    const posId = idMatch ? idMatch[1] : '';
    out.push({ url, title, workplace, posId });
  }
  return out;
}

export function parseReflineDetail(html = '') {
  if (!html) return { title: '', description: '' };
  const titleMatch = html.match(/<h1[^>]*class="posTitle"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ''))) : '';

  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '');

  const parts = [];
  const blockRx = /<(h2|h3|h4|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRx.exec(cleaned))) {
    const tag = bm[1].toLowerCase();
    const text = normalizeSpace(htmlToText(bm[2]));
    if (text.length > 20 && !/cookie|datenschutz|impressum|bewerbung absenden|reflinejobs|refline\.io/i.test(text)) {
      parts.push(tag === 'li' ? `• ${text}` : text);
    }
  }
  return { title, description: parts.join('\n') };
}

function pickLocationHints(workplace = '') {
  const wp = String(workplace || '').trim();
  if (!wp) return { city: DEFAULT_CITY, canton: DEFAULT_CANTON, postal: DEFAULT_POSTAL };
  // workplace usually like "Kloten - Graswinkelstrasse"
  const cityPart = wp.split(/[-–—,]/)[0].trim();
  const inferred = inferSwissTargetCanton(cityPart);
  if (inferred) return { city: cityPart || DEFAULT_CITY, canton: inferred, postal: '' };
  return { city: cityPart || DEFAULT_CITY, canton: DEFAULT_CANTON, postal: '' };
}

function buildFallbackDescription(title, workplace) {
  return [
    `${title} bei ${PIGNA_COMPANY_NAME}${workplace ? ` in ${workplace}` : ''}.`,
    '',
    'Die Stiftung Pigna ist eine Wohn-, Arbeits- und Beschäftigungsstätte für Menschen mit kognitiven und mehrfachen Beeinträchtigungen in Kloten (ZH).',
    '',
    'Was Pigna bietet:',
    '• Sinnstiftende agogische Tätigkeit in einem engagierten Team',
    '• Vielfältige Aus- und Weiterbildungsmöglichkeiten',
    '• Faire Anstellungsbedingungen und attraktive Sozialleistungen',
  ].join('\n');
}

export async function fetchAllPignaJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`🏡 Fetching ${PIGNA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Refline tenant ${REFLINE_TENANT})\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch Pigna Refline listing: ${err?.message || err}`);
  }

  const listings = parsePignaReflineListing(listingHtml);
  console.log(`  📋 Found ${listings.length} positions on Refline listing\n`);
  if (!listings.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of listings) {
    let detail = { title: '', description: '' };
    try {
      const detailHtml = await fetchHtml(it.url, { timeoutMs });
      detail = parseReflineDetail(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${it.title}: ${err?.message || err}`);
    }

    const title = detail.title || it.title;
    const hints = pickLocationHints(it.workplace);
    const description = detail.description && detail.description.split(/\s+/).length >= 40
      ? detail.description
      : buildFallbackDescription(title, it.workplace);

    const haystack = `${title} ${description}`;
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${PIGNA_KEY} ${hints.city}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${PIGNA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PIGNA_COMPANY_NAME,
      companyKey: PIGNA_KEY,
      companyDomain: PIGNA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: hints.city,
      canton: hints.canton,
      url: it.url,
      source: `Pigna Dedicated Parser (Refline ${REFLINE_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: hints.city,
      addressRegion: hints.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: hints.postal || DEFAULT_POSTAL,
      category: detectHealthcareCategory(haystack),
      contract: detectHealthcareEmploymentType(haystack) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectHealthcareEmploymentType(haystack),
      experienceLevel: detectHealthcareExperienceLevel(haystack),
      sector: 'Sociale / Educazione',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
    console.log(`  ✅ ${title.substring(0, 70)} → ${hints.city} (${hints.canton})`);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total ${PIGNA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
