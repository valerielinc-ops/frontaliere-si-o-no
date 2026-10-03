#!/usr/bin/env node
/**
 * Dedicated Galenica crawler runner.
 *
 * Source:
 *   https://jobs.galenica.com/it/jobs/
 *   Solique JSON: https://jobs.galenica.com/public/wGlobal/lib/apps/jobs/solique/scripts/data.json
 *
 * This script:
 *   1. Fetches the full job listing from the static Solique data.json.
 *   2. Filters for source-backed Swiss positions across all 26 cantons,
 *      preferring the Italian language variant.
 *   3. Deduplicates by job ID (same job appears in de/fr/it).
 *   4. Merges discovered jobs into data/jobs.json.
 *   5. Updates the adapter config with discovered seed URLs.
 *   6. Runs the shared base crawler for AI localization.
 *   7. Post-processes rows for canonical consistency.
 *   8. Validates locale coverage.
 *
 * Swiss subsidiaries: Sun Store, Amavita, Coop Vitality, UFD.
 */
import fs from 'node:fs';
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
  detectLang,
  deriveLocalizedSlug,
  normalize,
  normalizeKey,
  mergePreserveLocaleData,
  translateMissingJobLocales,
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { htmlFragmentToMarkdown, parseYoustyApprenticeshipHtml } from './lib/yousty-job-parser.mjs';
import { SWISS_CANTONS } from './lib/crawler-location-config.mjs';
import {
  inferAnyCanton,
  isTargetSwissLocation,
  swissMunicipalityCantons,
} from './lib/target-swiss-locations.mjs';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const GALENICA_KEY = 'galenica';
// Per-crawler-scoped scratch path — this crawler does its own fetch+merge
// (no runDedicatedBaseCrawler call), but still runs as one of ~25 sibling
// background steps sharing a filesystem checkout in CI, so writing straight
// to the shared, gitignored, CI-absent data/jobs.json is the same
// cross-process-racy write pattern behind #3769/#3770. Scope it per-company.
const DATA_JOBS = crawlerScratchPathFor(GALENICA_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const GALENICA_COMPANY_NAME = 'Galenica AG';
const GALENICA_HOST = 'jobs.galenica.com';
const GALENICA_DATA_URL =
  'https://jobs.galenica.com/public/wGlobal/lib/apps/jobs/solique/scripts/data.json';
const GALENICA_CAREERS_URL = 'https://jobs.galenica.com/it/jobs/';
const GALENICA_LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Solique occasionally returns a one-character locality fragment (for
 * example "S") alongside a valid canton. A canton alone is not enough
 * evidence to publish that fragment as a job location: keep the item out of
 * the Swiss set and let another language variant provide a complete source
 * locality if one exists.
 */
function hasUsableGalenicaCity(city) {
  const normalized = String(city || '').replace(/\s+/g, ' ').trim();
  return normalized.length >= 2 && normalized.toUpperCase() !== 'CH';
}

/* ── Matcher ───────────────────────────────────────────────── */
function isGalenicaJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === GALENICA_KEY ||
    key === 'galenica-ag' ||
    key.includes('galenica') ||
    company.includes('galenica') ||
    host === GALENICA_HOST
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === GALENICA_HOST ||
      host === 'www.galenica.com' ||
      host.endsWith('.yousty.ch') ||
      host === 'www.yousty.ch' ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category detection ────────────────────────────────────── */
function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/farmaci|pharma|apothek|apotheke|pharmacie/i.test(t)) return 'healthcare';
  if (/logisti|magazzin|lager|warehouse|entrepôt/i.test(t)) return 'logistics';
  if (/vendita|sales|vente|verkauf/i.test(t)) return 'sales';
  if (/it\b|software|developer|system|informatik/i.test(t)) return 'technology';
  if (/market|kommunikation|communication/i.test(t)) return 'marketing';
  if (/hr\b|human|personale|personal/i.test(t)) return 'hr';
  if (/finanz|finance|contabil|buchhaltung|comptab/i.test(t)) return 'finance';
  if (/direzione|direction|management|leitung/i.test(t)) return 'management';
  if (/apprendista|apprenti|lehrling|afc|efz|cfc/i.test(t)) return 'apprenticeship';
  return 'healthcare'; // default for Galenica
}

/* ── Description ─────────────────────────────────────────── */
/**
 * The generic company text earlier versions published INSTEAD of the posting
 * ("{title} presso {firm} (Gruppo Galenica), con sede a {city} … Galenica è il
 * principale gruppo svizzero …" and its en/de/fr variants). It is not content
 * of the vacancy and is never published again: it is recognised only so a
 * stored record carrying it is not treated as a description read from the
 * source.
 */
const GALENICA_COMPANY_BLURB_RE = /\((?:Gruppo Galenica|Galenica Group)\), (?:con sede a|located in|gelegen in|situé à) |Galenica (?:è il principale gruppo svizzero|is the leading Swiss healthcare group|is die führende Schweizer Gesundheitsgruppe|is le premier groupe de santé suisse)/;

export function isGalenicaCompanyBlurb(text = '') {
  return GALENICA_COMPANY_BLURB_RE.test(String(text || ''));
}

const WORKPLACE_LABEL = { de: 'Arbeitsort', fr: 'Lieu de travail', it: 'Luogo di lavoro', en: 'Place of work' };

/**
 * "**Arbeitsort:** <branch>, <street>, <NPA locality>" in the language of the
 * body. It goes FIRST: the branch is what tells apart the places a brand
 * publishes with one identical text (Amavita, Sun Store and Coop Vitality
 * post the same apprenticeship body for every pharmacy of a city), and it is
 * real content of the posting (Solique `worklocationaddress`, Yousty
 * "Dein Arbeitsort").
 */
export function galenicaWorkplaceLine(workLocation = {}, lang = 'it') {
  const place = [
    workLocation.branch,
    workLocation.street,
    [workLocation.zip, workLocation.city].filter(Boolean).join(' '),
  ].map((part) => String(part || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const unique = place.filter((part, i) => place.indexOf(part) === i);
  if (unique.length === 0) return '';
  return `**${WORKPLACE_LABEL[lang] || WORKPLACE_LABEL.it}:** ${unique.join(', ')}`;
}

/**
 * The role content of a Solique posting, in the order the publication page
 * renders it (`getSinglePublicationData`): intro, tasks, profile, additional
 * information, working environment, benefits and "about us" (the work
 * location opens the description, see galenicaWorkplaceLine). Contact persons, apply/e-mail/share/podcast text are page chrome
 * and stay out. Only the regular vacancies carry these textblocks; the
 * apprenticeship items of the same feed carry just a title and a Yousty link.
 */
export function buildGalenicaSoliqueDescription(textblocks = {}) {
  const tb = textblocks && typeof textblocks === 'object' ? textblocks : {};
  const text = (key) => htmlFragmentToMarkdown(tb[key] || '');
  const title = (key) => String(tb[key] || '').replace(/\s+/g, ' ').trim();
  const sections = [];
  const pushSection = (heading, body) => {
    if (!body) return;
    sections.push(heading ? `## ${heading}\n\n${body}` : body);
  };

  pushSection('', text('introductorytext'));
  pushSection(title('taskstitle'), text('tasks'));
  pushSection(title('profiletitle'), text('profile'));
  pushSection('', text('additionalinformation'));
  pushSection(title('workingenvironmenttitle'), text('workingenvironment'));

  const benefits = [];
  for (let i = 1; i <= 10; i += 1) {
    const benefit = htmlFragmentToMarkdown(tb[`benefit${i}text`] || '').replace(/\s+/g, ' ').trim();
    if (benefit) benefits.push(`- ${benefit}`);
  }
  if (benefits.length > 0) {
    const note = text('benefitstext');
    pushSection(title('benefitstitle'), [benefits.join('\n'), note].filter(Boolean).join('\n\n'));
  }

  pushSection(title('aboutustitle'), text('aboutus'));

  // No tasks and no profile = not a vacancy body (apprenticeship stub).
  if (!text('tasks') && !text('profile')) return '';
  return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Where the job is, not where the recruiter sits. On the regular vacancies
 * `contact` is the recruiting contact (always "Galenica AG, Untermattweg 8,
 * 3001 Bern"), while the branch address is `textblocks.worklocationaddress`
 * ("<b>Amavita Apotheke im Bahnhof Thun</b><br/>Seestrasse 2<br/>3600 Thun")
 * and the canton is `textblocks.georegion` ("CH-BE") or `textblocks.canton`.
 * Apprenticeship items carry no textblocks: their `contact` IS the branch.
 */
export function galenicaWorkLocation(item = {}) {
  const contact = item?.contact || {};
  const tb = item?.textblocks || {};
  const fromContact = {
    city: String(contact.city || '').trim(),
    zip: String(contact.zip || contact.postalCode || '').trim(),
    street: String(contact.street || '').trim(),
    state: String(contact.state || '').trim(),
    country: String(contact.country || contact.countryCode || '').trim(),
    branch: '',
  };
  const regionCanton = (String(tb.georegion || '').trim().match(/^CH-([A-Z]{2})$/i) || [])[1] || '';
  const state = (regionCanton || String(tb.canton || '').trim()).toUpperCase();
  const lines = htmlFragmentToMarkdown(tb.worklocationaddress || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const zipIndex = lines.map((line) => /^\d{4}\s+\S/.test(line)).lastIndexOf(true);
  if (zipIndex >= 0) {
    const [, zip, city] = lines[zipIndex].match(/^(\d{4})\s+(.+)$/);
    const branch = String(tb.worklocationbranch || '').trim() || (zipIndex > 0 ? lines[0] : '');
    const street = zipIndex > 0 && lines[zipIndex - 1] !== branch ? lines[zipIndex - 1] : '';
    return { city: city.trim(), zip, street, state, country: '', branch };
  }
  const locationMatch = String(tb.location || '').trim().match(/^(\d{4})\s+([^,(]+)/);
  if (locationMatch) {
    return { city: locationMatch[2].trim(), zip: locationMatch[1], street: '', state, country: '', branch: '' };
  }
  return fromContact;
}

/* ── Build job detail URL ──────────────────────────────────── */
function buildJobUrl(job) {
  // Always use the Galenica job portal URL with hash fragment
  const jobId = String(job.id || '');
  return `https://jobs.galenica.com/it/jobs/#job.id=${encodeURIComponent(jobId)}`;
}

/**
 * Resolve a Solique location to a Swiss canton without inventing a fixed
 * employer canton. The source's city is authoritative when it is an
 * unambiguous Swiss municipality: the regular feed's `contact` is the
 * recruiting office, and apprenticeship contacts can retain a stale/default
 * state after a branch moves canton (Moutier/BE → JU). A valid source state is
 * still used for localities not present in the BFS municipality snapshot and
 * to disambiguate homonyms. The canton name is included in the
 * `isTargetSwissLocation` signal because the source uses localities such as
 * "Blonay" and "Wabern" that are not all represented as standalone
 * municipality aliases in the current BFS file.
 */
const SWISS_COUNTRY_VALUES = new Set(['CH', 'CHE', 'SWITZERLAND', 'SCHWEIZ', 'SUISSE', 'SVIZZERA']);

export function resolveGalenicaCanton(contact = {}) {
  const city = String(contact.city || '').trim();
  const rawState = String(contact.state || '').trim();
  const stateCanton = inferAnyCanton(rawState);
  const country = String(contact.country || contact.countryCode || '').trim().toUpperCase();

  if (!hasUsableGalenicaCity(city)
    || (rawState && !stateCanton)
    || (country && !SWISS_COUNTRY_VALUES.has(country))) return '';

  const cityCantons = swissMunicipalityCantons(city);
  let canton = '';
  if (cityCantons.length === 1) {
    // A source-backed, unambiguous municipality outranks a contact/default
    // state. This is the Sion/VD and Moutier/BE failure mode from #11049.
    canton = cityCantons[0];
  } else if (cityCantons.length > 1) {
    // A homonym is safe only when the source state selects one of its known
    // cantons. An unrelated state is a contradictory pair: reject it instead
    // of silently choosing the first canton in the lookup table.
    canton = stateCanton && cityCantons.includes(stateCanton) ? stateCanton : '';
  } else {
    // Keep the source state for valid localities not yet represented by the
    // municipality snapshot (for example Blonay, Wabern and Le Lignon).
    canton = stateCanton || inferAnyCanton(city);
  }
  const cantonNames = SWISS_CANTONS[canton]?.names || [];
  const locationSignal = [city, ...cantonNames].filter(Boolean).join(' ');
  return canton && isTargetSwissLocation(locationSignal) ? canton : '';
}

export function isSwissGalenicaItem(item) {
  return Boolean(resolveGalenicaCanton(galenicaWorkLocation(item)));
}

/* ── Fetch & parse ─────────────────────────────────────────── */
async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 15000) {
  return fetchHtml(url, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
}

function youstyProfileUrl(variants = []) {
  return variants.find((v) => /yousty\.ch/i.test(String(v?.textblocks?.profilelink || '')))?.textblocks?.profilelink || '';
}

async function enrichFromYoustyProfile(variants, timeoutMs) {
  const profileUrl = youstyProfileUrl(variants);
  if (!profileUrl) return null;

  try {
    const html = await fetchText(profileUrl, timeoutMs);
    const parsed = parseYoustyApprenticeshipHtml(html, profileUrl);
    if (!parsed.description) return { applyUrl: parsed.applyUrl || profileUrl };
    return {
      description: parsed.description,
      sourceLang: detectLang(parsed.description, 'it'),
      applyUrl: parsed.applyUrl || profileUrl,
    };
  } catch (err) {
    console.warn(`⚠️  Failed to enrich Yousty apprenticeship profile ${profileUrl}: ${err?.message || err}`);
    return { applyUrl: profileUrl };
  }
}

/**
 * One job from the language variants of one Solique id. The description is
 * the posting's own content in the language the source published it in:
 * the Solique textblocks for regular vacancies, the Yousty profile text for
 * apprenticeships, opened by the work-location line. With neither, the job
 * comes back flagged `noSourceDescription` (see mergeGalenicaJobs). The previous
 * version ALWAYS published that blurb, pinned `sourceLang` to `it`, so the
 * Yousty text landed in a non-source slot that `mergePreserveLocaleData`
 * then discarded in favour of the stored blurb: 253/253 stored jobs carried
 * the same template and none of the source's task/profile lists.
 */
export function buildGalenicaJob(variants = [], { youstyEnrichment = null } = {}) {
  // Prefer Italian variant, then German, then French, then any
  const preferred =
    variants.find((v) => v.lang === 'it') ||
    variants.find((v) => v.lang === 'de') ||
    variants.find((v) => v.lang === 'fr') ||
    variants[0];
  if (!preferred) return { skip: 'no variants' };

  const workLocation = galenicaWorkLocation(preferred);
  const textblocks = preferred.textblocks || {};

  const title = textblocks.jobtitle || '';
  if (!title) return { skip: 'no title' };

  const firm = preferred.contact?.firm || GALENICA_COMPANY_NAME;
  const city = workLocation.city;
  const canton = resolveGalenicaCanton(workLocation);
  if (!city || !canton) return { skip: 'source location did not resolve to a Swiss canton' };
  const jobUrl = buildJobUrl(preferred);

  const category = detectCategory(title);

  // Build localized titles from the source's own language variants
  const titleEn = variants.find((v) => v.lang === 'en')?.textblocks?.jobtitle ||
                  variants.find((v) => v.lang === 'de')?.textblocks?.jobtitle || title;
  const titleDe = variants.find((v) => v.lang === 'de')?.textblocks?.jobtitle || title;
  const titleFr = variants.find((v) => v.lang === 'fr')?.textblocks?.jobtitle || title;

  const baseSlug = normalizeKey(`galenica ${firm} ${title} ${city}`);
  const slugEn = normalizeKey(`galenica ${firm} ${titleEn} ${city}`) || baseSlug;
  const slugDe = normalizeKey(`galenica ${firm} ${titleDe} ${city}`) || baseSlug;
  const slugFr = normalizeKey(`galenica ${firm} ${titleFr} ${city}`) || baseSlug;

  const job = {
    title,
    company: `${firm} (Galenica)`,
    companyKey: GALENICA_KEY,
    url: jobUrl,
    location: city,
    canton,
    country: 'CH',
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    postalCode: workLocation.zip,
    streetAddress: workLocation.street,
    category,
    description: '',
    descriptionByLocale: {},
    applyUrl: youstyEnrichment?.applyUrl || '',
    postedDate: preferred.publication?.start
      ? new Date(preferred.publication.start).toISOString().slice(0, 10)
      : '',
    source: 'company-website',
    sourceLang: '',
    slug: baseSlug,
    slugByLocale: {
      it: baseSlug,
      en: slugEn,
      de: slugDe,
      fr: slugFr,
    },
    titleByLocale: {
      it: title,
      en: titleEn,
      de: titleDe,
      fr: titleFr,
    },
  };

  const soliqueDescription = buildGalenicaSoliqueDescription(textblocks);
  const sourceContent = soliqueDescription
    ? { description: soliqueDescription, sourceLang: String(preferred.lang || '').toLowerCase() }
    : (youstyEnrichment?.description
      ? { description: youstyEnrichment.description, sourceLang: youstyEnrichment.sourceLang }
      : null);
  if (!sourceContent) {
    // No text read from the source this run: the caller keeps the text a
    // previous run read, or does not publish the job. Never a made-up blurb.
    return { job, id: preferred.id, firm, city, noSourceDescription: true };
  }
  const sourceLang = ['it', 'en', 'de', 'fr'].includes(sourceContent.sourceLang)
    ? sourceContent.sourceLang
    : detectLang(sourceContent.description, 'it');
  const workplace = galenicaWorkplaceLine(
    { ...workLocation, branch: workLocation.branch || (soliqueDescription ? '' : firm) },
    sourceLang,
  );
  const description = [workplace, sourceContent.description].filter(Boolean).join('\n\n');
  // Source text only: the other locales are filled by the translation step,
  // never with a generic blurb or a copy of the source.
  job.description = description;
  job.sourceLang = sourceLang;
  job.descriptionByLocale = { [sourceLang]: description };
  if (sourceLang === 'it') job.descriptionIt = description;
  // Shared word floor (Non-Negotiable #4) on what is published: the branch
  // line plus the source body.
  if (!meetsSourceBodyFloor(description)) {
    return { job, id: preferred.id, firm, city, thinSourceDescription: true };
  }

  return { job, id: preferred.id, firm, city };
}

async function fetchGalenicaJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;

  console.log('🔍 Fetching Galenica jobs from Solique data.json...');

  let allItems;
  try {
    allItems = await fetchJson(GALENICA_DATA_URL, timeoutMs);
  } catch (err) {
    console.error(`❌ Failed to fetch Galenica data.json: ${err?.message || err}`);
    throw err;
  }

  if (!Array.isArray(allItems) || allItems.length === 0) {
    console.log('ℹ️  No job listings found in data.json.');
    return partitionGalenicaJobs([]);
  }

  console.log(`📋 Solique data.json returned ${allItems.length} total listings.`);

  // Filter for source-backed Swiss jobs across all 26 cantons.
  const swissItems = allItems.filter(isSwissGalenicaItem);
  console.log(`📋 Swiss listings: ${swissItems.length} (across all languages).`);

  // Group by job ID to deduplicate multi-language entries
  const byId = new Map();
  for (const item of swissItems) {
    const id = String(item.id || '');
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(item);
  }

  console.log(`📋 Unique Swiss job IDs: ${byId.size}`);

  const built = [];

  for (const [id, variants] of byId) {
    // Apprenticeship items carry no vacancy textblocks: their content lives
    // on the Yousty profile. Regular vacancies never have a profile link.
    const hasSoliqueBody = variants.some((v) => buildGalenicaSoliqueDescription(v?.textblocks));
    const youstyEnrichment = hasSoliqueBody ? null : await enrichFromYoustyProfile(variants, timeoutMs);
    const result = buildGalenicaJob(variants, { youstyEnrichment });
    if (result.skip) {
      console.log(`⚠️  Skipping job ID ${id}: ${result.skip}`);
      continue;
    }
    console.log(`  ✅ ${result.job.title} — ${result.firm} @ ${result.city} (id: ${id})`);
    built.push(result);
  }

  const discovery = partitionGalenicaJobs(built);
  console.log(
    `📋 Total unique Galenica Swiss jobs discovered: ${built.length} `
    + `(${discovery.jobs.length} with source text, ${discovery.noSource.length} without, `
    + `${discovery.thin.length} thin, ${discovery.dropped.length} republication(s) collapsed)`,
  );
  return discovery;
}

function galenicaJobIdParts(job = {}) {
  const raw = decodeURIComponent(String(job.url || '').split('#job.id=')[1] || '');
  return raw.split('.').map((part) => Number(part) || 0);
}

function compareGalenicaJobIds(a, b) {
  const [pa, pb] = [galenicaJobIdParts(a), galenicaJobIdParts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * Split the built jobs of one run:
 *   - `jobs`: publishable, with a source description;
 *   - `noSource` / `thin`: no source text read this run, or under the shared
 *     word floor (source-body-floor.mjs) — mergeGalenicaJobs keeps the text a previous run read, or does
 *     not publish them;
 *   - `dropped`: true republications — same title and same description,
 *     which opens with the branch line, i.e. the same place — collapsed onto
 *     the lowest Solique id (`kept`); their stored slugs become redirects.
 */
export function partitionGalenicaJobs(built = []) {
  const jobs = [];
  const noSource = [];
  const thin = [];
  for (const entry of built) {
    if (entry.noSourceDescription) noSource.push(entry.job);
    else if (entry.thinSourceDescription) thin.push(entry.job);
    else jobs.push(entry.job);
  }
  const groups = new Map();
  for (const job of jobs) {
    const key = `${normalize(job.title)}\u0000${String(job.description || '').replace(/\s+/g, ' ').trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const keptSet = new Set();
  const dropped = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(compareGalenicaJobIds);
    keptSet.add(sorted[0]);
    for (const job of sorted.slice(1)) dropped.push({ dropped: job, kept: sorted[0] });
  }
  return { jobs: jobs.filter((job) => keptSet.has(job)), noSource, thin, dropped };
}

/* ── Merge into jobs.json ──────────────────────────────────── */

function galenicaStableKey(job) {
  return extractStableJobId(job?.url) || String(job?.url || '');
}

/**
 * The source text a stored record carries, when it is one: not the legacy
 * company blurb and not thin. Used to keep publishing a job whose source text
 * could not be read in this run.
 */
export function storedGalenicaSourceText(record) {
  if (!record) return null;
  const lang = String(record.sourceLang || '').toLowerCase();
  const text = String(record.descriptionByLocale?.[lang] || record.description || '').trim();
  if (!text || isGalenicaCompanyBlurb(text) || !meetsSourceBodyFloor(text)) return null;
  return { text, lang: ['it', 'en', 'de', 'fr'].includes(lang) ? lang : detectLang(text, 'it') };
}

/**
 * Pure merge of one run into the stored Galenica records (no I/O).
 * @returns {{ jobs: object[], stats: { added: number, updated: number, removed: number, unpublished: object[], collapsed: number, legacyBlurbRecords: number } }}
 */
export function mergeGalenicaRecords(existingGalenicaJobs = [], { jobs: freshJobs = [], noSource = [], thin = [], dropped = [] } = {}) {
  const existingByKey = new Map(existingGalenicaJobs.map((j) => [galenicaStableKey(j), j]));

  // Without source text this run: keep what a previous run read from the
  // source, or do not publish. Never a made-up description.
  const discoveredJobs = [...freshJobs];
  const unpublished = [];
  for (const job of [...noSource, ...thin]) {
    const previous = storedGalenicaSourceText(existingByKey.get(galenicaStableKey(job)));
    if (!previous) {
      unpublished.push(job);
      continue;
    }
    job.description = previous.text;
    job.sourceLang = previous.lang;
    job.descriptionByLocale = { [previous.lang]: previous.text };
    if (previous.lang === 'it') job.descriptionIt = previous.text;
    discoveredJobs.push(job);
  }

  const existingKeys = new Set(existingByKey.keys());
  const discoveredKeys = new Set(discoveredJobs.map(galenicaStableKey));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingGalenicaJobs, discoveredJobs);
  const mergedByKey = new Map(merged.map((j) => [galenicaStableKey(j), j]));

  // Collapsed republications: their stored URLs keep resolving on the survivor.
  for (const { dropped: gone, kept } of dropped) {
    const stored = existingByKey.get(galenicaStableKey(gone));
    const survivor = mergedByKey.get(galenicaStableKey(kept));
    if (stored && survivor) captureLostSlugs(survivor, stored.slugByLocale || {}, stored.slug || '', 20);
  }

  const removeKeys = new Set([...unpublished, ...dropped.map((d) => d.dropped)].map(galenicaStableKey));
  let legacyBlurbRecords = 0;
  const jobs = merged.filter((job) => {
    if (removeKeys.has(galenicaStableKey(job))) return false;
    // A record kept only by the grace period that still carries nothing but
    // the old blurb has no source text to show.
    if (!storedGalenicaSourceText(job) && isGalenicaCompanyBlurb(job.description)) {
      legacyBlurbRecords += 1;
      return false;
    }
    return true;
  });
  // Blurb copies left in other locale slots are not translations of the
  // posting: clear them so the translation step refills them.
  for (const job of jobs) {
    for (const [locale, text] of Object.entries(job.descriptionByLocale || {})) {
      if (isGalenicaCompanyBlurb(text)) delete job.descriptionByLocale[locale];
    }
    if (isGalenicaCompanyBlurb(job.descriptionIt)) delete job.descriptionIt;
  }

  const finalKeys = new Set(jobs.map(galenicaStableKey));
  return {
    jobs,
    stats: {
      added,
      updated,
      removed: [...existingKeys].filter((k) => !finalKeys.has(k)).length,
      unpublished,
      collapsed: dropped.length,
      legacyBlurbRecords,
    },
  };
}

function mergeGalenicaJobs(discovery) {
  // #3699 (2nd defect class): data/jobs.json is gitignored — on a fresh CI
  // checkout it doesn't exist yet, so a raw fs.existsSync(DATA_JOBS) read
  // would find ZERO existing jobs and treat every discovered job as brand
  // new, silently dropping slug/locale history. readExistingCrawlerJobs
  // reads the crawler's own COMMITTED slice (data/jobs/by-crawler/galenica.json)
  // first, falling back to DATA_JOBS only if that slice is empty/missing.
  const allJobs = readExistingCrawlerJobs(GALENICA_KEY, DATA_JOBS);
  const nonGalenicaJobs = allJobs.filter((j) => !isGalenicaJob(j));
  const { jobs, stats } = mergeGalenicaRecords(allJobs.filter(isGalenicaJob), discovery);
  const finalJobs = [...nonGalenicaJobs, ...jobs];

  writeJson(DATA_JOBS, finalJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, finalJobs);

  console.log(`  ➕ Added: ${stats.added}`);
  console.log(`  🔄 Updated: ${stats.updated}`);
  console.log(`  ➖ Removed: ${stats.removed}`);
  console.log(`  🚫 Not published (no source text, none stored): ${stats.unpublished.length}`);
  console.log(`  ↺ Republications collapsed: ${stats.collapsed}; legacy blurb-only records dropped: ${stats.legacyBlurbRecords}`);
  console.log(`  📦 Total jobs in file: ${finalJobs.length}`);
}

/* ── Adapter update ────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${GALENICA_KEY}.json`);
  let adapter = {};
  try {
    adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  } catch { /* first run */ }

  const seedMetaByUrl = {};
  for (const url of seedUrls) {
    seedMetaByUrl[url] = {
      company: GALENICA_COMPANY_NAME,
      companyDomain: 'galenica.com',
    };
  }

  adapter = {
    ...adapter,
    companyKey: GALENICA_KEY,
    companyName: GALENICA_COMPANY_NAME,
    companyHost: GALENICA_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['api'],
    seedUrls,
    seedMetaByUrl,
    notes:
      'Solique data.json crawler — static national endpoint. Galenica AG healthcare group: Sun Store, Amavita, Coop Vitality and UFD subsidiaries across all 26 Swiss cantons. Each item keeps its source city, postal code and canton; foreign or unresolved locations are dropped.',
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath}`);
}

/* ── Run shared crawler for localization ───────────────────── */
async function runBaseCrawler() {
  // Galenica jobs use hash-fragment URLs (jobs.galenica.com/it/jobs/#job.id=...)
  // which the base crawler's quality gate rejects as non_detail_url.
  // Since Solique data.json already provides titles in it/de/fr, we skip the
  // base crawler and rely on the pre-populated titleByLocale data instead.
  console.log('ℹ️  Skipping base crawler — Solique data already provides multilingual titles.');
}

/* ── Post-processing ───────────────────────────────────────── */
function postProcessGalenicaJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;

  let changed = false;
  const seenKeys = new Map();

  const processed = jobs.filter((job) => {
    if (!isGalenicaJob(job)) return true;

    // Canonicalize company key
    if (job.companyKey !== GALENICA_KEY) {
      job.companyKey = GALENICA_KEY;
      changed = true;
    }

    const descriptionByLocale = {
      ...(job.descriptionByLocale && typeof job.descriptionByLocale === 'object' ? job.descriptionByLocale : {}),
    };
    const fallbackIt = String(job.descriptionIt || descriptionByLocale.it || job.description || '').trim();
    const fallbackEn = String(descriptionByLocale.en || job.description || fallbackIt).trim();
    const fallbackDe = String(descriptionByLocale.de || fallbackEn || fallbackIt).trim();
    const fallbackFr = String(descriptionByLocale.fr || fallbackEn || fallbackIt).trim();

    if (fallbackIt && descriptionByLocale.it !== fallbackIt) {
      descriptionByLocale.it = fallbackIt;
      changed = true;
    }
    if (fallbackEn && descriptionByLocale.en !== fallbackEn) {
      descriptionByLocale.en = fallbackEn;
      changed = true;
    }
    if (fallbackDe && descriptionByLocale.de !== fallbackDe) {
      descriptionByLocale.de = fallbackDe;
      changed = true;
    }
    if (fallbackFr && descriptionByLocale.fr !== fallbackFr) {
      descriptionByLocale.fr = fallbackFr;
      changed = true;
    }
    job.descriptionByLocale = descriptionByLocale;

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
  const galJobs = Array.isArray(jobs) ? jobs.filter(isGalenicaJob) : [];
  const after = snapshotJobSlugs(galJobs);
  const diff = computeCrawlDiff(before, after);
  printCrawlChangeSummary(diff, 'Galenica');
  writeCrawlChangeSummaryToGH(diff, 'Galenica');

  console.log(`\n💊 Total Galenica jobs: ${galJobs.length}`);
  for (const j of galJobs) {
    console.log(`  • ${j.title} — ${j.company} (${j.location}, ${j.canton || j.country || '?'})`);
  return diff;
  }
}

/* ── Locale validation ─────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_GALENICA_STRICT',
    label: 'Galenica',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isGalenicaJob,
    locales: GALENICA_LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_galenica_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Galenica jobs found — the company may not have active Swiss openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(GALENICA_KEY, 'Galenica');
  console.log('═══════════════════════════════════════════════');
  console.log('  Galenica AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');

  // Snapshot before
  const beforeMap = snapshotJobSlugs(readExistingCrawlerJobs(GALENICA_KEY, DATA_JOBS).filter(isGalenicaJob))

  // Phase 1: discover jobs from Solique data.json
  const discoveredJobs = await fetchGalenicaJobs();

  const discoveredCount = discoveredJobs.jobs.length + discoveredJobs.noSource.length + discoveredJobs.thin.length;
  if (discoveredCount === 0) {
    console.log('ℹ️  No Swiss job listings found — skipping crawl.');
    return;
  }

  // Phase 2: merge into jobs.json
  const seedUrls = [...discoveredJobs.jobs, ...discoveredJobs.noSource, ...discoveredJobs.thin].map((j) => j.url);
  mergeGalenicaJobs(discoveredJobs);

  // Phase 3: update adapter
  updateAdapterConfig(seedUrls);

  // Phase 4: run shared crawler for AI localization
  await runBaseCrawler();

  // Phase 5: post-process
  postProcessGalenicaJobs();

  // Phase 5b: translate the source-language description into the other
  // locales (or mark it for translate-pending when AI translation is skipped).
  console.log('\n🌐 Running locale fill for Galenica jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isGalenicaJob,
  });

  // Phase 6: log stats
  const diff = logStats(beforeMap);

  // Phase 7: locale validation
  validateLocales();

  console.log('✅ Galenica crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isGalenicaJob) : [];
  writeJobsCrawlerSlice(GALENICA_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: GALENICA_KEY,
    label: 'Galenica',
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

// CLI entry point — guarded so unit tests can import isSwissGalenicaItem()
// without triggering a live crawl (issue #3055 item 3 test coverage).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Galenica'));
}
