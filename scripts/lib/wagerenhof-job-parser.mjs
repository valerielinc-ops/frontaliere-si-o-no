#!/usr/bin/env node
/**
 * Stiftung Wagerenhof — Uster (ZH).
 *
 * Disability-services foundation (Wohnen + Arbeit + Tagesstrukturen) with
 * main campus in Uster and additional locations in the Tösstal (Strahlegg,
 * Steg). About 1'000 people live and work there.
 *
 * Public career site:
 *   https://www.wagerenhof.ch/wagerenhof/arbeiten-beim-wagerenhof/offene-stellen
 *
 * Custom TYPO3 page; vacancies render server-side as <li>…<a href="…vacancy-details?reference=…"> …
 * with <span class="job-title">TITLE</span> and a <span class="job-count">DATE</span>.
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

export const WAGERENHOF_KEY = 'wagerenhof';
export const WAGERENHOF_COMPANY_NAME = 'Stiftung Wagerenhof';
export const WAGERENHOF_COMPANY_DOMAIN = 'wagerenhof.ch';

const BASE_URL = 'https://www.wagerenhof.ch';
const LISTING_URL = `${BASE_URL}/wagerenhof/arbeiten-beim-wagerenhof/offene-stellen`;

const DEFAULT_CITY = 'Uster';
const DEFAULT_CANTON = 'ZH';
const DEFAULT_POSTAL = '8610';

export function isWagerenhofJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  return (
    key === WAGERENHOF_KEY ||
    url.includes('wagerenhof.ch') ||
    company.includes('wagerenhof')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'wagerenhof.ch' || host.endsWith('.wagerenhof.ch');
  } catch {
    return false;
  }
}

function decodeUrlEntities(href = '') {
  return String(href || '').replace(/&amp;/g, '&');
}

export function parseWagerenhofListing(html = '') {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  // Each vacancy is an <a href="…vacancy-details?reference=…">
  //   <span class="job-title">TITLE</span>
  //   <span class="job-count">DATE</span>
  // </a>
  const rx = /<a\s+href="([^"]*vacancy-details[^"]+)"[^>]*>\s*<span class="job-title">([\s\S]*?)<\/span>\s*<span class="job-count">([\s\S]*?)<\/span>\s*<\/a>/g;
  let m;
  while ((m = rx.exec(html))) {
    let href = decodeUrlEntities(m[1]);
    if (!href.startsWith('http')) href = `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
    const title = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, '')));
    const dateLabel = normalizeSpace(decodeEntities(m[3].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 4) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const refMatch = href.match(/reference=([^&]+)/);
    const reference = refMatch ? decodeURIComponent(refMatch[1]) : '';
    out.push({ url: href, title, dateLabel, reference });
  }
  return out;
}

export function parseWagerenhofDetail(html = '') {
  if (!html) return { title: '', description: '' };
  // The detail page repeats the title in <h1 style="…">TITLE</h1> and lists
  // multiple <p> blocks plus <ul>/<li> with the role profile.
  const titleMatch = html.match(/<h1[^>]*style="color:[^"]+"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
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
    if (text.length > 25 && !/cookie|datenschutz|impressum|newsletter abonnieren|raisenow|wagerenhof kontaktieren|vacancy details|seite teilen|sitemap|disclaimer/i.test(text)) {
      parts.push(tag === 'li' ? `• ${text}` : text);
    }
  }
  return { title, description: parts.join('\n') };
}

function pickLocationHints(title = '', description = '') {
  // Title or body sometimes mentions Tösstal locations (Steg, Strahlegg).
  const text = `${title} ${description}`.toLowerCase();
  if (/strahlegg|tösstal|tosstal/i.test(text)) return { city: 'Bauma', canton: 'ZH', postal: '8494' };
  if (/\bsteg\b/i.test(text)) return { city: 'Fischenthal', canton: 'ZH', postal: '8497' };
  const inferred = inferSwissTargetCanton(DEFAULT_CITY);
  return { city: DEFAULT_CITY, canton: inferred || DEFAULT_CANTON, postal: DEFAULT_POSTAL };
}

function buildFallbackDescription(title) {
  return [
    `${title} bei ${WAGERENHOF_COMPANY_NAME} in Uster (ZH).`,
    '',
    'Die Stiftung Wagerenhof ist eine Wohn-, Arbeits- und Lebensgemeinschaft für rund 1\'000 Menschen mit kognitiven Beeinträchtigungen. Im Wagerenhof leben und arbeiten Fachmitarbeitende, Mitarbeitende an geschützten Arbeitsplätzen sowie Bewohnerinnen und Bewohner Hand in Hand.',
    '',
    'Was der Wagerenhof bietet:',
    '• Interdisziplinäre Zusammenarbeit über Bereiche und Stufen hinweg',
    '• Sinnstiftende Tätigkeit in einem engagierten Team',
    '• Vielfältige Aus- und Weiterbildungsmöglichkeiten',
    '• Faire Anstellungsbedingungen',
  ].join('\n');
}

export async function fetchAllWagerenhofJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`🏡 Fetching ${WAGERENHOF_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch Wagerenhof listing: ${err?.message || err}`);
  }

  const listings = parseWagerenhofListing(listingHtml);
  console.log(`  📋 Found ${listings.length} positions on listing\n`);
  if (!listings.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of listings) {
    let detail = { title: '', description: '' };
    try {
      const detailHtml = await fetchHtml(it.url, { timeoutMs });
      detail = parseWagerenhofDetail(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${it.title}: ${err?.message || err}`);
    }

    const title = detail.title || it.title;
    const description = detail.description && detail.description.split(/\s+/).length >= 40
      ? detail.description
      : buildFallbackDescription(title);

    const hints = pickLocationHints(title, description);
    const haystack = `${title} ${description}`;
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${WAGERENHOF_KEY} ${hints.city}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${WAGERENHOF_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: WAGERENHOF_COMPANY_NAME,
      companyKey: WAGERENHOF_KEY,
      companyDomain: WAGERENHOF_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: hints.city,
      canton: hints.canton,
      url: it.url,
      source: 'Wagerenhof Dedicated Parser (TYPO3 HTML)',
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

  console.log(`\n📋 Total ${WAGERENHOF_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
