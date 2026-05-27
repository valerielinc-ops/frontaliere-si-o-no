#!/usr/bin/env node
/**
 * Dedicated SBB (FFS – Ferrovie Federali Svizzere) crawler runner.
 *
 * SBB's careers portal at company.sbb.ch uses a custom AEM-based JSON API
 * backed by SAP SuccessFactors. The listing page is a JavaScript SPA that
 * cannot be crawled directly. Instead, this script:
 *
 *   1. Fetches the company.sbb.ch JSON API to discover SBB/FFS roles in Ticino/Grigioni.
 *   2. Fetches login.org apprenticeship pages (partner=SBB CFF FFS, canton=Ticino)
 *      to include apprenticeship positions not exposed by the company.sbb.ch API.
 *   3. Merges and de-duplicates detail URLs from both sources as adapter seeds.
 *   4. Runs the base crawler which fetches each detail page and parses content.
 *
 * API endpoint:
 *   https://company.sbb.ch/content/internet/corporate/it/jobs-karriere/jobs/
 *     job-suche/jcr:content/parmain/jobfilter.results.json
 *
 * Apprenticeship listing endpoint:
 *   https://www.login.org/it/panoramica-dei-posti-di-tirocinio-disponibili-nel
 *     ?f[0]=canton:296&f[1]=facet_apprentice_partner:SBB CFF FFS
 *
 * Detail page URL pattern:
 *   https://jobs.sbb.ch/v2/offene-stellen/{slug}/{viewkey-uuid}
 *
 * The detail pages are fully SSR with schema.org/JobPosting JSON-LD,
 * so the base crawler's extractJsonLdBlocks() parses them correctly.
 *
 * Job attribute codes in the API:
 *   110 = regions (e.g. "Ticino (TI)", "Berna Mittelland (BE/SO/AG)")
 *   100 = city (e.g. "Bellinzona", "Biasca")
 *    50 = employment type ("Tempo pieno", "Tempo parziale")
 *   160 = work percentage ("60-100%", "80-100%")
 *    20 = profession category
 *    60 = experience level ("Professionisti", "Studenti", "Apprendisti")
 *   130 = homeoffice ("true"/"false")
 *    65 = country ("Schweiz")
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { translateMissingJobLocales, validateDedicatedLocaleCoverage, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { freeTranslateWithRetry } from './lib/free-translate.mjs';
import { GRIGIONI_CITIES, TICINO_CITIES, inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation } from './lib/target-swiss-locations.mjs';
import { parseSbbDetailPage, MIN_SBB_DESC_LENGTH } from './lib/sbb-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const SBB_KEY = 'ffs-officine-ferrovie-federali';
const DEFAULT_CANTON = getCompanyDefaults(SBB_KEY)?.canton || 'TI';
/**
 * SBB AEM JSON API endpoint.
 * Returns a flat JSON array of ALL open positions across Switzerland.
 * The region filter parameter is cosmetic (client-side only) — the API
 * always returns all jobs.
 */
const SBB_API_URL =
  'https://company.sbb.ch/content/internet/corporate/it/jobs-karriere/jobs/job-suche/jcr:content/parmain/jobfilter.results.json';

/**
 * We use the API region and city attributes together to keep only TI/GR jobs.
 */
const LOGIN_SBB_LISTING_URL =
  'https://www.login.org/it/panoramica-dei-posti-di-tirocinio-disponibili-nel?f%5B0%5D=canton%3A296&f%5B1%5D=facet_apprentice_partner%3ASBB%20CFF%20FFS';
const LOGIN_MAX_PAGES = 8;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function detectLang(text = '') {
  return detectLanguage(text, 'it');
}

/**
 * Match a job object as belonging to the SBB/FFS crawl.
 */
function isSbbJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === SBB_KEY ||
    key.includes('ffs-officine') ||
    key.includes('ferrovie-federali') ||
    host.includes('jobs.sbb.ch') ||
    host.includes('company.sbb.ch') ||
    host.includes('login.org') ||
    (company.includes('sbb') && !company.includes('subsidiary')) ||
    company.includes('ffs') ||
    company.includes('ferrovie federali')
  );
}

/**
 * Check whether a URL belongs to one of SBB's trusted domains.
 */
function isTrustedSbbDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.endsWith('sbb.ch') ||
      host.endsWith('ffs.ch') ||
      host.endsWith('login.org') ||
      host.includes('successfactors.eu')
    );
  } catch {
    return false;
  }
}

function deriveLocalizedSlug(job, locale) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  return String(job?.slug || '').trim();
}

// ──────────────────────────────────────────────────────────────
// SBB JSON API fetching
// ──────────────────────────────────────────────────────────────

/**
 * Fetch a URL with timeout and User-Agent header.
 * Returns the response body as text, or null on failure.
 */
async function fetchPage(url, timeoutMs = 15000, accept = 'application/json') {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: accept,
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

function decodeHtmlHref(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .trim();
}

function extractLoginDetailUrlsFromHtml(html = '') {
  const urls = new Set();
  const re = /<a[^>]+href="([^"]+)"/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = decodeHtmlHref(match[1]);
    if (!href || href.startsWith('#')) continue;
    if (!/^\/it\/\d+-[a-z0-9-]+$/i.test(href) && !/^https?:\/\/www\.login\.org\/it\/\d+-[a-z0-9-]+$/i.test(href)) {
      continue;
    }
    try {
      urls.add(new URL(href, 'https://www.login.org').toString());
    } catch {}
  }
  return [...urls];
}

function extractLoginPaginationUrlsFromHtml(html = '') {
  const urls = new Set();
  const re = /<a[^>]+href="([^"]+)"/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = decodeHtmlHref(match[1]);
    if (!href) continue;
    if (!/panoramica-dei-posti-di-tirocinio-disponibili-nel/i.test(href)) continue;
    if (!/start(?:%3A|:)\d+/i.test(href)) continue;
    if (!/facet_apprentice_partner(?:%3A|:)\s*SBB(?:%20|\s)CFF(?:%20|\s)FFS/i.test(href)) continue;
    try {
      urls.add(new URL(href, 'https://www.login.org').toString());
    } catch {}
  }
  return [...urls];
}

async function fetchLoginSbbDetailUrls() {
  console.log('🔍 Fetching SBB apprenticeship jobs from login.org...');
  console.log(`  📡 ${LOGIN_SBB_LISTING_URL}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const queue = [LOGIN_SBB_LISTING_URL];
  const visited = new Set();
  const detailUrls = new Set();

  while (queue.length > 0 && visited.size < LOGIN_MAX_PAGES) {
    const pageUrl = queue.shift();
    if (!pageUrl || visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    const html = await fetchPage(pageUrl, timeoutMs, 'text/html,application/xhtml+xml');
    if (!html) {
      console.warn(`⚠️ Failed to fetch login.org listing page: ${pageUrl}`);
      continue;
    }

    const pageDetails = extractLoginDetailUrlsFromHtml(html);
    const pagerLinks = extractLoginPaginationUrlsFromHtml(html);
    for (const u of pageDetails) detailUrls.add(u);
    for (const u of pagerLinks) {
      if (!visited.has(u) && !queue.includes(u)) queue.push(u);
    }
    console.log(`  📄 login page ${visited.size}: +${pageDetails.length} detail URL(s), pager links: ${pagerLinks.length}`);
  }

  console.log(`✅ Total login.org SBB apprenticeship URLs discovered: ${detailUrls.size}`);
  return [...detailUrls];
}

export function extractLoginLocalizedPageData(html = '') {
  const pageLocale = (() => {
    const lang = String(html.match(/<html[^>]+lang="([^"]+)"/i)?.[1] || '').toLowerCase();
    if (lang.startsWith('de')) return 'de';
    if (lang.startsWith('fr')) return 'fr';
    if (lang.startsWith('en')) return 'en';
    return 'it';
  })();
  const headingMap = {
    it: {
      general: 'Informazioni generali',
      flow: 'Svolgimento del tirocinio',
      tasks: 'I tuoi compiti',
      profile: 'Cosa porti con te',
      advantages: 'I tuoi vantaggi',
      offer: 'Cosa abbiamo da offrirti',
      orientation: "Tirocinio d'orientamento",
      application: 'La tua candidatura completa',
      contacts: 'Hai domande?',
    },
    de: {
      general: 'Allgemeine Informationen',
      flow: 'Ablauf der Ausbildung',
      tasks: 'Deine Aufgaben',
      profile: 'Was du mitbringst',
      advantages: 'Deine Vorteile',
      offer: 'Was wir dir bieten',
      orientation: 'Schnupperlehre',
      application: 'Deine vollständige Bewerbung',
      contacts: 'Hast du Fragen?',
    },
    fr: {
      general: 'Informations générales',
      flow: "Déroulement de l'apprentissage",
      tasks: 'Tes tâches',
      profile: 'Ce que tu apportes',
      advantages: 'Tes avantages',
      offer: 'Ce que nous avons à offrir',
      orientation: "Stage d'orientation",
      application: 'Ton dossier de candidature complet',
      contacts: 'Des questions ?',
    },
    en: {
      general: 'General information',
      flow: 'Training path',
      tasks: 'Your tasks',
      profile: 'What you bring',
      advantages: 'Your benefits',
      offer: 'What we offer',
      orientation: 'Orientation internship',
      application: 'Your complete application',
      contacts: 'Questions?',
    },
  }[pageLocale];

  const title = stripHtml(String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');

  const extractFieldItemHtml = (fieldClass) => String(
    html.match(new RegExp(`${fieldClass}[\\s\\S]*?<div class="field__item">([\\s\\S]*?)<\\/div>\\s*<\\/div>`, 'i'))?.[1] ||
    html.match(new RegExp(`${fieldClass}[\\s\\S]*?<div[^>]*class="[^"]*field__item[^"]*"[^>]*>([\\s\\S]*?)<\\/div>\\s*<\\/div>`, 'i'))?.[1] ||
    ''
  );

  const extractFieldLabelValuePairs = () => {
    const pairs = [];
    const re = /<div class="field ([^"]*field--name-field-job-[^"]*)"[\s\S]*?<div class="field__label[^"]*">\s*([^<]+?)\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
      const label = stripHtml(match[2]);
      const value = stripHtml(match[3]);
      if (!label || !value) continue;
      pairs.push({ label: label.replace(/:$/, '').trim(), value: value.trim() });
    }
    return pairs;
  };

  const extractListField = (fieldClass) => {
    const sectionHtml = extractFieldItemHtml(fieldClass);
    return parseHtmlListItems(sectionHtml, 20);
  };

  const extractParagraphField = (fieldClass) => {
    const sectionHtml = extractFieldItemHtml(fieldClass);
    const lines = stripHtml(sectionHtml)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('- '));
    return [...new Set(lines)];
  };

  const extractAdvantageCards = () => {
    const sectionHtml = String(
      html.match(/profession__advantages[\s\S]*?field--name-field-list-block-icon-list[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<div class="profession__application/si)?.[0] ||
      html.match(/profession__advantages[\s\S]*?profession__application/si)?.[0] ||
      ''
    );
    const cards = [];
    const re = /field--name-field-pg-icotext-title[^>]*>([\s\S]*?)<\/div>[\s\S]*?field--name-field-pg-icotext-text[^>]*>([\s\S]*?)<\/div>/gi;
    let match;
    while ((match = re.exec(sectionHtml)) !== null) {
      const cardTitle = stripHtml(match[1]);
      const cardText = stripHtml(match[2]);
      if (!cardTitle || !cardText) continue;
      cards.push(`${cardTitle}: ${cardText}`);
    }
    return [...new Set(cards)];
  };

  const shortDescription = stripHtml(
    String(html).match(/field--name-field-profession-short-desc[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ||
    String(html).match(/field--name-field-profession-short-desc[\s\S]*?<div class="field__item">([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ||
    extractFieldItemHtml('field--name-field-profession-short-desc') ||
    ''
  );

  const plain = stripHtml(html);
  const locationField = stripHtml(
    String(
      html.match(/field--name-field-job-umantis-ort[\s\S]*?<div[^>]*class="[^"]*align-baseline[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ||
      html.match(/field--name-field-job-umantis-ort[\s\S]*?<div[^>]*class="[^"]*field__item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ||
      ''
    )
  );
  const titleLocation = title.includes(',') ? title.split(',').pop()?.trim() || '' : '';
  const location =
    locationField ||
    titleLocation ||
    String(plain.match(/(?:Luogo|Ort|Lieu|Location)\s*:?\s*([^\n]{2,120})/i)?.[1] || '')
      .split(/\s{2,}|\n/)
      .map((part) => part.trim())
      .filter(Boolean)[0] || '';

  const generalInfo = extractFieldLabelValuePairs()
    .filter((entry) => !/partner/i.test(entry.label))
    .map(({ label, value }) => `${label}: ${value}`);
  const apprenticeshipFlow = (() => {
    const section = String(html.match(/profession__duration[\s\S]*?profession__requirements/si)?.[0] || '');
    return [...section.matchAll(/<div class="field__label[^"]*">([\s\S]*?)<\/div>[\s\S]*?<p>([\s\S]*?)<\/p>/gi)]
      .map((match) => `${stripHtml(match[1])}: ${stripHtml(match[2])}`)
      .filter(Boolean);
  })();
  const tasks = extractListField('field--name-field-profession-tasks');
  const profileBullets = extractListField('field--name-field-profession-profile');
  const profileNotes = extractParagraphField('field--name-field-profession-profile');
  const advantages = extractAdvantageCards();
  const offer = extractListField('field--name-field-profession-expectations');
  const orientation = extractListField('field--name-field-profession-trial-info');
  const applicationDocs = extractListField('field--name-field-profession-cv-docs');
  const contactLines = (() => {
    const sectionHtml = extractFieldItemHtml('field--name-field-job-world-contact-text');
    const lines = stripHtml(sectionHtml).split('\n').map((line) => line.trim()).filter(Boolean);
    const phone = String(html.match(/href="tel:([^"]+)"/i)?.[1] || '').trim();
    const email = String(html.match(/href="mailto:([^"]+)"/i)?.[1] || '').trim();
    if (phone) lines.push(`Telefono: ${decodeHtmlEntities(phone)}`);
    if (email) lines.push(`Email: ${decodeHtmlEntities(email)}`);
    return [...new Set(lines)];
  })();

  const sections = [];
  if (shortDescription) sections.push(shortDescription);
  if (generalInfo.length > 0) sections.push(`## ${headingMap.general}\n${generalInfo.map((item) => `- ${item}`).join('\n')}`);
  if (apprenticeshipFlow.length > 0) sections.push(`## ${headingMap.flow}\n${apprenticeshipFlow.map((item) => `- ${item}`).join('\n')}`);
  if (tasks.length > 0) sections.push(`## ${headingMap.tasks}\n${tasks.map((item) => `- ${item}`).join('\n')}`);
  if (profileBullets.length > 0 || profileNotes.length > 0) {
    sections.push([
      `## ${headingMap.profile}`,
      ...profileBullets.map((item) => `- ${item}`),
      ...profileNotes.filter((line) => !profileBullets.includes(line)),
    ].join('\n'));
  }
  if (advantages.length > 0) sections.push(`## ${headingMap.advantages}\n${advantages.map((item) => `- ${item}`).join('\n')}`);
  if (offer.length > 0) sections.push(`## ${headingMap.offer}\n${offer.map((item) => `- ${item}`).join('\n')}`);
  if (orientation.length > 0) sections.push(`## ${headingMap.orientation}\n${orientation.map((item) => `- ${item}`).join('\n')}`);
  if (applicationDocs.length > 0) sections.push(`## ${headingMap.application}\n${applicationDocs.map((item) => `- ${item}`).join('\n')}`);
  if (contactLines.length > 0) sections.push(`## ${headingMap.contacts}\n${contactLines.join('\n')}`);
  const description = sections.join('\n\n').trim();

  return {
    title: String(title || '').trim(),
    description: String(description || '').trim(),
    location: String(location || '').trim(),
    requirements: profileBullets,
  };
}

async function fetchLoginLocalizedVariants(detailUrl, timeoutMs = 15000) {
  const variants = {};
  const baseUrl = new URL(detailUrl);

  for (const locale of ['it', 'de', 'fr']) {
    const localizedUrl = new URL(baseUrl.toString());
    localizedUrl.pathname = localizedUrl.pathname.replace(/^\/(it|de|fr)\//i, `/${locale}/`);
    const html = await fetchPage(localizedUrl.toString(), timeoutMs, 'text/html,application/xhtml+xml');
    if (!html) continue;
    const parsed = extractLoginLocalizedPageData(html);
    if (!parsed.title || !parsed.description) continue;
    variants[locale] = parsed;
  }

  return variants;
}

/**
 * Fetch ALL SBB Ticino job detail URLs from the JSON API.
 *
 * The API returns a flat array of all open positions (no filtering server-side).
 * We filter client-side for jobs whose region attribute (code 110) includes
 * "Ticino (TI)".
 *
 * Returns urls + API metadata indexed by URL.
 */
async function fetchSbbJobDetailUrls() {
  console.log('🔍 Fetching SBB jobs from AEM JSON API...');
  console.log(`  📡 ${SBB_API_URL}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const body = await fetchPage(SBB_API_URL, timeoutMs);

  if (!body) {
    console.error('❌ Failed to fetch SBB API.');
    return [];
  }

  let allJobs;
  try {
    allJobs = JSON.parse(body);
  } catch (err) {
    console.error(`❌ Failed to parse SBB API JSON: ${err.message}`);
    return [];
  }

  if (!Array.isArray(allJobs)) {
    console.error('❌ SBB API returned non-array response.');
    return [];
  }

  console.log(`  📦 Total jobs in API: ${allJobs.length}`);

  const TARGET_CITY_NAMES = new Set(
    [...TICINO_CITIES, ...GRIGIONI_CITIES].map((city) => normalize(city))
  );

  function isSbbTargetCity(job) {
    const cities = job?.attributes?.['100'] || [];
    return cities.some((c) => TARGET_CITY_NAMES.has(normalize(c)));
  }

  // Filter for target-area jobs: require BOTH region and city match.
  // If city attribute is missing/empty, accept based on region alone (conservative).
  const targetJobs = allJobs.filter((job) => {
    const regions = job?.attributes?.['110'] || [];
    const hasRegion = regions.some((r) => isTargetSwissLocation(r));
    if (!hasRegion) return false;
    const cities = job?.attributes?.['100'] || [];
    if (cities.length === 0) return true; // no city data → trust region
    return isSbbTargetCity(job);
  });

  console.log(`  🎯 Target jobs (TI/GR region + city filter): ${targetJobs.length}`);

  // Also log jobs excluded by city filter for debugging
  const regionOnlyJobs = allJobs.filter((job) => {
    const regions = job?.attributes?.['110'] || [];
    const hasRegion = regions.some((r) => isTargetSwissLocation(r));
    if (!hasRegion) return false;
    const cities = job?.attributes?.['100'] || [];
    return cities.length > 0 && !isSbbTargetCity(job);
  });
  if (regionOnlyJobs.length > 0) {
    console.log(`  ⚠️ Excluded ${regionOnlyJobs.length} job(s) with TI/GR region but non-target city:`);
    for (const job of regionOnlyJobs) {
      const city = (job?.attributes?.['100'] || []).join(', ') || '?';
      console.log(`     - ${job.title} — ${city}`);
    }
  }

  // Extract detail URLs + metadata
  const detailUrls = [];
  const apiMetaByUrl = new Map();
  const apiMetaByTitle = new Map();
  for (const job of targetJobs) {
    const directLink = job?.links?.directlink;
    if (directLink && directLink.startsWith('http')) {
      detailUrls.push(directLink);
      const city = (job?.attributes?.['100'] || []).join(', ') || '?';
      const pct = (job?.attributes?.['160'] || []).join(', ') || '?';
      const normalizedUrl = normalizeDetailUrl(directLink);
      const meta = {
        title: String(job?.title || '').trim(),
        city: String((job?.attributes?.['100'] || [])[0] || '').trim(),
        region: String((job?.attributes?.['110'] || [])[0] || '').trim(),
        profession: String((job?.attributes?.['20'] || [])[0] || '').trim(),
        workPct: String((job?.attributes?.['160'] || [])[0] || '').trim(),
        employmentRaw: Array.isArray(job?.attributes?.['50']) ? job.attributes['50'].map((x) => String(x || '').trim()).filter(Boolean) : [],
        datePosted: String(job?.start_date || '').trim(),
        validThrough: String(job?.end_date || '').trim(),
      };
      apiMetaByUrl.set(normalizedUrl, meta);
      const normalizedTitle = normalize(String(job?.title || ''));
      if (normalizedTitle) apiMetaByTitle.set(normalizedTitle, meta);
      console.log(`    ✅ ${job.title} — ${city} (${pct})`);
    } else {
      console.warn(`    ⚠️ Job ${job.id} "${job.title}" has no directlink.`);
    }
  }

  console.log(`✅ SBB API Ticino detail URLs discovered: ${detailUrls.length}`);
  return {
    urls: detailUrls,
    apiMetaByUrl,
    apiMetaByTitle,
  };
}

function normalizeDetailUrl(rawUrl = '') {
  return String(rawUrl || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
}

function toIsoDate(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function decodeHtmlEntities(input = '') {
  const NAMED = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: '\'',
    nbsp: ' ',
    rsquo: '\'',
    lsquo: '\'',
    rdquo: '"',
    ldquo: '"',
    ndash: '-',
    mdash: '-',
    hellip: '...',
    raquo: '»',
    laquo: '«',
    agrave: 'à',
    egrave: 'è',
    igrave: 'ì',
    ograve: 'ò',
    ugrave: 'ù',
    aacute: 'á',
    eacute: 'é',
    iacute: 'í',
    oacute: 'ó',
    uacute: 'ú',
    auml: 'ä',
    ouml: 'ö',
    uuml: 'ü',
    szlig: 'ß',
  };
  return String(input || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, code) => {
    const raw = String(code || '').toLowerCase();
    if (raw.startsWith('#x')) {
      const cp = Number.parseInt(raw.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    if (raw.startsWith('#')) {
      const cp = Number.parseInt(raw.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    return NAMED[raw] || full;
  });
}

function stripHtml(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(text).replace(/\r/g, '');
  return decoded
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function uniqueLongTextBlocks(blocks = []) {
  const out = [];
  for (const raw of blocks) {
    const value = stripHtml(raw);
    if (!value || value.length < 40) continue;
    const normalizedValue = normalize(value);
    const duplicate = out.some((existing) => {
      const n = normalize(existing);
      return n === normalizedValue || n.includes(normalizedValue) || normalizedValue.includes(n);
    });
    if (!duplicate) out.push(value);
  }
  return out;
}

function parseBullets(raw = '', max = 16) {
  const text = stripHtml(raw);
  if (!text) return [];
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[•·*-]\s*/, '').trim())
    .filter((line) => line.length >= 6);
  return [...new Set(lines)].slice(0, max);
}

function parseHtmlListItems(raw = '', max = 16) {
  const items = [...String(raw || '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => stripHtml(match[1]))
    .map((line) => line.replace(/^[•·*-]\s*/, '').trim())
    .filter((line) => line.length >= 2);
  return [...new Set(items)].slice(0, max);
}

function getJobPostingFromHtml(html = '') {
  const scripts = [...String(html || '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    const raw = String(match[1] || '').trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const nodes = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((node) => {
      if (!node || typeof node !== 'object') return [];
      if (Array.isArray(node['@graph'])) return node['@graph'];
      return [node];
    });
    for (const node of nodes) {
      const type = node?.['@type'];
      const matchType = Array.isArray(type)
        ? type.some((t) => String(t || '').toLowerCase() === 'jobposting')
        : String(type || '').toLowerCase() === 'jobposting';
      if (matchType) return node;
    }
  }
  return null;
}

function extractLocationFromJobPosting(jobPosting, html, apiMeta) {
  const apiCity = String(apiMeta?.city || '').trim();
  if (apiCity) return apiCity;

  const locations = Array.isArray(jobPosting?.jobLocation) ? jobPosting.jobLocation : [jobPosting?.jobLocation];
  for (const place of locations) {
    const locality = String(place?.address?.addressLocality || '').trim();
    if (locality) return locality;
  }

  const h1 = (() => {
    const m = String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    return m ? stripHtml(m[1]) : '';
  })();
  if (h1 && h1.includes(',')) {
    const candidate = h1.split(',').pop()?.trim();
    if (candidate && candidate.length <= 60) return candidate;
  }
  return 'Ticino';
}

function inferCategory(title = '', description = '', apiMeta = null) {
  const text = normalize(`${title} ${description} ${apiMeta?.profession || ''}`);
  if (/(software|developer|data|cyber|informat|it\b|digital)/.test(text)) return 'tech';
  if (/(ingegner|engineer|impiant|tecnic|manutent|quality|qualita|meccanic|elettr|progetto|safety|segnal)/.test(text)) return 'engineering';
  if (/(infermier|medic|clinic|sanit|ospedal|caregiver)/.test(text)) return 'health';
  if (/(finance|account|contabil|treasury|controller|payroll|audit)/.test(text)) return 'finance';
  if (/(sales|vendit|commercial|customer advisor|consulent)/.test(text)) return 'sales';
  if (/(admin|assistant|hr|human resources|back office|segret)/.test(text)) return 'admin';
  if (/(hotel|ristor|bar|chef|kitchen|hospitality)/.test(text)) return 'hospitality';
  return 'other';
}

function inferContract(apiMeta, employmentType = '', title = '') {
  const type = normalize(employmentType);
  const titleN = normalize(title);
  const employmentTokens = Array.isArray(apiMeta?.employmentRaw) ? apiMeta.employmentRaw.map((x) => normalize(x)) : [];
  if (/(apprend|intern|tirocin|trainee)/.test(titleN)) return 'temporary';
  if (type.includes('part_time') && !type.includes('full_time')) return 'part-time';
  if (type.includes('temporary') || type.includes('contract')) return 'temporary';
  if (employmentTokens.some((x) => x.includes('tempo parziale')) && !employmentTokens.some((x) => x.includes('tempo pieno'))) {
    return 'part-time';
  }
  return 'full-time';
}

async function parseSbbJobFromDetailUrl(detailUrl, apiMetaByUrl, apiMetaByTitle = new Map()) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const html = await fetchPage(detailUrl, timeoutMs, 'text/html,application/xhtml+xml');
  if (!html) return null;

  let apiMeta = apiMetaByUrl.get(normalizeDetailUrl(detailUrl)) || null;
  const companyDomain = (() => {
    try {
      return new URL(detailUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return 'sbb.ch';
    }
  })();
  const isLoginOrgDetail = companyDomain.includes('login.org');
  const localizedLoginData = isLoginOrgDetail
    ? await fetchLoginLocalizedVariants(detailUrl, timeoutMs)
    : {};
  const sourceLocale = isLoginOrgDetail
    ? (localizedLoginData.it ? 'it' : (Object.keys(localizedLoginData)[0] || 'it'))
    : null; // determined after title/description are parsed (see below)
  const sourceLoginData = isLoginOrgDetail
    ? (localizedLoginData[sourceLocale] || extractLoginLocalizedPageData(html))
    : { title: '', description: '', location: '', requirements: [] };

  // For non-login.org pages (jobs.sbb.ch), use parseSbbDetailPage() which
  // extracts the full vacancy body from HTML sections, not just the JSON-LD teaser.
  const sbbParsed = !isLoginOrgDetail ? parseSbbDetailPage(html) : null;
  if (sbbParsed) {
    for (const w of sbbParsed.warnings) {
      console.warn(`  ⚠️ ${w}`);
    }
  }

  // Fall back to inline JSON-LD for login.org pages (apprenticeship portal)
  const jobPosting = isLoginOrgDetail ? getJobPostingFromHtml(html) : (sbbParsed ? null : getJobPostingFromHtml(html));
  if (!sbbParsed && !jobPosting) {
    console.warn(`  ⚠️ No parseable content: ${detailUrl}`);
    return null;
  }

  const title = String(apiMeta?.title || sourceLoginData.title || sbbParsed?.title || jobPosting?.title || '').trim();
  if (!title) {
    console.warn(`  ⚠️ Missing title: ${detailUrl}`);
    return null;
  }
  if (!apiMeta) {
    apiMeta = apiMetaByTitle.get(normalize(title)) || null;
  }

  const descriptionBlocks = !isLoginOrgDetail ? [] : uniqueLongTextBlocks([
    jobPosting?.description,
    jobPosting?.responsibilities,
    jobPosting?.qualifications,
  ]);
  const description = String(
    sourceLoginData.description ||
    sbbParsed?.description ||
    descriptionBlocks.join('\n\n')
  ).trim();
  if (description.length < MIN_SBB_DESC_LENGTH) {
    console.warn(`  ⚠️ Thin description (${description.length} chars): ${detailUrl}`);
    if (description.length < 50) return null;
  }

  // For non-login.org pages, detect the actual source language from content
  // (SBB posts GR/non-Ticino jobs in German, not Italian)
  const resolvedSourceLocale = sourceLocale || detectLang(`${title} ${description}`);

  const requirements = sourceLoginData.requirements?.length
    ? sourceLoginData.requirements
    : (sbbParsed?.requirements?.length
      ? sbbParsed.requirements
      : parseBullets(jobPosting?.qualifications, 14));
  const resolvedDetailLocation = extractLocationFromJobPosting(jobPosting, html, apiMeta);
  const location = String(
    sourceLoginData.location ||
    resolvedDetailLocation ||
    sbbParsed?.location
  ).trim();
  const canton = inferAnyCanton(`${location} ${apiMeta?.region || ''}`) || DEFAULT_CANTON;
  const slugBase = slugify(`${title}-${SBB_KEY}-${location}`) || createHash('sha1').update(normalizeDetailUrl(detailUrl)).digest('hex').slice(0, 16);
  const id = `sbb-${createHash('sha1').update(normalizeDetailUrl(detailUrl)).digest('hex').slice(0, 12)}`;
  const postedDate = toIsoDate(apiMeta?.datePosted || jobPosting?.datePosted);

  const localeTitles = {};
  const localeDescriptions = {};
  for (const locale of ['it', 'de', 'fr']) {
    const localized = localizedLoginData[locale];
    if (localized?.title) localeTitles[locale] = localized.title;
    if (localized?.description) localeDescriptions[locale] = localized.description;
  }
  if (!localeTitles[resolvedSourceLocale]) localeTitles[resolvedSourceLocale] = title;
  if (!localeDescriptions[resolvedSourceLocale]) localeDescriptions[resolvedSourceLocale] = description;
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!localeTitles[locale] && localeTitles[resolvedSourceLocale]) {
      const translatedTitle = await freeTranslateWithRetry({
        text: localeTitles[resolvedSourceLocale],
        sourceLang: resolvedSourceLocale,
        targetLang: locale,
        maxRetries: 2,
      });
      if (translatedTitle) localeTitles[locale] = translatedTitle;
    }
    if (!localeDescriptions[locale] && localeDescriptions[resolvedSourceLocale]) {
      const translatedDescription = await freeTranslateWithRetry({
        text: localeDescriptions[resolvedSourceLocale],
        sourceLang: resolvedSourceLocale,
        targetLang: locale,
        maxRetries: 2,
      });
      if (translatedDescription) localeDescriptions[locale] = translatedDescription;
    }
  }
  const localeRequirements = { it: requirements, en: requirements, de: requirements, fr: requirements };
  const localeSlugs = Object.fromEntries(
    ['it', 'en', 'de', 'fr'].map((locale) => {
      const localizedTitle = String(localeTitles[locale] || title).trim();
      return [locale, slugify(`${localizedTitle}-${SBB_KEY}-${location}`) || slugBase];
    })
  );

  return {
    id,
    slug: slugBase,
    slugByLocale: localeSlugs,
    company: 'FFS Officine (Ferrovie Federali)',
    companyKey: SBB_KEY,
    companyDomain,
    title,
    titleByLocale: localeTitles,
    description,
    descriptionByLocale: localeDescriptions,
    requirements,
    requirementsByLocale: localeRequirements,
    location,
    canton,
    addressLocality: location,
    addressCountry: 'CH',
    category: inferCategory(title, description, apiMeta),
    contract: inferContract(apiMeta, String(jobPosting?.employmentType || ''), title),
    currency: 'CHF',
    featured: false,
    sourceLang: resolvedSourceLocale,
    postedDate,
    url: detailUrl,
    source: 'SBB Dedicated Parser (API + login.org)',
    crawledAt: new Date().toISOString(),
  };
}

async function parseAllSbbDetailJobs(detailUrls, apiMetaByUrl, apiMetaByTitle = new Map()) {
  const uniqueUrls = [...new Set((detailUrls || []).map((u) => normalizeDetailUrl(u)).filter(Boolean))];
  const concurrency = Math.max(1, Number(process.env.JOBS_SBB_DETAIL_CONCURRENCY || 6));
  let cursor = 0;
  const parsed = [];

  const worker = async () => {
    while (cursor < uniqueUrls.length) {
      const idx = cursor;
      cursor += 1;
      const url = uniqueUrls[idx];
      const job = await parseSbbJobFromDetailUrl(url, apiMetaByUrl, apiMetaByTitle);
      if (job) {
        parsed.push(job);
        console.log(`    ✅ Parsed: ${job.title} — ${job.location}`);
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, uniqueUrls.length) }, () => worker());
  await Promise.all(workers);
  return parsed;
}

function writeJobsFiles(jobs) {
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  }
}

function mergeParsedSbbJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(SBB_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const nonSbb = allJobs.filter((job) => !isSbbJob(job));
  const sbbExisting = allJobs.filter(isSbbJob);

  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = normalizeDetailUrl(job?.url || '');
    if (!key) continue;
    byUrl.set(key, job);
  }
  const deduped = [...byUrl.values()];

  // Preserve existing AI translations and slugs
  const cleanSbbJobs = mergePreserveLocaleData(sbbExisting, deduped).sort(
    (a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || ''))
  );
  const merged = [...nonSbb, ...cleanSbbJobs];
  writeJobsFiles(merged);
  return cleanSbbJobs;
}

// ──────────────────────────────────────────────────────────────
// Adapter setup
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the SBB adapter JSON has the correct seed URLs
 * (detail page URLs discovered from the API).
 */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${SBB_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${SBB_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: SBB_KEY,
      companyName: 'FFS – Ferrovie Federali Svizzere (SBB)',
      companyHost: 'sbb.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      seedUrls,
      notes: 'SBB dedicated seeds from company.sbb.ch AEM JSON API + login.org apprenticeship listing (partner SBB CFF FFS, canton Ticino).',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.companyHost = adapter.companyHost || 'sbb.ch';
    if (!adapter.crawlerModes?.includes('jsonld')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.push('jsonld');
    }
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes.unshift('generic_ats');
    }
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = 'SBB dedicated seeds from company.sbb.ch AEM JSON API + login.org apprenticeship listing (partner SBB CFF FFS, canton Ticino).';
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${SBB_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Dedicated parser flow
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logSbbJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, grigioni: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const sbbJobs = allJobs.filter(isSbbJob);
  const ticinoJobs = sbbJobs.filter((job) => normalize(job?.canton) === 'ti');
  const grigioniJobs = sbbJobs.filter((job) => normalize(job?.canton) === 'gr');
  const otherJobs = sbbJobs.length - ticinoJobs.length - grigioniJobs.length;

  console.log(`\n📊 === SBB / FFS Job Stats ===`);
  console.log(`  🚂 Job totali trovati (SBB): ${sbbJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  console.log(`  ✅ Job in Grigioni (canton=GR): ${grigioniJobs.length}`);
  if (otherJobs > 0) {
    console.log(`  ℹ️ Job in altri cantoni: ${otherJobs}`);
    const examples = sbbJobs
      .filter((job) => normalize(job?.canton) !== 'ti')
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(sbbJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'SBB');
  writeCrawlChangeSummaryToGH(crawlDiff, 'SBB');

  return { total: sbbJobs.length, ticino: ticinoJobs.length, grigioni: grigioniJobs.length, crawlDiff };

}

function validateSbbLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_SBB_STRICT',
    label: 'SBB',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isSbbJob,
    detectSourceLang: (text) => detectLang(text),
    deriveSlug: deriveLocalizedSlug,
    untranslatedCheck: false,
    isTrustedDomain: isTrustedSbbDomain,
    untrustedDomainReason: 'untrusted_domain_for_sbb_job',
    noJobsMessage: 'Nessun job SBB trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(SBB_KEY, 'SBB');
  console.log('🚂 Running dedicated SBB / FFS jobs crawler...');
  console.log('   Platform: SAP SuccessFactors via AEM JSON API');
  console.log('   Region filter: Ticino + Grigioni');
  console.log('');

  // Step 1: Fetch target-area job detail URLs from the AEM JSON API
  const apiSeed = await fetchSbbJobDetailUrls();
  const apiUrls = apiSeed.urls || [];
  const apiMetaByUrl = apiSeed.apiMetaByUrl || new Map();
  const apiMetaByTitle = apiSeed.apiMetaByTitle || new Map();

  // Step 2: Fetch login.org SBB apprenticeship URLs
  const loginDetailUrls = await fetchLoginSbbDetailUrls();
  const mergedDetailUrls = [...new Set([...apiUrls, ...loginDetailUrls])];
  console.log(`✅ Total merged SBB detail URLs (API + login.org): ${mergedDetailUrls.length}`);

  if (mergedDetailUrls.length === 0) {
    console.log('⚠️ No SBB TI/GR job URLs discovered. The API may be down or no target-area positions are open.');
    console.log('   Falling back to existing adapter seed URLs (if any)...');
    // Don't overwrite the adapter — keep whatever seeds exist
  } else {
    // Update adapter seed URLs for audit/debug visibility
    ensureAdapterSeedUrls(mergedDetailUrls);
  }

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(SBB_KEY, DATA_JOBS).filter(isSbbJob))

  // Step 3: Parse detail pages directly (dedicated parser, no generic filter)
  console.log(`🧩 Parsing SBB detail pages directly (${mergedDetailUrls.length})...`);
  const parsedSbbJobs = await parseAllSbbDetailJobs(mergedDetailUrls, apiMetaByUrl, apiMetaByTitle);
  console.log(`✅ Parsed SBB jobs (clean): ${parsedSbbJobs.length}`);
  if (parsedSbbJobs.length > 0) {
    const publishedJobs = mergeParsedSbbJobs(parsedSbbJobs);
    await translateMissingJobLocales({
      dataJobsPath: DATA_JOBS,
      isTargetJob: isSbbJob,
    });
    printPublishedJobUrls(publishedJobs, 'SBB');
    writeJobsSummary(publishedJobs, 'SBB');
  } else {
    console.log('⚠️ Parsed jobs are 0 — keeping existing SBB jobs unchanged.');
  }

  // Step 4: Log stats and validate
  const stats = logSbbJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job SBB trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  validateSbbLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isSbbJob) : [];
  writeJobsCrawlerSlice(SBB_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: SBB_KEY,
    label: 'SBB',
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ SBB crawler failed: ${err?.message || err}`);
    process.exit(1);
  });
}
