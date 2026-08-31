#!/usr/bin/env node
/**
 * Dedicated Swiss Medical Network crawler runner.
 *
 * Swiss Medical Network operates 25+ healthcare facilities across Switzerland
 * (Genolier VD, Montchoisi/Lausanne VD, Valère VS, Fribourg, Bern, Zürich,
 * Neuchâtel, Sant'Anna/Moncucco TI, …). Uses SmartRecruiters as its ATS.
 *
 * Source: SmartRecruiters public postings API (CH-wide, all cantons) —
 *   https://api.smartrecruiters.com/v1/companies/SwissMedicalNetwork1/postings
 * The swissmedical.net careers page is React-rendered and region-filtered, so
 * we read the API directly and infer the canton per-job from the API location.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { smnPostingsApiUrl, smnPostingDetailApiUrl, normalizeSmnApiPosting, extractSmnApiDescription, extractSmnPostingId, SMN_POSTINGS_API, slugify, normalizeSpace } from './lib/swiss-medical-network-job-parser.mjs';
import { matchesCliniqueDeGenolierPosting } from './lib/clinique-de-genolier-job-parser.mjs';
import { matchesCliniqueDeMontchoisiPosting } from './lib/clinique-de-montchoisi-job-parser.mjs';
import { matchesCliniqueDeValerePosting } from './lib/clinique-de-valere-job-parser.mjs';
import { matchesCliniqueGeneraleBeaulieuPosting } from './lib/clinique-generale-beaulieu-job-parser.mjs';
import { matchesCliniqueGeneraleSteAnnePosting } from './lib/clinique-generale-ste-anne-job-parser.mjs';
import { matchesHopitalDeMoutierPosting } from './lib/hopital-de-moutier-job-parser.mjs';
import { matchesKlinikSiloahPosting } from './lib/klinik-siloah-job-parser.mjs';
import { matchesPrivatklinikBethanienPosting } from './lib/privatklinik-bethanien-job-parser.mjs';
import { matchesPrivatklinikObachPosting } from './lib/privatklinik-obach-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'swiss-medical-network';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Swiss Medical Network';
const COMPANY_HOST = 'www.swissmedical.net';
const CAREERS_URL = 'https://www.swissmedical.net/en/career/job-offers';
const LOCALES = ['it', 'en', 'de', 'fr'];
const DEDICATED_CLINIC_MATCHERS = [
  matchesCliniqueDeGenolierPosting,
  matchesCliniqueDeMontchoisiPosting,
  matchesCliniqueDeValerePosting,
  matchesCliniqueGeneraleBeaulieuPosting,
  matchesCliniqueGeneraleSteAnnePosting,
  matchesHopitalDeMoutierPosting,
  matchesKlinikSiloahPosting,
  matchesPrivatklinikBethanienPosting,
  matchesPrivatklinikObachPosting,
];

function normalize(value = '') { return String(value || '').trim().toLowerCase(); }

function isSwissMedicalJob(job) {
  const key = normalize(job?.companyKey || '').replace(/[^a-z0-9]+/g, '-');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.startsWith('swiss-medical') || company.includes('swiss medical') || company.includes('sant\'anna') || company.includes('moncucco') || url.includes('swissmedical.net') || url.includes('smartrecruiters.com/SwissMedicalNetwork');
}

function isTrustedDomain(rawUrl = '') {
  try { const host = new URL(rawUrl).hostname.toLowerCase(); return host.includes('swissmedical.net') || host.includes('smartrecruiters.com'); }
  catch { return false; }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/medico|arzt|physician|doctor|médecin/i.test(t)) return 'medical';
  if (/infermier|pflege|nurse|krankenschwester/i.test(t)) return 'nursing';
  if (/chirurg|surgeon/i.test(t)) return 'surgery';
  if (/fisioterapi|physiotherap/i.test(t)) return 'physiotherapy';
  if (/psicolog|psycholog/i.test(t)) return 'psychology';
  if (/farmaci|pharma|apothek/i.test(t)) return 'pharmacy';
  if (/amministr|admin|sachbearbeit|assistant/i.test(t)) return 'admin';
  if (/tecnic|techni|labor|lab\b/i.test(t)) return 'technical';
  if (/hr|human|recruit|personal/i.test(t)) return 'hr';
  if (/financ|contabil|buchhalt|account/i.test(t)) return 'finance';
  if (/it\b|software|system|informatik/i.test(t)) return 'technology';
  if (/manag|director|responsabil|leiter|chef/i.test(t)) return 'management';
  return 'healthcare';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(junior|entry|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprenti|assistant)/i.test(t)) return 'ENTRY';
  if (/senior|lead|head|director|chief|capo|primario/i.test(t)) return 'SENIOR';
  return 'MID';
}

async function fetchJson(url) {
  const timeoutMs = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '20000', 10);
  // clearTimeout in `finally` (after res.json() reads the body) so a stalled
  // body aborts at timeoutMs instead of hanging (PR #4118 / review sibling).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)', Accept: 'application/json' } });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.json();
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
  finally { clearTimeout(timer); }
}

/**
 * Posting ids already owned by a DEDICATED SMN clinic crawler (genolier,
 * montchoisi, valère, beaulieu, ste-anne, bethanien, obach, siloah, moutier, …).
 * They read the same SmartRecruiters tenant with a clinic filter, so the CH-wide
 * umbrella must skip those postings to avoid duplicate / canonical-churn pages
 * (the dedicated crawler keeps its stable per-clinic slug). Future dedicated SMN
 * crawlers are covered automatically — any non-umbrella slice with a
 * SwissMedicalNetwork1 URL claims its posting ids.
 */
function loadDedicatedClinicPostingIds() {
  const ids = new Set();
  const dir = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');
  const files = listSliceFileNames(dir);
  for (const f of files) {
    if (f === `${COMPANY_KEY}.json`) continue; // skip the umbrella's own slice
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
    const jobs = data?.jobs || (Array.isArray(data) ? data : []);
    for (const j of jobs) {
      const id = extractSmnPostingId(j?.url);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * The umbrella and dedicated clinic crawlers read the same SmartRecruiters
 * tenant. Snapshot ids remain a useful catch-all for legacy clinics, but
 * cannot prevent a new clinic posting from leaking when the umbrella and a
 * dedicated crawler run in parallel. Apply every dedicated clinic's source
 * predicate directly so ownership does not depend on which slice finishes
 * first.
 */
export function isDedicatedClinicOwnedPosting(rawPosting, dedicatedIds = new Set()) {
  const id = String(rawPosting?.id || '');
  return (id !== '' && dedicatedIds.has(id))
    || DEDICATED_CLINIC_MATCHERS.some((matches) => matches(rawPosting));
}

/** Fetch every SmartRecruiters posting (paginated), CH-wide. */
async function fetchAllApiPostings() {
  const LIMIT = 100;
  const all = [];
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const data = await fetchJson(smnPostingsApiUrl(offset, LIMIT));
    const content = Array.isArray(data?.content) ? data.content : [];
    if (content.length === 0) break;
    all.push(...content);
    const total = Number(data?.totalFound || 0);
    console.log(`  📄 postings ${offset}-${offset + content.length} of ${total || '?'}`);
    offset += content.length;
    if (total && all.length >= total) break;
    if (content.length < LIMIT) break;
  }
  return all;
}

/**
 * Build a rich fallback description (>50 words) for Swiss Medical Network.
 */
function buildFallbackDescription(title, city, locale = 'en') {
  if (locale === 'it') {
    return `Posizione aperta: ${title} presso Swiss Medical Network${city ? ` a ${city}` : ''}, Svizzera.\n\nSwiss Medical Network è il principale gruppo sanitario privato in Svizzera, fondato nel 2002. Il gruppo gestisce oltre 20 strutture sanitarie tra cui cliniche, centri medici e istituti di riabilitazione in tutta la Svizzera. Offre un ambiente di lavoro stimolante e dinamico, con condizioni di impiego allineate ai contratti collettivi di lavoro. Il gruppo è in costante crescita e offre opportunità di sviluppo professionale, formazione continua e un pacchetto retributivo competitivo con ottime prestazioni sociali. Candidarsi per entrare a far parte di un team appassionato e dedicato alla cura dei pazienti.`;
  }
  return `Open position: ${title} at Swiss Medical Network${city ? ` in ${city}` : ''}, Switzerland.\n\nSwiss Medical Network is Switzerland's leading private healthcare group, established in 2002. The group operates over 20 healthcare facilities including clinics, medical centers, and rehabilitation institutes across Switzerland. It offers a stimulating and dynamic working environment, with employment terms aligned with collective bargaining agreements. The group is constantly growing and offers professional development opportunities, continuous training, and a competitive compensation package with excellent social benefits. Apply to become part of a passionate team dedicated to patient care.`;
}

function buildJobFromApi(posting, detailDescription = '', applyUrl = '', postingUrl = '') {
  const slug = slugify(posting.title, 'swiss-medical-network');
  const city = posting.city || '';
  // Real canton from the API location. No Ticino default: leave blank when
  // unresolved (the downstream PLZ/locality hardening fills it) rather than
  // mislabeling a non-TI clinic as Ticino.
  const canton = posting.canton || inferAnyCanton(city) || '';

  let descEn = detailDescription;
  const hasRealDescription = Boolean(detailDescription) && detailDescription.split(/\s+/).length >= 50;
  if (!descEn || descEn.split(/\s+/).length < 50) {
    descEn = buildFallbackDescription(posting.title, city, 'en');
  }
  // Reuse the real scraped description (which may contain genuine bullet/list
  // markup from the SmartRecruiters posting) as the interim 'it' value too.
  // Previously this always called buildFallbackDescription(..., 'it') even
  // when a real, structured detailDescription was available — that synthetic
  // paragraph has zero list markup and, because effectiveDescription() checks
  // the 'it' locale before 'en', it masked the real content for both the
  // parser-quality audit and real Italian-locale site visitors. Only fall
  // back to synthetic boilerplate when no real detail description was
  // scraped at all.
  const descIt = hasRealDescription ? descEn : buildFallbackDescription(posting.title, city, 'it');

  return {
    url: postingUrl || applyUrl || `https://www.swissmedical.net/en/career/job-offers`,
    applyUrl: applyUrl || postingUrl || '',
    title: posting.title,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    location: city,
    addressLocality: city,
    addressRegion: canton,
    canton,
    country: 'CH',
    ...(posting.postalCode && { postalCode: posting.postalCode }),
    description: descEn,
    descriptionByLocale: { en: descEn, it: descIt },
    titleByLocale: { en: posting.title },
    slug, slugByLocale: { en: slug, it: slugify(posting.title, 'swiss-medical-network') },
    category: detectCategory(posting.title),
    datePosted: new Date().toISOString().split('T')[0],
    source: 'swiss-medical-smartrecruiters-crawler',
    employmentType: posting.employmentType || 'FULL_TIME',
    experienceLevel: detectExperienceLevel(posting.title),
    sector: 'Sanità / Healthcare',
    _targetScope: { canton, location: city },
    sourceLang: detectLang(descEn || posting.title, 'en'),
  };
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isSwissMedicalJob(j));
  const existingCompanyJobs = allJobs.filter(isSwissMedicalJob);

  const existingKeys = new Set(existingCompanyJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a SmartRecruiters title/slug rewrite no longer
  // orphans the job's previousSlugs/previousSlugsByLocale/firstSeenAt
  // history the way the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingCompanyJobs, discoveredJobs).map((job) => ({
    ...job,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    source: 'swiss-medical-smartrecruiters-crawler',
  }));

  const final = [...nonCompanyJobs, ...merged];
  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);
  console.log(`\n📦 Merge: ➕${added} 🔄${updated} 🗑️${removed} 📊${final.length}`);
  return { added, updated, removed, total: final.length };
}

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const adapter = fs.existsSync(adapterPath) ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) : {};
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: Math.max(adapter.priority || 0, 10), crawlerModes: ['html'], seedUrls: [SMN_POSTINGS_API, CAREERS_URL], notes: 'Swiss Medical Network — SmartRecruiters public postings API (CH-wide, all cantons); canton inferred per-job from the API location.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, localizeExistingOnly: true, extraEnv: { JOBS_CRAWLER_MAX_JOB_LINKS: '100000', JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000' } });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Swiss Medical Network');
  console.log('═══════════════════════════════════════════════');
  console.log('  Swiss Medical Network — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');

    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isSwissMedicalJob))

  const rawPostings = await fetchAllApiPostings();
  if (!rawPostings.length) { console.log('\n⚠️ Could not fetch Swiss Medical Network postings from the SmartRecruiters API.'); return; }

  // Keep only Swiss postings (the tenant is CH-only, but guard anyway —
  // accept both the ISO code 'ch' and a spelled-out country name).
  const isSwissCountry = (c = '') => !c || /^(ch|switzerland|suisse|schweiz|svizzera)/.test(c);
  const swissPostings = rawPostings
    .map((raw) => ({ raw, normalized: normalizeSmnApiPosting(raw) }))
    .filter(({ normalized }) => normalized.id && normalized.title && isSwissCountry(normalized.country));

  // Drop postings already owned by a dedicated SMN clinic crawler (same
  // SmartRecruiters tenant) to prevent duplicate / canonical-churn job pages.
  const dedicatedIds = loadDedicatedClinicPostingIds();
  const postings = swissPostings
    .filter(({ raw }) => !isDedicatedClinicOwnedPosting(raw, dedicatedIds))
    .map(({ normalized }) => normalized);
  const skippedDedicated = swissPostings.length - postings.length;
  console.log(`  📋 Swiss postings: ${postings.length} / ${rawPostings.length} (skipped ${skippedDedicated} owned by dedicated clinic crawlers)`);

  // Fetch each posting's detail (description + canonical public URL).
  const discoveredJobs = [];
  for (const p of postings) {
    let detailDescription = '';
    let applyUrl = '';
    let postingUrl = '';
    const detail = await fetchJson(smnPostingDetailApiUrl(p.id));
    if (detail) {
      applyUrl = String(detail.applyUrl || '');
      postingUrl = String(detail.postingUrl || '');
      const desc = extractSmnApiDescription(detail);
      if (desc && desc.split(/\s+/).length >= 30) {
        detailDescription = desc;
      }
    }
    console.log(`    ✅ ${p.title} → ${p.city || '?'} (${p.canton || '?'})`);
    discoveredJobs.push(buildJobFromApi(p, detailDescription, applyUrl, postingUrl));
    // Small delay to be respectful to the SmartRecruiters API.
    await new Promise((r) => setTimeout(r, 150));
  }

  if (discoveredJobs.length === 0) { console.log('\n⚠️ No Swiss Medical Network jobs found.'); return; }

  updateAdapterConfig();
  await mergeJobs(discoveredJobs);
  // The base crawler seeds the per-crawler slice from the fresh data/jobs.json
  // before localizing (see runDedicatedBaseCrawler), so the stale committed
  // slice no longer collapses the freshly-expanded crawl.
  console.log('\n🌐 Running base crawler for AI localization...');
  await runBaseCrawler();

  // Post-process
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    let fixed = 0;
    for (const j of (Array.isArray(jobs) ? jobs : [])) { if (!isSwissMedicalJob(j)) continue; if (j.company !== COMPANY_NAME) { j.company = COMPANY_NAME; fixed++; } j.companyKey = COMPANY_KEY; j.country = 'CH'; if (!j.canton) { const c = inferAnyCanton(j.location || j.addressLocality || ''); if (c) { j.canton = c; fixed++; } } }
    if (fixed > 0) { writeJsonAtomic(DATA_JOBS, jobs); writeJsonAtomic(PUBLIC_JOBS, jobs); }
  }

  const finalJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const companyJobs = (Array.isArray(finalJobs) ? finalJobs : []).filter(isSwissMedicalJob);
  console.log(`\n📊 Swiss Medical Network jobs: ${companyJobs.length}`);
  const afterSnapshot = snapshotJobSlugs(companyJobs);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Swiss Medical Network');
  writeCrawlChangeSummaryToGH(diff, 'Swiss Medical Network');

  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_SWISS_MEDICAL_STRICT', label: 'Swiss Medical Network', dataJobsPath: DATA_JOBS, isTargetJob: isSwissMedicalJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_swiss_medical_domain', failWhenNoJobs: false, noJobsMessage: 'No Swiss Medical Network jobs found.' });
  console.log('\n✅ Swiss Medical Network crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  writeJobsCrawlerSlice(COMPANY_KEY, companyJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Swiss Medical Network', generatedAt: new Date().toISOString(), total: companyJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => exitCrawlerOnError(err, 'Swiss Medical Network'));
}
