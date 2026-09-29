#!/usr/bin/env node
/**
 * Dedicated Manor crawler runner.
 *
 * Source:
 *   https://positions.manor.ch/sitemap.xml
 *   (SAP SuccessFactors / jobs2web platform)
 *
 * This script:
 *   1. Fetches the sitemap.xml from positions.manor.ch.
 *   2. Extracts all job URLs and keeps every Swiss-target store (CH-wide).
 *   3. Fetches job detail pages for title/description/date.
 *   4. Merges discovered jobs into data/jobs.json.
 *   5. Updates the adapter config with discovered seed URLs.
 *   6. Post-processes rows for canonical consistency.
 *   7. Validates locale coverage.
 *
 * Manor AG is a national department-store chain (HQ Basel) with stores in
 * every canton, so the crawler collects CH-wide. Per-job canton is inferred
 * from the store city encoded in the URL via inferAnyCanton; the region gate
 * is isTargetSwissLocation across all 26 Swiss cantons.
 */
import { decodeSitemapLoc } from './lib/sitemap-loc.mjs';
import fs from 'node:fs';
import { meetsSourceBodyFloor, sourceBodyWordCount } from './lib/source-body-floor.mjs';
import path from 'node:path';
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
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
  mergePreserveLocaleData,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  isTargetSwissLocation,
  isKnownSwissCity,
  inferAnyCanton,
  normalizeCantonCode,
  normalizeSwissTargetLocationText,
} from './lib/target-swiss-locations.mjs';
import { getCantonDisplayName } from './lib/crawler-location-config.mjs';
import { exitCrawlerOnError, fetchHtml, normalizeDescriptionBullets } from './lib/crawler-template.mjs';
import { decodeEntities, htmlToText } from './lib/hospital-custom-html-helpers.mjs';
import { readAttr } from './lib/html-attr.mjs';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const MANOR_KEY = 'manor';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(MANOR_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const MANOR_COMPANY_NAME = 'Manor AG';
const MANOR_HOST = 'positions.manor.ch';
const MANOR_SITEMAP_URL = 'https://positions.manor.ch/sitemap.xml';
const MANOR_LOCALES = ['it', 'en', 'de', 'fr'];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matcher ───────────────────────────────────────────────── */
function isManorJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === MANOR_KEY ||
    key === 'manor-ag' ||
    key.includes('manor') ||
    company.includes('manor') ||
    host === MANOR_HOST ||
    host === 'careers.manor.ch'
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === MANOR_HOST ||
      host === 'careers.manor.ch' ||
      host === 'www.manor.ch'
    );
  } catch {
    return false;
  }
}

/* ── Category detection ────────────────────────────────────── */
function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/logisti|magazzin|lager|warehouse|entrepôt/i.test(t)) return 'logistics';
  if (/vendita|sales|vente|verkauf|conseill/i.test(t)) return 'sales';
  if (/kassier|cassa|caisse|kasse/i.test(t)) return 'sales';
  if (/cucin|cuisinier|koch|küch|pâtissier|boulanger/i.test(t)) return 'hospitality';
  if (/servizio|service|manora|plongeur/i.test(t)) return 'hospitality';
  if (/supermark|supermarch|epicerie|poissonnerie|caviste|charcuterie|fromage|fruit|légume/i.test(t)) return 'retail';
  if (/merchandis|visual|polydesigner/i.test(t)) return 'design';
  if (/drogist|droguiste|dermacenter|parf[uü]m|beauty/i.test(t)) return 'healthcare';
  if (/hr\b|human|personale|personal|recruiter/i.test(t)) return 'hr';
  if (/market|kommunikation|communication|project/i.test(t)) return 'marketing';
  if (/manager|responsable|floor.manager|team.lead|backoffice/i.test(t)) return 'management';
  if (/apprendista|apprenti|lehrling|lehrstelle|afc|efz|cfc/i.test(t)) return 'apprenticeship';
  if (/controller|finanz|finance|contabil|buchhaltung|comptab/i.test(t)) return 'finance';
  if (/it\b|software|developer|system|informatik/i.test(t)) return 'technology';
  return 'retail'; // default for Manor (department store)
}

/* ── Description builders ──────────────────────────────────── */
function buildDescriptionIt(title, city, canton) {
  const region = getCantonDisplayName(canton, 'it');
  return `${title} presso Manor, con sede a ${city}, Canton ${region}, Svizzera. Manor è una delle principali catene di grandi magazzini svizzere, con una vasta gamma di prodotti tra cui moda, bellezza, casa, alimentari e ristoranti Manora. Questa posizione offre l'opportunità di lavorare in un ambiente dinamico e orientato al cliente.`;
}

function buildDescriptionEn(title, city, canton) {
  const region = getCantonDisplayName(canton, 'en');
  return `${title} at Manor, located in ${city}, Canton of ${region}, Switzerland. Manor is one of Switzerland's leading department store chains, offering a wide range of products including fashion, beauty, home, food, and Manora restaurants. This position offers the opportunity to work in a dynamic, customer-oriented environment.`;
}

function buildDescriptionDe(title, city, canton) {
  const region = getCantonDisplayName(canton, 'de');
  return `${title} bei Manor, gelegen in ${city}, Kanton ${region}, Schweiz. Manor ist eine der führenden Warenhausgruppen der Schweiz mit einem vielfältigen Angebot in den Bereichen Mode, Beauty, Home, Food und Manora-Restaurants. Diese Stelle bietet die Möglichkeit, in einem dynamischen und kundenorientierten Umfeld zu arbeiten.`;
}

function buildDescriptionFr(title, city, canton) {
  const region = getCantonDisplayName(canton, 'fr');
  return `${title} chez Manor, situé à ${city}, Canton de ${region}, Suisse. Manor est l'un des principaux groupes de grands magasins suisses, offrant une large gamme de produits comprenant mode, beauté, maison, alimentation et restaurants Manora. Ce poste offre la possibilité de travailler dans un environnement dynamique et orienté vers le client.`;
}

const MANOR_DESCRIPTION_BUILDERS = {
  it: buildDescriptionIt,
  en: buildDescriptionEn,
  de: buildDescriptionDe,
  fr: buildDescriptionFr,
};

// Bodies that only point elsewhere ("-", "Voir JD", "selon profil du rôle",
// "gemäss Rollenprofil", "già menzionato sopra") carry no vacancy content.
// A short real requirement ("Deutschkenntnisse", "Flexibilität,
// Verkaufstalent") is content and is kept.
const MANOR_PLACEHOLDER_BODY_RX = /^(?:(?:voir|voire|siehe|vedi|see)\s+(?:jd|job\s*description|(?:le\s+)?profil\S*(?:\s+\S+){0,3})|(?:selon|gemäss|gemäß|secondo)\s+(?:le\s+|il\s+)?(?:profil|rollenprofil|profilo)\S*(?:\s+\S+){0,3}|già menzionato sopra)\.?$/iu;
function hasVacancyWords(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return /\p{L}{2,}/u.test(value) && !MANOR_PLACEHOLDER_BODY_RX.test(value);
}

/* ── Company context (careers.manor.ch) ──────────────────────
 * The jobs2web vacancy body is often a two-line requirement list. The
 * employer text Manor itself publishes lives on its careers site, per
 * language: the landing lead ("GLÜCKSMOMENTE" / "MOMENTS DE BONHEUR" /
 * "MOMENTI DI GIOIA") and the benefits page. That text — verbatim, in the
 * vacancy's language — is the company context a short vacancy carries, as a
 * separate block after the body. The generic paragraph built above is only
 * the fallback for a language the careers site does not publish (en) or a
 * run where it cannot be read, and it too stays a separate block in the
 * source-language slot only.
 */
export const MANOR_CAREERS_SOURCES = Object.freeze({
  de: {
    landingUrl: 'https://careers.manor.ch/de',
    benefitsUrl: 'https://careers.manor.ch/de/ueber-manor/benefits',
    aboutHeading: 'Über Manor',
  },
  fr: {
    landingUrl: 'https://careers.manor.ch/fr',
    benefitsUrl: 'https://careers.manor.ch/fr/%C3%A0-propos-de-manor/avantages',
    aboutHeading: 'À propos de Manor',
  },
  it: {
    landingUrl: 'https://careers.manor.ch/it',
    benefitsUrl: 'https://careers.manor.ch/it/informazioni-su-manor/vantaggi',
    aboutHeading: 'Informazioni su Manor',
  },
});
const MANOR_FALLBACK_ABOUT_HEADINGS = { ...Object.fromEntries(Object.entries(MANOR_CAREERS_SOURCES).map(([lang, source]) => [lang, source.aboutHeading])), en: 'About Manor' };
// Benefit groups carried per vacancy: the first two on the page
// (employment conditions and staff discounts). The rest (training, family,
// health, pension, partner discounts) is company-wide and would outweigh the
// vacancy text itself.
const MANOR_BENEFIT_GROUPS_PER_VACANCY = 2;

function careersText(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lead paragraph of the careers landing page, without its "10 reasons" teaser line. */
export function parseManorCareersLead(html) {
  const section = String(html || '').match(/<section\b[^>]*\bid="lead1"[^>]*>([\s\S]*?)<\/section>/i)?.[1] || '';
  const paragraph = section.match(/<div class="lead[^"]*">\s*<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
  return careersText(paragraph.split(/<br\s*\/?>\s*<br\s*\/?>/i)[0]);
}

/** Heading, intro and benefit groups of the careers benefits page. */
export function parseManorCareersBenefits(html) {
  const source = String(html || '');
  const hero = source.match(/<section\b[^>]*\bhero-text-brick[^>]*>([\s\S]*?)<\/section>/i)?.[1] || '';
  const heading = careersText(hero.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const intro = careersText(hero.match(/<div class="text[^"]*">([\s\S]*?)<\/div>/i)?.[1] || '');
  const groups = [];
  const blocks = source.split(/<div class="benefit\b[^"]*">/i).slice(1);
  for (const block of blocks) {
    const title = careersText(block.match(/<div class="title">([\s\S]*?)<\/div>/i)?.[1] || '');
    const lead = careersText(block.match(/<div class="lead">([\s\S]*?)<\/div>/i)?.[1] || '');
    const rows = [...block.matchAll(/<div class="row">([\s\S]*?)<\/div>/gi)].map((m) => careersText(m[1])).filter(Boolean);
    if (title && rows.length > 0) groups.push({ title, lead, rows });
  }
  return { heading, intro, groups };
}

/**
 * Markdown company block for one language, from the two parsed careers
 * pages. Empty when either page did not yield its text (the caller then
 * falls back).
 */
export function buildManorCompanyContext(lang, { lead = '', benefits = null } = {}) {
  const source = MANOR_CAREERS_SOURCES[lang];
  const groups = (benefits?.groups || []).slice(0, MANOR_BENEFIT_GROUPS_PER_VACANCY);
  if (!source || !lead || !benefits?.heading || groups.length === 0) return '';
  const parts = [`## ${source.aboutHeading}\n${lead}`];
  const benefitLines = [`## ${benefits.heading}`];
  if (benefits.intro) benefitLines.push(benefits.intro);
  for (const group of groups) {
    benefitLines.push('', `**${group.title}**${group.lead ? ` — ${group.lead}` : ''}`);
    for (const row of group.rows) benefitLines.push(`- ${row}`);
  }
  parts.push(benefitLines.join('\n'));
  return parts.join('\n\n');
}

/** Read the careers pages once per run; a language that fails maps to ''. */
export async function fetchManorCompanyContexts({ fetchPage = fetchText, timeoutMs = 15000, delayMs = 1000 } = {}) {
  const contexts = {};
  for (const [lang, source] of Object.entries(MANOR_CAREERS_SOURCES)) {
    try {
      const lead = parseManorCareersLead(await fetchPage(source.landingUrl, timeoutMs));
      await sleep(delayMs);
      const benefits = parseManorCareersBenefits(await fetchPage(source.benefitsUrl, timeoutMs));
      await sleep(delayMs);
      contexts[lang] = buildManorCompanyContext(lang, { lead, benefits });
    } catch (err) {
      console.warn(`  ⚠️  Manor careers context (${lang}) unavailable: ${err?.message || err}`);
      contexts[lang] = '';
    }
  }
  return contexts;
}

/**
 * Language of a Manor body. The portal's `lang` tag is right for most rows but
 * not all (a German body tagged `it-IT`, an Italian one `fr-FR`, English HQ
 * roles `fr-FR`), and trigram detection is unreliable on the two-word
 * requirement lists most rows carry (it reads "Langue française et/ou
 * allemande, flexibilité horaire" as English). The detector overrides the tag
 * only on a body long enough to judge and with a clear lead.
 */
export function resolveManorBodyLang(body = '', pageLang = '') {
  const declared = MANOR_DESCRIPTION_LANGS.has(pageLang) ? pageLang : 'de';
  if (!body) return declared;
  const { lang, confidence } = detectLanguageWithConfidence(body, declared);
  if (lang === declared || !MANOR_LOCALES.includes(lang)) return declared;
  return sourceBodyWordCount(body) >= 12 && confidence >= 0.4 ? lang : declared;
}

/**
 * Description of one Manor vacancy, in the language of its body only.
 *
 * - The jobs2web body is published as-is ("Voir JD"-style placeholders
 *   dropped). Its language comes from the text, the portal's `lang` tag being
 *   only the fallback (Manor has tagged an Italian body `fr-FR`).
 * - Only the source-language slot is filled: the other slots belong to the
 *   translation step. The old builder copied a German/French body into `it`
 *   and put the generic paragraph into every other slot.
 * - A body under the 50-word source floor is followed by the company
 *   context, a separate block: Manor's own careers text in that language
 *   (`companyContexts[lang]`), else the generic paragraph under its own
 *   heading.
 */
export function buildManorJobDescriptions({
  title,
  city,
  canton,
  pageDescription = '',
  pageLang = '',
  companyContexts = {},
}) {
  const raw = String(pageDescription || '').trim();
  const body = hasVacancyWords(raw) ? raw : '';
  const sourceLang = resolveManorBodyLang(body, pageLang);
  let context = '';
  let companyContext = 'none';
  if (!meetsSourceBodyFloor(body)) {
    context = String(companyContexts?.[sourceLang] || '').trim();
    companyContext = context ? 'careers' : 'fallback';
    if (!context) {
      context = `## ${MANOR_FALLBACK_ABOUT_HEADINGS[sourceLang]}\n${MANOR_DESCRIPTION_BUILDERS[sourceLang](title, city, canton)}`;
    }
  }
  const description = [body, context].filter(Boolean).join('\n\n');
  return {
    description,
    descriptionByLocale: { [sourceLang]: description },
    sourceLang,
    companyContext,
    body,
  };
}

const MANOR_GENERIC_PARAGRAPH_RX = /(?:presso Manor, con sede a|at Manor, located in|bei Manor, gelegen in|chez Manor, situé à|Manor AG è una delle principali catene di grandi magazzini)/;

/**
 * Remove locale slots earlier runs filled with stale text: an `it` slot that
 * is not Italian (the source body copied there) and the generic paragraph in
 * any slot other than the source one. The translation step refills them from
 * the source slot.
 */
export function stripStaleManorLocaleSlots(job) {
  const slots = job?.descriptionByLocale;
  if (!slots || typeof slots !== 'object') return job;
  const sourceLang = job.sourceLang;
  const kept = {};
  let removed = 0;
  for (const [locale, text] of Object.entries(slots)) {
    const value = String(text || '');
    const stale = locale !== sourceLang && (
      MANOR_GENERIC_PARAGRAPH_RX.test(value)
      || (locale === 'it' && sourceLang !== 'it' && detectLang(value, 'it') !== 'it')
    );
    if (stale) removed++;
    else kept[locale] = text;
  }
  if (removed === 0) return job;
  return { ...job, descriptionByLocale: kept, needsRetranslation: true };
}

/**
 * Manor re-posts one vacancy under several requisition ids (three
 * "Mitarbeiter*in Logistik Kommissionierung 100%" in Hochdorf, same body).
 * Identical title + store + vacancy body is one vacancy for a job seeker:
 * keep the lowest requisition id and drop the repeats. The body is the
 * portal's own text (`_manorVacancyBody`, removed here), not the published
 * description: two reposts tagged in different portal languages get the
 * company context in different languages but are still one vacancy
 * ("Boucher/ère 70%", Marin-Epagnier, 1363511155 fr / 1363511255 de).
 * Without a source body there is no evidence of a repost: those records are
 * always kept separately.
 */
export function dedupeManorReposts(jobs = []) {
  const normalized = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const idOf = (job) => Number(extractJobId(String(job?.url || '')) || Number.MAX_SAFE_INTEGER);
  const bodyOf = (job) => (job && '_manorVacancyBody' in job ? job._manorVacancyBody : job?.description);
  const sorted = [...jobs].sort((a, b) => idOf(a) - idOf(b));
  const keptByKey = new Map();
  const keptWithoutBody = [];
  const reposts = [];
  for (const job of sorted) {
    const body = normalized(bodyOf(job));
    if (!body) {
      // No source body (portal placeholder "-", "Voir JD"): nothing proves two
      // same-title openings at one store are the same vacancy, so both stay.
      keptWithoutBody.push(job);
      continue;
    }
    const key = [normalized(job.title), normalized(job.location), body].join('\u0000');
    const kept = keptByKey.get(key);
    if (kept) {
      reposts.push({ url: job.url, keptUrl: kept.url });
      continue;
    }
    keptByKey.set(key, job);
  }
  const keptSet = new Set([...keptByKey.values(), ...keptWithoutBody]);
  const unique = jobs.filter((job) => keptSet.has(job)).map((job) => {
    if (!job || !('_manorVacancyBody' in job)) return job;
    const { _manorVacancyBody, ...rest } = job;
    return rest;
  });
  return { jobs: unique, reposts };
}

/* ── HTTP helpers ──────────────────────────────────────────── */
async function fetchText(url, timeoutMs = 15000) {
  return fetchHtml(url, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Sitemap parser ────────────────────────────────────────── */
export function parseSitemapUrls(xml) {
  const urls = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    // The sitemap escapes the apostrophe too ("Basel-Buyer-%28Women&apos;s-
    // Fashion%29-100"): left undecoded it became part of the published URL.
    const url = decodeSitemapLoc(match[1]);
    urls.push(url);
  }
  return urls;
}

/**
 * Maximum number of leading dash-separated slug segments to treat as a city.
 * Covers multi-word Swiss municipalities like "Affoltern am Albis",
 * "Chavannes de Bogis", "Rickenbach b. Wil".
 */
const MANOR_CITY_MAX_SEGMENTS = 4;

// `Rickenbach b. Wil` is a real Swiss locality used by Manor's URL feed but
// is not present in the current BFS municipality snapshot. Keep this exact
// feed spelling as a narrowly scoped URL alias; do not restore fuzzy free-text
// matching here, because that is what swallowed the following job-title words.
const MANOR_URL_CITY_ALIASES = new Set(['rickenbach b wil']);

function isManorUrlCityCandidate(value) {
  return Boolean(
    isKnownSwissCity(value) ||
    normalizeCantonCode(value) ||
    MANOR_URL_CITY_ALIASES.has(normalizeSwissTargetLocationText(value)),
  );
}

/**
 * Extract the store city from a Manor job URL — CH-wide.
 * Format: /job/{City}-{Title}/{ID}/ where {City} may itself contain dashes.
 *
 * Greedily try the longest leading prefix (up to MANOR_CITY_MAX_SEGMENTS
 * segments) that resolves to a known Swiss city or a target Swiss canton via
 * the central helpers. A trailing numeric district segment (e.g. "Genève 1")
 * is tolerated. Returns the matched city string, or null when no Swiss city is
 * recognisable (the downstream isTargetSwissLocation gate then drops the row).
 */
// Returns { city, segments }: the resolved city and the NUMBER OF DASH-PARTS it
// consumed from the slug. Callers need `segments` (not the rendered city's word
// count) to strip the city prefix from the title — a district-stripped city
// ("Genève-1" → "Genève") consumes 2 dash-parts but renders as 1 word.
export function extractCityFromUrl(url) {
  const match = url.match(/\/job\/([^/]+)\//);
  if (!match) return { city: null, segments: 0 };
  let slug;
  try { slug = decodeURIComponent(match[1]); } catch { slug = match[1]; }
  const parts = slug.split('-');
  const maxSeg = Math.min(MANOR_CITY_MAX_SEGMENTS, parts.length);
  for (let n = maxSeg; n >= 1; n--) {
    const candidate = parts.slice(0, n).join(' ').replace(/_/g, '.').trim();
    if (!candidate) continue;
    // Drop a trailing pure-number district suffix ("Genève 1" → "Genève").
    const candidateNoDistrict = candidate.replace(/\s+\d+$/, '').trim();
    for (const c of [candidate, candidateNoDistrict]) {
      if (!c) continue;
      // `isTargetSwissLocation` is intentionally fuzzy for free-text fields
      // (it recognizes a city/canton mentioned anywhere in a description).
      // A URL prefix must be exact: otherwise `Biel-Mitarbeiterin-Visual-...`
      // is accepted as one giant city and the fallback title collapses to
      // `80`, which then blocks the deploy completeness gate.
      if (isManorUrlCityCandidate(c)) return { city: c, segments: n };
    }
  }
  return { city: null, segments: 0 };
}

/**
 * Extract job ID from URL.
 * Format: /job/{slug}/{ID}/
 */
function extractJobId(url) {
  const match = url.match(/\/job\/[^/]+\/(\d+)\/?$/);
  return match ? match[1] : null;
}

/* ── Job detail page parser ────────────────────────────────── */
function readHtmlAttribute(tag, attribute) {
  // Quote-balanced shared reader: a double-quoted value may contain an
  // apostrophe (`content="Buyer (Women's Fashion) 100%"`), which the old local
  // `["']([^"']*)["']` regex cut at ("Buyer (Women").
  return decodeEntities(readAttr(String(tag || ''), attribute)).trim();
}

const MANOR_DESCRIPTION_LANGS = new Set(['it', 'en', 'de', 'fr']);

/**
 * Language the portal declares for the vacancy body
 * (`<span lang="fr-FR" itemprop="description">`). Used as the detection
 * fallback: a 40-character requirement list is too short to guess from, but
 * the tag itself is not always right (an Italian body tagged `fr-FR`).
 */
export function readManorDescriptionLang(html) {
  for (const match of String(html || '').matchAll(/<[^>]+>/g)) {
    const tag = match[0];
    if (readHtmlAttribute(tag, 'itemprop').toLowerCase() !== 'description') continue;
    const lang = readHtmlAttribute(tag, 'lang').toLowerCase().split(/[-_]/)[0];
    if (MANOR_DESCRIPTION_LANGS.has(lang)) return lang;
  }
  return '';
}

function readMetaContent(html, key) {
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = readHtmlAttribute(tag, 'property').toLowerCase();
    const name = readHtmlAttribute(tag, 'name').toLowerCase();
    if (property === key || name === key) return readHtmlAttribute(tag, 'content');
  }
  return '';
}

function readItempropContent(html, key) {
  const wanted = String(key || '').toLowerCase();
  for (const match of String(html || '').matchAll(/<[^>]+>/g)) {
    const tag = match[0];
    if (readHtmlAttribute(tag, 'itemprop').toLowerCase() !== wanted) continue;
    const content = readHtmlAttribute(tag, 'content');
    if (content) return content;
  }
  return '';
}

export function stripSiteTitleSuffix(rawTitle) {
  const title = decodeEntities(String(rawTitle || '')).trim();
  return title
    .replace(/\s+\|\s+Manor(?:\s+AG)?$/iu, '')
    .replace(/\s+-\s+Manor(?:\s+AG)?$/iu, '')
    .trim();
}

export function parseJobPage(html, url) {
  // Manor's current SuccessFactors markup exposes the canonical role in
  // og:title, while older templates used itemprop="title". Prefer the
  // structured metadata before falling back to the URL slug.
  const metaTitle = stripSiteTitleSuffix(readMetaContent(html, 'og:title'));
  const titleMatch = html.match(/itemprop="title"[^>]*>([^<]+)/i);
  const title = metaTitle || (titleMatch ? decodeEntities(titleMatch[1]).trim() : null);

  // Extract description from <span class="jobdescription">. The English
  // template writes `<span itemprop="description" class="jobdescription">`
  // (1368279755, the en-US copy of "Buyer (Women's Fashion) 100%"): a regex
  // anchored on `<span class=` read no body there, so the copy was published
  // with the company context only and never recognised as a repost.
  const descMatch = html.match(/<span\b[^>]*\sclass="jobdescription"[^>]*>([\s\S]*?)<\/span>/);
  const rawDesc = descMatch ? normalizeDescriptionBullets(htmlToText(descMatch[1])) : '';

  // Extract posted date from itemprop="datePosted"
  const dateMatch = html.match(/itemprop="datePosted"\s+content="([^"]+)"/);
  let postedDate = '';
  if (dateMatch) {
    try {
      postedDate = new Date(dateMatch[1]).toISOString().slice(0, 10);
    } catch { /* ignore */ }
  }

  // SuccessFactors currently exposes only a combined `streetAddress` value
  // such as "Chavannes-de-Bogis, CH". Preserve every address signal that is
  // actually present; the URL city remains the authoritative workplace when
  // the portal omits locality/postal fields.
  const streetAddress = readItempropContent(html, 'streetAddress');
  const addressLocality = readItempropContent(html, 'addressLocality');
  const postalCode = readItempropContent(html, 'postalCode');
  const addressRegion = readItempropContent(html, 'addressRegion');
  const location = addressLocality || streetAddress.split(',')[0].trim();
  const hasOnlyCombinedLocation = /^.+,\s*(?:CH|Switzerland|Schweiz|Suisse|Svizzera)$/iu.test(streetAddress);

  return {
    title,
    description: rawDesc,
    descriptionLang: readManorDescriptionLang(html),
    postedDate,
    location,
    addressLocality,
    addressRegion,
    postalCode,
    streetAddress: hasOnlyCombinedLocation ? '' : streetAddress,
  };
}

/* ── Fetch & parse ─────────────────────────────────────────── */
/**
 * Resolve the one locality/canton pair emitted into Manor JobPosting data.
 * Detail metadata wins when present, but it must remain in the canton selected
 * by the URL and must not contradict an explicit detail-page region.
 */
export function resolveManorLocation(pageData = {}, urlCity = '') {
  const detailLocality = String(pageData?.addressLocality || '').trim();
  const location = detailLocality || String(urlCity || '').trim();
  const canton = inferAnyCanton(location);
  const urlCanton = inferAnyCanton(urlCity);
  const detailRegion = String(pageData?.addressRegion || '').trim();
  const normalizedDetailCanton = normalizeCantonCode(detailRegion);
  // An explicit schema region is a canton field, not a free-text workplace.
  // Do not let a border city or another location token infer a Swiss canton
  // and contaminate the locality/canton tuple.
  const detailCanton = normalizedDetailCanton;

  if (
    !location
    || !canton
    || (detailRegion && !detailCanton)
    || (urlCanton && urlCanton !== canton)
    || (detailCanton && detailCanton !== canton)
  ) {
    return null;
  }

  return { location, canton };
}

export async function fetchManorJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const delayMs = Number(process.env.MANOR_CRAWL_DELAY_MS) || 1500;

  console.log('🔍 Fetching Manor sitemap...');

  let sitemapXml;
  try {
    sitemapXml = await fetchText(MANOR_SITEMAP_URL, timeoutMs);
  } catch (err) {
    console.error(`❌ Failed to fetch Manor sitemap: ${err?.message || err}`);
    throw err;
  }

  const allUrls = parseSitemapUrls(sitemapXml);
  console.log(`📋 Sitemap returned ${allUrls.length} total job URLs.`);

  // Keep every store URL whose city resolves to a target Swiss canton (CH-wide).
  const targetUrls = [];
  for (const url of allUrls) {
    const { city } = extractCityFromUrl(url);
    if (city && isTargetSwissLocation(city, { includeAllCantons: true, includeBorderProximity: false })) {
      targetUrls.push({ url, city });
    }
  }
  console.log(`📋 Swiss-target job URLs: ${targetUrls.length}`);

  if (targetUrls.length === 0) {
    console.log('ℹ️  No Swiss-target job listings found in sitemap.');
    return [];
  }

  const companyContexts = await fetchManorCompanyContexts({ timeoutMs });
  console.log(`📋 Manor careers company context: ${Object.entries(companyContexts).map(([lang, text]) => `${lang}=${text ? 'ok' : 'missing'}`).join(', ')}`);

  const jobs = [];
  const skipped = { missingTitle: 0, unresolvedCanton: 0 };
  const contextUse = {};
  let detailFailures = 0;

  // Fetch detail pages for each target job
  for (let i = 0; i < targetUrls.length; i++) {
    const { url, city } = targetUrls[i];
    const jobId = extractJobId(url) || '';

    console.log(`  📄 [${i + 1}/${targetUrls.length}] Fetching: ${url}`);

    let pageData;
    try {
      const html = await fetchText(url, timeoutMs);
      pageData = parseJobPage(html, url);
    } catch (err) {
      detailFailures++;
      console.warn(`  ⚠️  Failed to fetch job detail: ${err?.message || err}`);
      // Still include with minimal data from URL
      pageData = {
        title: extractTitleFromUrl(url),
        description: '',
        postedDate: '',
        location: `${city}, CH`,
        addressLocality: city,
        addressRegion: '',
        postalCode: '',
        streetAddress: '',
      };
    }

    const title = pageData.title || extractTitleFromUrl(url);
    if (!title) {
      skipped.missingTitle++;
      console.log(`  ⚠️  Skipping job ${jobId}: no title`);
      continue;
    }

    const category = detectCategory(title);

    // Keep location, addressLocality and addressRegion on the same source
    // signal. A detail page that names another canton is rejected instead of
    // publishing a structurally incoherent JobPosting.
    const resolvedLocation = resolveManorLocation(pageData, city);
    if (!resolvedLocation) {
      skipped.unresolvedCanton++;
      console.warn(`  ⚠️  Skipping job ${jobId}: detail locality/canton disagrees with store city (${city})`);
      continue;
    }

    const { location: resolvedCity, canton } = resolvedLocation;
    const addressLocality = resolvedCity;
    const addressRegion = canton;

    const { description, descriptionByLocale, sourceLang, companyContext, body } = buildManorJobDescriptions({
      title,
      city: resolvedCity,
      canton,
      pageDescription: pageData.description,
      pageLang: pageData.descriptionLang,
      companyContexts,
    });
    contextUse[companyContext] = (contextUse[companyContext] || 0) + 1;

    const baseSlug = normalizeKey(`manor ${title} ${resolvedCity}`);

    const job = {
      title,
      company: MANOR_COMPANY_NAME,
      companyKey: MANOR_KEY,
      url,
      location: resolvedCity,
      addressLocality,
      streetAddress: pageData.streetAddress || '',
      postalCode: pageData.postalCode || '',
      addressRegion,
      canton,
      country: 'CH',
      category,
      description,
      descriptionByLocale,
      postedDate: pageData.postedDate || '',
      source: 'company-website',
      slug: baseSlug,
      slugByLocale: {
        it: baseSlug,
      },
      titleByLocale: {
        it: title,
      },
      sourceLang,
      _manorVacancyBody: body,
    };

    console.log(`  ✅ ${title} — Manor @ ${city} (id: ${jobId})`);
    jobs.push(job);

    // Rate-limit between requests
    if (i < targetUrls.length - 1) {
      await sleep(delayMs);
    }
  }

  console.log(`📋 Detail pages fetched: ${targetUrls.length - detailFailures}/${targetUrls.length}`);
  console.log(`📋 Company context appended (short bodies): ${JSON.stringify(contextUse)}`);
  const { jobs: uniqueJobs, reposts } = dedupeManorReposts(jobs);
  if (reposts.length > 0) {
    console.log(`📋 Collapsed ${reposts.length} Manor repost(s) of an identical vacancy (same title, store and body): ${reposts.map((r) => `${extractJobId(r.url)}→${extractJobId(r.keptUrl)}`).join(', ')}`);
  }
  jobs.length = 0;
  jobs.push(...uniqueJobs);
  console.log(`📋 Total unique Manor Swiss jobs discovered: ${jobs.length}`);
  if (skipped.missingTitle || skipped.unresolvedCanton) {
    console.warn(`⚠️ Skipped Manor listings: ${JSON.stringify(skipped)}`);
  }
  if (targetUrls.length > 0 && jobs.length === 0) {
    throw new Error(`Manor sitemap returned ${targetUrls.length} Swiss listings but no listing produced a resolvable job`);
  }
  return jobs;
}

/**
 * Extract a human-readable title from the URL slug.
 * e.g. /job/Lugano-Collaboratoretrice-logistica-60/1344050855/
 *   → "Collaboratoretrice logistica 60"
 */
export function extractTitleFromUrl(url) {
  const match = url.match(/\/job\/([^/]+)\//);
  if (!match) return '';
  let slug;
  try { slug = decodeURIComponent(match[1]); } catch { slug = match[1]; }
  const parts = slug.split('-');
  // Strip the leading city prefix (CH-wide, possibly multi-word) when present.
  // Use the dash-part count the matcher consumed — NOT the rendered city's word
  // count — so a district-stripped city ("Genève-1") doesn't leave "1" in the title.
  const { segments: citySegments } = extractCityFromUrl(url);
  const titleParts = citySegments > 0 ? parts.slice(citySegments) : parts;
  return titleParts.join(' ').replace(/_/g, '.').trim();
}

/* ── Merge into jobs.json ──────────────────────────────────── */

function mergeManorJobs(discoveredJobs) {
  // #3699 (2nd defect class): data/jobs.json is gitignored — on a fresh CI
  // checkout it doesn't exist yet, so a raw fs.existsSync(DATA_JOBS) read
  // would find ZERO existing Manor jobs and treat every discovered job as
  // brand new, silently dropping slug/locale history. readExistingCrawlerJobs
  // reads the crawler's own COMMITTED slice (data/jobs/by-crawler/manor.json)
  // first, falling back to DATA_JOBS only if that slice is empty/missing.
  const allJobs = readExistingCrawlerJobs(MANOR_KEY, DATA_JOBS);

  const nonManorJobs = allJobs.filter((j) => !isManorJob(j));
  const existingManorJobs = allJobs.filter(isManorJob);

  // Stats only — computed on the same stable key mergePreserveLocaleData
  // matches on (extractStableJobId(url), i.e. the trailing numeric
  // requisition id), NOT the raw URL. Manor's jobs2web URLs embed the
  // human title before that id, so a title edit (e.g. adding a "*in"
  // gender marker) rewrites the URL on every re-crawl.
  const existingKeys = new Set(
    existingManorJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const discoveredKeys = new Set(
    discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // Delegate the actual old<->fresh reconciliation to the shared,
  // stable-id-matching merge (issue #3699): matching by raw URL alone
  // treated any vendor URL/title rewrite as delete+insert, silently
  // dropping previousSlugs/previousSlugsByLocale/firstSeenAt for the
  // "deleted" half instead of capturing the rename via
  // addPreviousSlugForLocale/captureLostSlugs.
  // The merge keeps existing non-source translations; drop the stale ones
  // earlier runs wrote (source body copied into `it`, generic paragraph in the
  // other slots) so the translation step refills them from the source slot.
  const mergedManorJobs = mergePreserveLocaleData(existingManorJobs, discoveredJobs)
    .map(stripStaleManorLocaleSlots);

  const finalJobs = [...nonManorJobs, ...mergedManorJobs];

  writeJson(DATA_JOBS, finalJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, finalJobs);

  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  ➖ Removed: ${removed}`);
  console.log(`  📦 Total jobs in file: ${finalJobs.length}`);
}

/* ── Adapter update ────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${MANOR_KEY}.json`);
  let adapter = {};
  try {
    adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  } catch { /* first run */ }

  const seedMetaByUrl = {};
  for (const url of seedUrls) {
    seedMetaByUrl[url] = {
      company: MANOR_COMPANY_NAME,
      companyDomain: 'manor.ch',
    };
  }

  adapter = {
    ...adapter,
    companyKey: MANOR_KEY,
    companyName: MANOR_COMPANY_NAME,
    companyHost: MANOR_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['sitemap'],
    seedUrls,
    seedMetaByUrl,
    notes:
      'Sitemap-based crawler — positions.manor.ch (SAP SuccessFactors / jobs2web). Manor AG national department-store chain (HQ Basel) — collects CH-wide across all target cantons.',
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath}`);
}

/* ── Run shared crawler for localization ───────────────────── */
async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: MANOR_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

/* ── Post-processing ───────────────────────────────────────── */
function postProcessManorJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;

  let changed = false;
  const seenKeys = new Map();

  const processed = jobs.filter((job) => {
    if (!isManorJob(job)) return true;

    // Canonicalize company key
    if (job.companyKey !== MANOR_KEY) {
      job.companyKey = MANOR_KEY;
      changed = true;
    }

    // Deduplicate by URL
    const url = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const dedupKey = url || normalizeKey(job.slug || job.title || '');
    if (seenKeys.has(dedupKey)) return false;
    seenKeys.set(dedupKey, true);

    return true;
  });

  if (changed || processed.length !== jobs.length) {
    writeJson(DATA_JOBS, processed);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, processed);
    console.log(`🔧 Post-processed: ${jobs.length} → ${processed.length} jobs`);
  }
}

/* ── Stats ─────────────────────────────────────────────────── */
function logStats(before) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const manorJobs = Array.isArray(jobs) ? jobs.filter(isManorJob) : [];
  const after = snapshotJobSlugs(manorJobs);
  const diff = computeCrawlDiff(before, after);
  printCrawlChangeSummary(diff, 'Manor');
  writeCrawlChangeSummaryToGH(diff, 'Manor');

  console.log(`\n🏬 Total Manor jobs: ${manorJobs.length}`);
  for (const j of manorJobs) {
    console.log(`  • ${j.title} — ${j.company} (${j.location}, ${j.canton || j.country || '?'})`);
  return diff;
  }
}

/* ── Locale validation ─────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MANOR_STRICT',
    label: 'Manor',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isManorJob,
    locales: MANOR_LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_manor_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Manor jobs found — the company may not have active Swiss openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(MANOR_KEY, 'Manor');
  console.log('═══════════════════════════════════════════════');
  console.log('  Manor AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');

  // Snapshot before
  const beforeMap = snapshotJobSlugs(readExistingCrawlerJobs(MANOR_KEY, DATA_JOBS).filter(isManorJob))

  // Phase 1: discover jobs from sitemap
  const discoveredJobs = await fetchManorJobs();

  if (discoveredJobs.length === 0) {
    console.log('ℹ️  No Swiss job listings found — skipping crawl.');
    return;
  }

  // Phase 2: merge into jobs.json
  const seedUrls = discoveredJobs.map((j) => j.url);
  mergeManorJobs(discoveredJobs);

  // Phase 3: update adapter
  updateAdapterConfig(seedUrls);

  // Phase 4: run shared crawler for AI localization
  await runBaseCrawler();

  // Phase 5: post-process
  postProcessManorJobs();

  // Phase 6: log stats
  const diff = logStats(beforeMap);

  // Phase 7: locale validation
  validateLocales();

  console.log('✅ Manor crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isManorJob) : [];
  writeJobsCrawlerSlice(MANOR_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: MANOR_KEY,
    label: 'Manor',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

const isDirectRun = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => exitCrawlerOnError(err, 'Manor'));
}
