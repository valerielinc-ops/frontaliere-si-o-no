#!/usr/bin/env node
/**
 * Dedicated Swiss Medical Network crawler runner.
 *
 * Swiss Medical Network operates multiple healthcare facilities across Switzerland,
 * including Clinica Sant'Anna and Clinica Moncucco in Ticino.
 * Uses SmartRecruiters as ATS.
 *
 * Career page: https://www.swissmedical.net/en/career/job-offers
 * Ticino filter: ?region=7845726f-4952-4b7c-88da-8ff4f85e6afb
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { parseSwissMedicalJobs, parseSmartRecruiterDetail, getClinicAddress, slugify, normalizeSpace, TICINO_REGION_UUID } from './lib/swiss-medical-network-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'swiss-medical-network';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Swiss Medical Network';
const COMPANY_HOST = 'www.swissmedical.net';
const CAREERS_URL = `https://www.swissmedical.net/en/career/job-offers?region=${TICINO_REGION_UUID}`;
const LOCALES = ['it', 'en', 'de', 'fr'];

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
  if (/junior|entry|intern|stage|apprenti|assistant/i.test(t)) return 'ENTRY';
  if (/senior|lead|head|director|chief|capo|primario/i.test(t)) return 'SENIOR';
  return 'MID';
}

async function fetchPage(url) {
  const timeoutMs = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '20000', 10);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)', Accept: 'text/html', 'Accept-Language': 'en,it-CH;q=0.9' } });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
}

async function fetchCareersPage() {
  return fetchPage(CAREERS_URL);
}

/**
 * Build a rich fallback description (>50 words) for Swiss Medical Network.
 */
function buildFallbackDescription(title, clinic, city, locale = 'en') {
  if (locale === 'it') {
    return `Posizione aperta: ${title} presso ${clinic} a ${city}, Cantone Ticino, Svizzera.\n\nSwiss Medical Network è il principale gruppo sanitario privato in Svizzera, fondato nel 2002. Il gruppo gestisce oltre 20 strutture sanitarie tra cui cliniche, centri medici e istituti di riabilitazione in tutta la Svizzera. ${clinic} offre un ambiente di lavoro stimolante e dinamico, con condizioni di impiego allineate ai contratti collettivi di lavoro. Il gruppo è in costante crescita e offre opportunità di sviluppo professionale, formazione continua e un pacchetto retributivo competitivo con ottime prestazioni sociali. Candidarsi per entrare a far parte di un team appassionato e dedicato alla cura dei pazienti.`;
  }
  return `Open position: ${title} at ${clinic} in ${city}, Canton Ticino, Switzerland.\n\nSwiss Medical Network is Switzerland's leading private healthcare group, established in 2002. The group operates over 20 healthcare facilities including clinics, medical centers, and rehabilitation institutes across Switzerland. ${clinic} offers a stimulating and dynamic working environment, with employment terms aligned with collective bargaining agreements. The group is constantly growing and offers professional development opportunities, continuous training, and a competitive compensation package with excellent social benefits. Apply to become part of a passionate team dedicated to patient care.`;
}

function buildJobFromParsed(parsed, detailDescription = '') {
  const slug = slugify(parsed.title, 'swiss-medical-network');
  const clinic = parsed.clinic || 'Swiss Medical Network';
  const city = parsed.city || 'Lugano';
  const address = getClinicAddress(clinic, city);

  // Use detail description if rich enough, otherwise use fallback
  let descEn = detailDescription;
  if (!descEn || descEn.split(/\s+/).length < 50) {
    descEn = buildFallbackDescription(parsed.title, clinic, city, 'en');
  }
  const descIt = buildFallbackDescription(parsed.title, clinic, city, 'it');

  return {
    url: parsed.applyUrl || `https://www.swissmedical.net/en/career/job-offers`,
    applyUrl: parsed.applyUrl || '',
    title: parsed.title,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    location: city,
    canton: DEFAULT_CANTON,
    country: 'CH',
    postalCode: address.postalCode,
    streetAddress: address.streetAddress,
    description: descEn,
    descriptionByLocale: { en: descEn, it: descIt },
    titleByLocale: { en: parsed.title },
    slug, slugByLocale: { en: slug, it: slugify(parsed.title, 'swiss-medical-network') },
    category: detectCategory(parsed.title),
    datePosted: new Date().toISOString().split('T')[0],
    source: 'swiss-medical-smartrecruiters-crawler',
    employmentType: parsed.employmentRate?.includes('100') ? 'FULL_TIME' : 'PART_TIME',
    experienceLevel: detectExperienceLevel(parsed.title),
    sector: 'Sanità / Healthcare',
    _targetScope: { canton: DEFAULT_CANTON, location: city },
    sourceLang: detectLang(descEn || parsed.title, 'en'),
  };
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }
function filterEmpty(obj = {}) { if (!obj || typeof obj !== 'object') return {}; const out = {}; for (const [k, v] of Object.entries(obj)) { if (v && String(v).trim()) out[k] = v; } return out; }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isSwissMedicalJob(j));
  const existingByUrl = new Map();
  for (const job of allJobs.filter(isSwissMedicalJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) discoveredByUrl.set(canonicalizeUrl(job.url), job);

  let added = 0, updated = 0, removed = 0;
  const merged = [];
  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url);
    const ex = existingByUrl.get(key);
    if (ex) { merged.push({ ...ex, title: d.title || ex.title, company: COMPANY_NAME, companyKey: COMPANY_KEY, source: 'swiss-medical-smartrecruiters-crawler', sourceLang: d.sourceLang || ex.sourceLang, titleByLocale: mergeLocaleTextMap(ex.titleByLocale, d.titleByLocale, 3), descriptionByLocale: mergeLocaleTextMap(ex.descriptionByLocale, d.descriptionByLocale, 30), slugByLocale: mergeLocaleTextMap(ex.slugByLocale, d.slugByLocale, 3) }); updated++; }
    else { merged.push(d); added++; }
  }
  for (const [url] of existingByUrl) { if (!discoveredByUrl.has(url)) removed++; }

  const final = [...nonCompanyJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`\n📦 Merge: ➕${added} 🔄${updated} 🗑️${removed} 📊${final.length}`);
  return { added, updated, removed, total: final.length };
}

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const adapter = fs.existsSync(adapterPath) ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) : {};
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: Math.max(adapter.priority || 0, 10), crawlerModes: ['html'], seedUrls: [CAREERS_URL], notes: 'SwissMedical.net career page — SmartRecruiters ATS — Ticino region filter.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, localizeExistingOnly: true, extraEnv: { JOBS_CRAWLER_MAX_JOB_LINKS: '30', JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '30' } });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Swiss Medical Network');
  console.log('═══════════════════════════════════════════════');
  console.log('  Swiss Medical Network — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');

    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isSwissMedicalJob))

  const html = await fetchCareersPage();
  if (!html) { console.log('\n⚠️ Could not fetch Swiss Medical Network careers page.'); return; }

  const parsed = parseSwissMedicalJobs(html);
  console.log(`  📋 Ticino jobs parsed: ${parsed.length}`);

  // Fetch detail pages from SmartRecruiters for rich descriptions
  const discoveredJobs = [];
  for (const p of parsed) {
    let detailDescription = '';
    if (p.applyUrl) {
      console.log(`    🔗 Fetching detail page: ${p.applyUrl}`);
      const detailHtml = await fetchPage(p.applyUrl);
      if (detailHtml) {
        const detail = parseSmartRecruiterDetail(detailHtml);
        if (detail.description && detail.description.split(/\s+/).length >= 30) {
          detailDescription = detail.description;
          console.log(`    ✅ Detail description: ${detailDescription.split(/\s+/).length} words`);
        } else {
          console.log(`    ⚠️ Detail page description too short (${(detail.description || '').split(/\s+/).length} words), using fallback`);
        }
      } else {
        console.log(`    ⚠️ Could not fetch detail page, using fallback`);
      }
      // Small delay to be respectful to SmartRecruiters
      await new Promise((r) => setTimeout(r, 500));
    }
    discoveredJobs.push(buildJobFromParsed(p, detailDescription));
  }

  if (discoveredJobs.length === 0) { console.log('\n⚠️ No Ticino Swiss Medical Network jobs found.'); return; }

  updateAdapterConfig();
  await mergeJobs(discoveredJobs);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runBaseCrawler();

  // Post-process
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    let fixed = 0;
    for (const j of (Array.isArray(jobs) ? jobs : [])) { if (!isSwissMedicalJob(j)) continue; if (j.company !== COMPANY_NAME) { j.company = COMPANY_NAME; fixed++; } j.companyKey = COMPANY_KEY; j.country = 'CH'; if (!j.canton) { j.canton = DEFAULT_CANTON; fixed++; } }
    if (fixed > 0) { fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n'); fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n'); }
  }

  const finalJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const companyJobs = (Array.isArray(finalJobs) ? finalJobs : []).filter(isSwissMedicalJob);
  console.log(`\n📊 Swiss Medical Network Ticino jobs: ${companyJobs.length}`);
  const afterSnapshot = snapshotJobSlugs(companyJobs);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Swiss Medical Network');
  writeCrawlChangeSummaryToGH(diff, 'Swiss Medical Network');

  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_SWISS_MEDICAL_STRICT', label: 'Swiss Medical Network', dataJobsPath: DATA_JOBS, isTargetJob: isSwissMedicalJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_swiss_medical_domain', failWhenNoJobs: false, noJobsMessage: 'No Swiss Medical Network Ticino jobs found.' });
  console.log('\n✅ Swiss Medical Network crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  writeJobsCrawlerSlice(COMPANY_KEY, companyJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Swiss Medical Network', generatedAt: new Date().toISOString(), total: companyJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`❌ Swiss Medical Network crawler failed: ${err?.message || err}`); process.exit(1); });
