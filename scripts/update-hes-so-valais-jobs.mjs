#!/usr/bin/env node
/**
 * Dedicated HES-SO Valais-Wallis crawler runner.
 *
 * HES-SO Valais-Wallis is a bilingual (FR/DE) university of applied sciences
 * in Canton Valais (VS), with campuses in Sion, Sierre, Visp and Saint-Maurice.
 *
 * The careers site is a Nuxt.js 2 SSR page powered by AIO CMS:
 *   FR: https://www.hevs.ch/fr/emplois/
 *   DE: https://www.hevs.ch/de/stellenangebote/
 *   EN: https://www.hevs.ch/en/job-offers/
 *
 * Job data is embedded in the `window.__NUXT__` serialized blob. Each job entry
 * has a `recruitee-*` hash key with URLs under `aio:urls`. Individual job detail
 * pages follow: /fr/recruitee/{slug-with-id}
 *
 * Discovery flow:
 *   1. Fetch the FR listing page (most complete data)
 *   2. Parse job entries from the __NUXT__ data (title, URL, content ID)
 *   3. Optionally fetch DE/EN pages to harvest translated titles
 *   4. Build job objects from extracted data
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
 */
import { sourcePostingDateFields } from './lib/source-posting-date.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergePreserveLocaleData,
  detectLang,
  repairRelabeledSourceLocale,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './lib/target-swiss-locations.mjs';
import { isTargetCanton, TARGET_CANTONS, COMPANY_HQ } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const HESSO_KEY = 'hes-so-valais';
// The old script-filename-derived scratch key (SCRATCH_KEY = basename) was
// unique per-script but did NOT match what runDedicatedBaseCrawler resolves
// internally (crawlerScratchPathFor(companyKeys.join('_'))) when no
// dataJobsPath is passed — so this script's own pre/post-crawl reads/writes
// were still blind to the engine's real output (bug class of #3775/#3768,
// confirmed cause of #3769/#3770). Use the exact same key it passes as
// companyKeys below so both sides agree on one path.
const DATA_JOBS = crawlerScratchPathFor(HESSO_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const HESSO_COMPANY_NAME = 'HES-SO Valais-Wallis';
const HESSO_HOST = 'www.hevs.ch';
const HESSO_COMPANY_DOMAIN = 'hevs.ch';
const HESSO_LOCALES = {
  fr: 'https://www.hevs.ch/fr/emplois/',
  de: 'https://www.hevs.ch/de/stellenangebote/',
  en: 'https://www.hevs.ch/en/job-offers/',
};
const LOCALES = ['it', 'en', 'de', 'fr'];
// Detail pages are read one at a time with a pause (polite to hevs.ch).
const DETAIL_DELAY_MS = Number(process.env.JOBS_HESSO_DETAIL_DELAY_MS) || 600;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
  return truncateSlugAtWordBoundary(s, 200);
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Open each <li> as a line-start bullet so list structure survives the strip (#2476).
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isHessoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === HESSO_KEY ||
    key.startsWith('hes-so-valais') ||
    company.includes('hes-so valais') ||
    url.includes('hevs.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === HESSO_HOST || host.endsWith('.hevs.ch');
  } catch {
    return false;
  }
}

/* ── HTML Fetching ─────────────────────────────────────────── */

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-CH,fr;q=0.9,de-CH;q=0.8,en;q=0.7',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return '';
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/* ── NUXT Data Parsing ─────────────────────────────────────── */

/**
 * Extract job entries from the __NUXT__ serialized data blob.
 *
 * The NUXT data contains AIO CMS content nodes with `recruitee-*` hash keys.
 * Each job node has:
 *   - title: job title string
 *   - description: short excerpt
 *   - aio:urls: locale-keyed URL arrays
 *   - aio:hashKey: "recruitee-XXXXX"
 *   - content_id: numeric ID
 */
export function extractJobsFromNuxtData(html) {
  const jobs = [];

  // Decode NUXT unicode escapes for parsing
  const decoded = html
    .replace(/\\u002F/g, '/')
    .replace(/\\u003C/g, '<')
    .replace(/\\u003E/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\u0022/g, '"');

  // Strategy 1: Extract recruitee URL blocks with associated titles
  // Pattern: title:"Job Title",header:...,description:"...",
  //          ...langs:{fr:["https://www.hevs.ch/fr/recruitee/slug"],de:[...],en:[...]}
  const recruiteeUrlPattern = /langs:\{fr:\["(https:\/\/www\.hevs\.ch\/fr\/recruitee\/[^"]+)"\](?:,de:\["(https:\/\/www\.hevs\.ch\/de\/recruitee\/[^"]+)"\])?(?:,en:\["(https:\/\/www\.hevs\.ch\/en\/recruitee\/[^"]+)"\])?\}/g;

  const urlMatches = [...decoded.matchAll(recruiteeUrlPattern)];

  if (urlMatches.length === 0) {
    console.log('  ℹ️ No recruitee URL patterns found in NUXT data');
    return jobs;
  }

  // For each URL match, find the nearest title and description by scanning backwards
  for (const match of urlMatches) {
    const frUrl = match[1];
    const deUrl = match[2] || '';
    const enUrl = match[3] || '';
    const matchIndex = match.index;

    // Look backwards from the match position for the title
    const beforeContext = decoded.slice(Math.max(0, matchIndex - 2000), matchIndex);

    // Extract the LAST title before the URL — find all matches, take the last
    const titleMatches = [...beforeContext.matchAll(/title:"([^"]+)"/g)];
    const title = titleMatches.length > 0 ? normalizeSpace(titleMatches[titleMatches.length - 1][1]) : '';

    if (!title || title.length < 5) continue;

    // Extract the LAST description before the URL
    const descMatches = [...beforeContext.matchAll(/description:"([^"]*)"/g)];
    const descriptionRaw = descMatches.length > 0 ? descMatches[descMatches.length - 1][1] : '';

    // Extract content ID from URL slug (last numeric part)
    const contentIdMatch = frUrl.match(/-(\d{5,})(?:\/?)?$/);
    const contentId = contentIdMatch ? contentIdMatch[1] : '';

    jobs.push({
      title,
      frUrl,
      deUrl,
      enUrl,
      contentId,
      descriptionRaw: normalizeSpace(stripHtml(descriptionRaw)),
    });
  }

  return jobs;
}

/**
 * Fallback: extract job links from raw HTML anchor tags.
 * Looks for <a href="/fr/recruitee/..."> patterns.
 */
export function extractJobLinksFromHtml(html) {
  const links = [];
  const decoded = html.replace(/\\u002F/g, '/');

  // Match href attributes pointing to recruitee pages
  const linkPattern = /href="(\/fr\/recruitee\/[^"]+)"/g;
  let m;
  while ((m = linkPattern.exec(decoded)) !== null) {
    const path = m[1];
    const fullUrl = `https://www.hevs.ch${path}`;
    if (!links.some((l) => l.url === fullUrl)) {
      links.push({ url: fullUrl, path });
    }
  }

  return links;
}

/* ── Employment rate extraction ────────────────────────────── */

/**
 * Extract employment rate from job title or description.
 * Handles formats like: "80-100%", "80 à 100%", "70%", "40% - 50%", "80% min."
 */
export function extractEmploymentRate(text = '') {
  if (!text) return '';
  const patterns = [
    /(\d{1,3}\s*(?:à|-)\s*\d{1,3}\s*%)/i,
    /(\d{1,3}\s*%\s*(?:à|-)\s*\d{1,3}\s*%)/i,
    /(\d{1,3}\s*%\s*min\.?)/i,
    /(\d{1,3}\s*%\s*(?:ou|or)\s*\d{1,3}\s*%)/i,
    /(\d{1,3}\s*%)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return normalizeSpace(match[1]);
  }
  return '';
}

/* ── Location extraction ──────────────────────────────────── */

const HESSO_LOCATIONS = {
  sion: { city: 'Sion', postal: '1950' },
  sierre: { city: 'Sierre', postal: '3960' },
  visp: { city: 'Visp', postal: '3930' },
  viège: { city: 'Visp', postal: '3930' },
  'saint-maurice': { city: 'Saint-Maurice', postal: '1890' },
  'st-maurice': { city: 'Saint-Maurice', postal: '1890' },
  leukerbad: { city: 'Leukerbad', postal: '3954' },
};

/**
 * Extract location from job text content.
 * All HES-SO Valais-Wallis jobs are in Canton VS.
 */
export function extractLocation(text = '') {
  const lower = normalize(text);
  for (const [key, info] of Object.entries(HESSO_LOCATIONS)) {
    if (lower.includes(key)) return info;
  }
  // Default to Sion (HQ)
  return { city: 'Sion', postal: '1950' };
}

/* ── Category detection ────────────────────────────────────── */

export function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/professeur|enseignant|charg[ée]e?\s*de\s*cours|dozent|lecturer|maître\s*d.enseignement/i.test(t)) return 'education';
  if (/chercheur|research|forsch|post[.-]?doc/i.test(t)) return 'research';
  if (/bibliothé|médiathé|médiathè/i.test(t)) return 'library';
  if (/administ|secrét|gestionnaire/i.test(t)) return 'administration';
  if (/respons|direct|chef|doyen|leiter/i.test(t)) return 'management';
  if (/coordinat/i.test(t)) return 'administration';
  if (/assistant|adjoint|collaborat.*scientifique|scientifique.*collaborat/i.test(t)) return 'research-support';
  if (/collaborat/i.test(t)) return 'research-support';
  if (/technic|laborant|ingénieur/i.test(t)) return 'technology';
  if (/informati|développ|software|IT\b|ICT/i.test(t)) return 'it';
  return 'general';
}

export function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(junior|jr\.?|entry|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagist|stagiaire|apprenti|graduate|trainee)/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|doyen|principal|chief|vp\b|responsable/i.test(t)) return 'SENIOR';
  if (/professeur|professor/i.test(t)) return 'SENIOR';
  if (/post[.-]?doc/i.test(t)) return 'MID';
  return 'MID';
}

export function detectEmploymentType(rate = '', title = '') {
  if (!rate) return 'FULL_TIME';
  // Extract the maximum percentage
  const numbers = rate.match(/\d+/g);
  if (numbers && numbers.length > 0) {
    const maxRate = Math.max(...numbers.map(Number));
    if (maxRate < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Detail page parsing ───────────────────────────────────── */

const RECRUITEE_APPLY_LINK = 'a[href*="recruitee.com/o/"]';

function blockText(node) {
  return normalizeSpace(String(node?.textContent || '').replace(/\u00a0/g, ' '));
}

/**
 * Read the vacancy body of a hevs.ch/<locale>/recruitee/<slug> detail page.
 *
 * The listing's `__NUXT__` blob only carries a ~150-char excerpt; the whole
 * ad (intro, missions, profile, conditions, contact, deadline) lives on the
 * detail page, in the `.row` that sits between the header row and the
 * "POSTULER / BEWERBEN" button row of the same container. HES-SO publishes
 * one bilingual ad: the French text, a `<p>***</p>` separator, then the
 * German text — returned separately so each lands in its own locale.
 *
 * @returns {{ fr: string, de: string }} markdown (empty strings when absent)
 */
export function parseHessoDetailPage(html = '') {
  const empty = { fr: '', de: '' };
  if (!html) return empty;
  const document = new JSDOM(html).window.document;
  const applyRow = document.querySelector(RECRUITEE_APPLY_LINK)?.closest('.row');
  const rows = applyRow?.parentElement ? [...applyRow.parentElement.children] : [];
  const bodyRow = rows
    .filter((row) => row.classList.contains('row') && !row.querySelector(RECRUITEE_APPLY_LINK))
    .sort((a, b) => blockText(b).length - blockText(a).length)[0];
  if (!bodyRow) return empty;

  const parts = { fr: [], de: [] };
  let bucket = 'fr';
  const blocks = bodyRow.querySelectorAll('p, li, h2, h3, h4, h5');
  for (const node of blocks) {
    // A <p> inside an <li> is read through its list item.
    if (node.tagName !== 'LI' && node.closest('li')) continue;
    const text = blockText(node);
    if (!text) continue;
    if (/^\*{3,}$/.test(text)) {
      bucket = 'de';
      continue;
    }
    const tag = node.tagName.toLowerCase();
    const strongOnly = tag === 'p' && node.querySelector('strong, b')
      && blockText(node.querySelector('strong, b')) === text;
    if (tag === 'li') parts[bucket].push(`- ${text}`);
    else if (/^h[2-5]$/.test(tag) || (strongOnly && text.length <= 120)) parts[bucket].push(`## ${text}`);
    else parts[bucket].push(text);
  }
  // Paragraphs and headings are blocks; consecutive list items form one list.
  const toMarkdown = (lines) => {
    const blocksOut = [];
    for (const line of lines) {
      const previous = blocksOut[blocksOut.length - 1];
      if (line.startsWith('- ') && previous?.startsWith('- ')) blocksOut[blocksOut.length - 1] = `${previous}\n${line}`;
      else blocksOut.push(line);
    }
    return blocksOut.join('\n\n').trim();
  };
  return { fr: toMarkdown(parts.fr), de: toMarkdown(parts.de) };
}

/* ── Source bodies ─────────────────────────────────────────── */

/**
 * The text a job publishes, taken ONLY from the ad on its detail page: the
 * French half is the source when it clears the shared word floor, the German
 * half otherwise; the other half, when it clears the floor too, is HES-SO's
 * own translation. Nothing is synthesized: earlier versions published the
 * listing excerpt plus an institution blurb in French, a generic "Offene
 * Stelle an der HES-SO Wallis…" in German and an always-invented English
 * "Open position at HES-SO Valais-Wallis…" (#5253, review of #10348).
 *
 * @returns {{ description: string, sourceLang: string, descriptionByLocale: Record<string, string>, officialDe: string }}
 */
export function hessoSourceBodies(detail = {}) {
  const fr = meetsSourceBodyFloor(detail?.fr) ? String(detail.fr) : '';
  const de = meetsSourceBodyFloor(detail?.de) ? String(detail.de) : '';
  const description = fr || de;
  if (!description) return { description: '', sourceLang: '', descriptionByLocale: {}, officialDe: '' };
  const sourceLang = detectLang(description, fr ? 'fr' : 'de');
  const officialDe = fr && de && sourceLang !== 'de' ? de : '';
  return { description, sourceLang, descriptionByLocale: { [sourceLang]: description }, officialDe };
}

// Text earlier versions invented (see hessoSourceBodies).
const INVENTED_HESSO_TEXT_RE = /HES-SO Valais-Wallis est une haute école spécialisée bilingue|^Poste de .+ à la HES-SO Valais-Wallis|Offene Stelle an der HES-SO Wallis|Die HES-SO Wallis ist eine zweisprachige|Open position at HES-SO Valais-Wallis|HES-SO Valais-Wallis is a bilingual/m;

function storedSourceText(job) {
  return String(job?.description || job?.descriptionByLocale?.[job?.sourceLang] || '');
}

/**
 * Reconcile fresh jobs with stored ones before the shared merge.
 * - A job whose detail page yielded no body keeps the body stored from an
 *   earlier read of the source (description, locale slots, language); with
 *   nothing stored, or only invented text, it is not published this run —
 *   and a stored record holding only invented text is not carried over.
 * @returns {{ existingForMerge: object[], discoveredForMerge: object[], skipped: number }}
 */
export function prepareHessoMerge(existingJobs = [], discoveredJobs = []) {
  const keyOf = (job) => extractStableJobId(job?.url) || job?.url;
  const existingByKey = new Map(existingJobs.map((job) => [keyOf(job), job]));
  const dropKeys = new Set();
  const discoveredForMerge = [];
  let skipped = 0;
  for (const job of discoveredJobs) {
    if (job.description) {
      discoveredForMerge.push(job);
      continue;
    }
    const previous = existingByKey.get(keyOf(job));
    const stored = storedSourceText(previous);
    if (!stored || INVENTED_HESSO_TEXT_RE.test(stored)) {
      console.log(`  ⏭️  Not publishing ${job.title || job.url}: no vacancy body and none stored from the source`);
      if (previous) dropKeys.add(keyOf(job));
      skipped++;
      continue;
    }
    discoveredForMerge.push({
      ...job,
      description: previous.description || stored,
      descriptionByLocale: { ...(previous.descriptionByLocale || {}) },
      sourceLang: previous.sourceLang,
    });
  }
  const existingForMerge = existingJobs.filter((job) => !dropKeys.has(keyOf(job)));
  return { existingForMerge, discoveredForMerge, skipped };
}

/**
 * Drop stored slots made of invented text, and every non-source translation
 * of a stored source that carried it (their wording is a translation of the
 * blurb, not of the ad), then flag the job for retranslation.
 */
export function dropInventedHessoLocaleText(mergedJobs, existingJobs = []) {
  const keyOf = (job) => extractStableJobId(job?.url) || job?.url;
  const previousByKey = new Map(existingJobs.map((job) => [keyOf(job), job]));
  for (const job of mergedJobs) {
    const translatedFromInvented = INVENTED_HESSO_TEXT_RE.test(storedSourceText(previousByKey.get(keyOf(job))));
    let dropped = false;
    for (const [locale, text] of Object.entries(job.descriptionByLocale || {})) {
      if (locale === job.sourceLang) continue;
      if (translatedFromInvented || INVENTED_HESSO_TEXT_RE.test(String(text || ''))) {
        delete job.descriptionByLocale[locale];
        dropped = true;
      }
    }
    if (dropped) job.needsRetranslation = true;
  }
  return mergedJobs;
}

/* ── Fetch and build all HES-SO jobs ─────────────────────────── */

export async function fetchHessoJobs() {
  console.log(`🔍 Fetching HES-SO Valais-Wallis jobs`);
  console.log(`   FR page: ${HESSO_LOCALES.fr}`);
  console.log(`   DE page: ${HESSO_LOCALES.de}`);
  console.log(`   EN page: ${HESSO_LOCALES.en}\n`);

  // Fetch FR page (primary — most complete)
  const htmlFr = await fetchHtml(HESSO_LOCALES.fr);
  if (!htmlFr) {
    console.warn('⚠️ Failed to fetch FR jobs page.');
    return [];
  }

  console.log(`  📄 FR page fetched: ${(htmlFr.length / 1024).toFixed(0)} KB`);

  // Strategy 1: Extract from NUXT data
  let nuxtJobs = extractJobsFromNuxtData(htmlFr);

  // Strategy 2: Fallback to HTML link extraction
  if (nuxtJobs.length === 0) {
    console.log('  ℹ️ NUXT extraction yielded 0 jobs, trying HTML link fallback...');
    const links = extractJobLinksFromHtml(htmlFr);
    for (const link of links) {
      // Extract title from URL slug
      const slugPart = link.path.replace(/^\/fr\/recruitee\//, '').replace(/-\d+$/, '');
      const title = normalizeSpace(
        slugPart.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      );
      nuxtJobs.push({
        title,
        frUrl: link.url,
        deUrl: link.url.replace('/fr/recruitee/', '/de/recruitee/'),
        enUrl: link.url.replace('/fr/recruitee/', '/en/recruitee/'),
        contentId: '',
        descriptionRaw: '',
      });
    }
  }

  if (nuxtJobs.length === 0) {
    console.warn('⚠️ No jobs found in page content.');
    return [];
  }

  console.log(`  📋 Job entries extracted: ${nuxtJobs.length}`);

  // Build job objects
  const jobs = [];
  for (const entry of nuxtJobs) {
    const { title, frUrl, deUrl, enUrl, descriptionRaw } = entry;

    if (!title || title.length < 5) continue;
    if (!frUrl) continue;

    // The listing only carries an excerpt: read the ad from its detail page.
    // A page without a body leaves the job to prepareHessoMerge (stored body
    // or not published this run).
    const detail = parseHessoDetailPage(await fetchHtml(frUrl));
    const bodies = hessoSourceBodies(detail);
    if (!bodies.description) console.warn(`  ⚠️ No vacancy body read from ${frUrl}`);
    await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));

    // Extract employment rate from title
    const rate = extractEmploymentRate(title);

    // Extract location from description or default to Sion
    const locationInfo = extractLocation(descriptionRaw || title);
    const city = locationInfo.city;
    const postalCode = locationInfo.postal;

    const slug = slugify(title, HESSO_KEY);
    // sourceLang is detected on the published body, not on the bilingual
    // title ("Collaboratrice ou collaborateur technique *** Technischer
    // Mitarbeiter"), which read as Italian and filed French under `it`.
    const { description, sourceLang, descriptionByLocale, officialDe } = bodies;

    const job = {
      url: frUrl,
      applyUrl: frUrl,
      title,
      company: HESSO_COMPANY_NAME,
      companyKey: HESSO_KEY,
      location: city,
      postalCode,
      canton: 'VS',
      country: 'CH',
      description,
      descriptionByLocale,
      titleByLocale: {
        fr: title,
      },
      slug,
      slugByLocale: {
        fr: slug,
      },
      category: detectCategory(title),
      ...sourcePostingDateFields(),
      source: 'hes-so-valais-crawler',
      sourceLang,
      employmentType: detectEmploymentType(rate, title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Istruzione / Ricerca',
      _targetScope: { canton: 'VS', location: city },
    };

    if (rate) job.employmentRate = rate;
    if (officialDe) OFFICIAL_DESCRIPTIONS.set(job, { de: officialDe });

    // Add DE/EN URLs if available
    if (deUrl) {
      job.urlByLocale = { fr: frUrl, de: deUrl };
      if (enUrl) job.urlByLocale.en = enUrl;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total unique HES-SO jobs built: ${jobs.length}`);
  return jobs;
}

// Built job → the German half of HES-SO's bilingual ad. Kept beside the job
// (not on it) so it never reaches the persisted slice.
const OFFICIAL_DESCRIPTIONS = new WeakMap();

/**
 * `mergePreserveLocaleData` keeps the stored text of every non-source locale,
 * which for German is the generic "Offene Stelle an der HES-SO Wallis…"
 * placeholder of earlier runs. The German half of the ad is written by
 * HES-SO itself, so it replaces whatever is stored.
 */
export function applyOfficialHessoDescriptions(mergedJobs, freshJobs) {
  const officialByKey = new Map();
  for (const job of freshJobs) {
    const official = OFFICIAL_DESCRIPTIONS.get(job);
    const key = extractStableJobId(job?.url) || job?.url;
    if (key && official) officialByKey.set(key, official);
  }
  for (const job of mergedJobs) {
    const official = officialByKey.get(extractStableJobId(job?.url) || job?.url);
    if (official) job.descriptionByLocale = { ...(job.descriptionByLocale || {}), ...official };
  }
  return mergedJobs;
}

/**
 * Earlier runs detected sourceLang on the bilingual title and stored the
 * French text as `it` (then machine-"translated" it from that mislabel).
 * When the fresh crawl derives a different sourceLang, drop the verbatim
 * mislabeled copy and let the pipeline retranslate from the right source —
 * the same repair ferrovia-retica applies (#3802).
 */
export function repairHessoRelabeledSource(mergedJobs, existingJobs, freshJobs) {
  const keyOf = (job) => extractStableJobId(job?.url) || job?.url;
  const previousByKey = new Map(existingJobs.map((job) => [keyOf(job), job]));
  const freshByKey = new Map(freshJobs.map((job) => [keyOf(job), job]));
  for (const job of mergedJobs) {
    const previous = previousByKey.get(keyOf(job));
    const fresh = freshByKey.get(keyOf(job));
    if (!previous || !fresh || !previous.sourceLang || previous.sourceLang === fresh.sourceLang) continue;
    const relabel = { prevLang: previous.sourceLang, nextLang: fresh.sourceLang };
    job.titleByLocale = repairRelabeledSourceLocale(job.titleByLocale, {
      ...relabel,
      sourceTexts: [fresh.title, previous.title],
    }).map;
    job.descriptionByLocale = repairRelabeledSourceLocale(job.descriptionByLocale, {
      ...relabel,
      sourceTexts: [fresh.description, previous.description],
    }).map;
    job.needsRetranslation = true;
  }
  return mergedJobs;
}

/* ── Merge into data/jobs.json ─────────────────────────────── */

async function mergeHessoJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(HESSO_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonHessoJobs = allJobs.filter((j) => !isHessoJob(j));
  const existingHessoJobs = allJobs.filter(isHessoJob);

  // Stats only — computed on the same stable key mergePreserveLocaleData
  // matches on (extractStableJobId(url)), NOT the raw URL. A vendor
  // title/slug rewrite otherwise made the raw-URL match miss, so the old
  // record's previousSlugs/previousSlugsByLocale/firstSeenAt was dropped
  // as "no longer in the feed" while the fresh job was pushed as new
  // (issue #3699).
  const { existingForMerge, discoveredForMerge, skipped } = prepareHessoMerge(existingHessoJobs, discoveredJobs);
  const existingKeys = new Set(existingHessoJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredForMerge.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // Delegate the actual old<->fresh reconciliation (incl. slug-rename
  // protection via isSlugStable/addPreviousSlugForLocale, already keyed
  // correctly by stable id) to the shared merge helper. company/companyKey/
  // country/canton force-normalization and the location default are
  // handled independently by postProcessHessoJobs() right after this
  // function runs, so no constant-field overrides need to be reapplied here.
  const mergedHessoJobs = applyOfficialHessoDescriptions(
    dropInventedHessoLocaleText(
      repairHessoRelabeledSource(
        mergePreserveLocaleData(existingForMerge, discoveredForMerge),
        existingForMerge,
        discoveredForMerge,
      ),
      existingForMerge,
    ),
    discoveredForMerge,
  );

  const final = [...nonHessoJobs, ...mergedHessoJobs];

  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  if (skipped) console.log(`  ⏭️  Not published (no vacancy body): ${skipped}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, skipped, total: final.length };
}

/* ── Adapter management ────────────────────────────────────── */

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${HESSO_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = HESSO_KEY;
  adapter.companyName = HESSO_COMPANY_NAME;
  adapter.companyHost = HESSO_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html-scraping'];
  adapter.seedUrls = [HESSO_LOCALES.fr, HESSO_LOCALES.de, HESSO_LOCALES.en];
  adapter.notes = 'Nuxt.js 2 SSR page with AIO CMS — job entries in __NUXT__ data blob. All jobs in Canton VS.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${HESSO_KEY} updated.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: HESSO_KEY,
    localizeOnlyCompanyKeys: HESSO_KEY,
    forceLocalizeKeys: HESSO_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */

function postProcessHessoJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isHessoJob(job)) continue;

    if (job.company !== HESSO_COMPANY_NAME) {
      job.company = HESSO_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== HESSO_KEY) {
      job.companyKey = HESSO_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (job.canton !== 'VS') {
      job.canton = 'VS';
      fixed++;
    }
    if (!job.location) {
      job.location = 'Sion';
      fixed++;
    }
  }

  if (fixed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    writeJsonAtomic(PUBLIC_JOBS, jobs);
    console.log(`🔧 Post-processed ${fixed} HES-SO jobs (fixed company/location/canton).`);
  }
}

/* ── Stats & validation ────────────────────────────────────── */

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const hessoJobs = allJobs.filter(isHessoJob);

  console.log(`\n📊 === HES-SO Valais-Wallis Job Stats ===`);
  console.log(`  🎓 Total HES-SO jobs: ${hessoJobs.length}`);

  if (hessoJobs.length > 0) {
    const byCategory = {};
    for (const job of hessoJobs) {
      const c = job.category || 'general';
      byCategory[c] = (byCategory[c] || 0) + 1;
    }
    console.log(`  📂 By category:`);
    for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${cat}: ${count} jobs`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(hessoJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'HES-SO Valais-Wallis');
  writeCrawlChangeSummaryToGH(crawlDiff, 'HES-SO Valais-Wallis');
  return { total: hessoJobs.length, crawlDiff };
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_HESSO_STRICT',
    label: 'HES-SO Valais-Wallis',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isHessoJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_hevs_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No HES-SO jobs found — the institution may not have active openings.',
  });
}

async function rewriteStoredJobsWithoutThinSource(storedJobs) {
  return rewritePreparedStoredJobs({
    prepare: (jobs) => jobs,
    storedJobs,
    companyKey: HESSO_KEY,
    companyLabel: HESSO_COMPANY_NAME,
    write: (jobs, options) => writeJobsCrawlerSliceVerified(HESSO_KEY, jobs, {
      isTargetJob: isHessoJob,
      ...options,
    }),
    assemble: () => assembleJobsDataset(),
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(HESSO_KEY, 'HES-SO Valais-Wallis');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  HES-SO Valais-Wallis — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  FR page: ${HESSO_LOCALES.fr}`);
  console.log(`  DE page: ${HESSO_LOCALES.de}`);
  console.log(`  EN page: ${HESSO_LOCALES.en}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(HESSO_KEY, DATA_JOBS).filter(isHessoJob));

  // Phase 1: Fetch jobs from HES-SO website
  const discoveredJobs = await fetchHessoJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No HES-SO jobs discovered.');
    console.log('   The website may have changed structure or be temporarily unavailable.');
    console.log('   Keeping valid existing jobs and quarantining thin-source rows.');
    await rewriteStoredJobsWithoutThinSource(
      readExistingCrawlerJobs(HESSO_KEY, DATA_JOBS).filter(isHessoJob),
    );
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeHessoJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (IT translations)
  console.log('\n🌐 Running base crawler for AI localization of HES-SO jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessHessoJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No HES-SO jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ HES-SO Valais-Wallis crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isHessoJob) : [];
  writeJobsCrawlerSlice(HESSO_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: HESSO_KEY,
    label: 'HES-SO Valais-Wallis',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

// Only run when executed directly, not when imported by tests
const _isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (_isMain) {
  main().catch((err) => exitCrawlerOnError(err, 'HES-SO Valais-Wallis'));
}
