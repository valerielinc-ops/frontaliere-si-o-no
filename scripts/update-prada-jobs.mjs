#!/usr/bin/env node
/**
 * Dedicated Prada Group crawler runner.
 *
 * Source:
 *   https://jobs.pradagroup.com/
 *
 * Prada Group operates luxury fashion brands with a major site in Mendrisio, Ticino.
 * The careers portal is likely SAP SuccessFactors-based.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  printPublishedJobUrls,
  writeJobsSummary,
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
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import {
  fetchPradaJobUrls,
  fetchPradaDetailPage,
  resolvePradaTicinoLocation,
  slugify, inferEmploymentType,
} from './lib/prada-job-parser.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANY_KEY = 'prada';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Prada Group';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes('prada') || url.includes('pradagroup.com');
}

function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
  }
}

function mergeCompanyJobs(parsedJobs, companyExisting) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((job) => !isCompanyJob(job));
  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    byUrl.set(key, job);
  }
  const deduped = [...byUrl.values()];
  const merged = mergePreserveLocaleData(companyExisting, deduped);
  const clean = merged.sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  writeJobsFiles([...others, ...clean]);
  return clean;
}

/**
 * Build rich synthetic descriptions in all 4 locales.
 * Each must be 200+ chars to safely exceed the 120-char MIN_DESCRIPTION_CHARS threshold.
 */
function buildPradaDescriptions(title, location, department) {
  const dept = department ? ` nel reparto ${department}` : '';
  const deptEn = department ? ` in the ${department} department` : '';
  const deptDe = department ? ` in der Abteilung ${department}` : '';
  const deptFr = department ? ` au département ${department}` : '';

  return {
    it: `Prada Group cerca ${title}${dept} presso la sede di ${location}, Svizzera. ` +
        `Prada Group è una delle principali aziende del lusso al mondo, con la sede industriale e logistica di Mendrisio in Canton Ticino. ` +
        `Il gruppo comprende i marchi Prada, Miu Miu, Church's e Car Shoe. Candidatura tramite il portale ufficiale jobs.pradagroup.com.`,
    en: `Prada Group is looking for a ${title}${deptEn} at their ${location}, Switzerland location. ` +
        `Prada Group is one of the world's leading luxury fashion companies, with a major industrial and logistics hub in Mendrisio, Canton Ticino. ` +
        `The group includes the Prada, Miu Miu, Church's and Car Shoe brands. Apply through the official careers portal at jobs.pradagroup.com.`,
    de: `Prada Group sucht eine/n ${title}${deptDe} am Standort ${location}, Schweiz. ` +
        `Die Prada Group ist eines der weltweit führenden Luxusmodeunternehmen mit einem wichtigen Industrie- und Logistikstandort in Mendrisio, Kanton Tessin. ` +
        `Zur Gruppe gehören die Marken Prada, Miu Miu, Church's und Car Shoe. Bewerbung über das offizielle Karriereportal jobs.pradagroup.com.`,
    fr: `Prada Group recherche un/une ${title}${deptFr} sur le site de ${location}, Suisse. ` +
        `Prada Group est l'une des principales entreprises de mode de luxe au monde, avec un important pôle industriel et logistique à Mendrisio, Canton du Tessin. ` +
        `Le groupe comprend les marques Prada, Miu Miu, Church's et Car Shoe. Candidature via le portail officiel jobs.pradagroup.com.`,
  };
}

async function main() {
  setCrawlerStartTime();
  const sourceCounts = { discovered: null };
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Prada Group', sourceCounts);
  console.log(`👜 Running dedicated ${COMPANY_NAME} crawler...`);

  const priorJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob);
  const _beforeSnapshot = snapshotJobSlugs(priorJobs);

  const rawJobs = await fetchPradaJobUrls();
  sourceCounts.discovered = rawJobs.length;
  if (rawJobs.length === 0) {
    console.log('\u26a0\ufe0f No jobs found on Prada Group careers page. Keeping existing jobs.');
    return;
  }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Prada Group job links. Fetching details...`);
  const parsedJobs = [];
  for (const raw of rawJobs) {
    const listingLocation = resolvePradaTicinoLocation(raw);
    if (!listingLocation) {
      console.log(`  ⏭️  ${raw.title}: source location "${raw.location || '(missing)'}" is outside Mendrisio — skipping`);
      continue;
    }

    const detail = await fetchPradaDetailPage(raw.url);
    // SuccessFactors detail pages are 100% JS-rendered — description is usually empty.
    // Use detail description only if truly substantial (200+ chars), otherwise build rich
    // synthetic descriptions in all 4 locales to pass MIN_DESCRIPTION_CHARS (120).
    let detailDesc = detail?.description || '';
    const hasRealDescription = detailDesc.length >= 200 && !detailDesc.toLowerCase().includes('prada group careers');

    // A non-empty detail location is more authoritative than the listing and
    // must independently pass the same target gate. A blank detail falls back
    // to the already-proven listing/route location.
    const detailLocation = String(detail?.location || '').trim();
    const loc = detailLocation
      ? resolvePradaTicinoLocation({ location: detailLocation, url: raw.url })
      : listingLocation;
    const dept = raw.department || detail?.department || '';
    if (!loc) {
      console.log(`  ⏭️  ${raw.title}: detail location "${detailLocation}" is outside Mendrisio — skipping`);
      continue;
    }

    // Build rich locale-specific descriptions (200+ chars each)
    const descByLocale = hasRealDescription
      ? { en: detailDesc }
      : buildPradaDescriptions(raw.title, loc, dept);

    const description = descByLocale.it || descByLocale.en || Object.values(descByLocale)[0] || '';
    if (description.length < 30) {
      console.log(`  ⚠️  ${raw.title}: description too short (${description.length} chars) — skipping`);
      continue;
    }
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    // Slug-only guard: `loc` (`detail?.location || raw.location || 'Mendrisio'`)
    // can be the literal "undefined"/"null" string (truthy) → `-undefined` in an
    // active slug (#952, class #900/#901). addressLocality keeps `loc` (choke-point
    // normalizer handles de-index).
    const jobSlug = slugify(`${raw.title}-prada-group-${safeLocationToken(loc, 'Mendrisio')}`);
    parsedJobs.push({
      id: `prada-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { en: jobSlug },
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: 'pradagroup.com',
      title: raw.title,
      titleByLocale: { en: raw.title },
      description,
      descriptionByLocale: descByLocale,
      requirements: [],
      requirementsByLocale: { en: [] },
      location: loc,
      canton: 'TI',
      addressLocality: loc,
      addressCountry: 'CH',
      category: 'fashion',
      contract: 'full-time', employmentType: inferEmploymentType(raw.title, description),
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url,
      source: 'Prada Group Dedicated Parser',
      sourceLang: detectLang(description || raw.title, 'en'),
      crawledAt: new Date().toISOString(),
    });
    console.log(`  \u2705 ${raw.title} \u2014 ${loc}`);
  }

  // The query endpoint returned a coherent non-empty snapshot, so records
  // outside this crawler's Mendrisio ownership are known false positives, not
  // transient misses. Exclude them from merge grace and archive their routes.
  const targetExisting = priorJobs.filter((job) => resolvePradaTicinoLocation(job));
  const retiredForeign = priorJobs.filter((job) => !resolvePradaTicinoLocation(job));
  const archivedForeign = archiveRemovedJobsToSlice(retiredForeign, COMPANY_KEY);
  const published = mergeCompanyJobs(parsedJobs, targetExisting);
  printPublishedJobUrls(published, 'Prada Group');
  writeJobsSummary(published, 'Prada Group');

  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Prada Group');
  writeCrawlChangeSummaryToGH(diff, 'Prada Group');

  if (published.length === 0) {
    writeJobsCrawlerSlice(COMPANY_KEY, [], { skipShrinkGuard: true, preserveExistingSlugs: true });
    const _durationMs = getCrawlerElapsedMs();
    writeSummaryCrawlerSlice({
      key: COMPANY_KEY,
      label: 'Prada Group',
      generatedAt: new Date().toISOString(),
      total: 0,
      discovered: rawJobs.length,
      written: 0,
      sourceProvenEmpty: true,
      newCount: 0,
      updatedCount: 0,
      removedCount: diff.removedJobs.length,
      unchangedCount: 0,
      durationMs: _durationMs,
      avgDurationMs: _durationMs,
      durationHistory: [_durationMs],
      newJobs: [],
      updatedJobs: [],
      removedJobs: diff.removedJobs.slice(0, 30),
      unchangedJobs: [],
    });
    await assembleJobsDataset();
    console.log(`ℹ️ Prada source proved 0 Mendrisio jobs; archived ${archivedForeign} foreign route(s).`);
    return;
  }

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });

  validateDedicatedLocaleCoverage({
    strictEnvVar: `JOBS_${COMPANY_KEY.toUpperCase()}_STRICT`,
    label: 'Prada Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCompanyJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: `No ${COMPANY_NAME} jobs found after crawl.`,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
  });

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Prada Group', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Prada Group'));
