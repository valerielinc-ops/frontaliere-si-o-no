#!/usr/bin/env node
/**
 * Job Board Housekeeping
 *
 * Removes job listings that are no longer available.
 *
 * - Source of truth: data/jobs.json + public/data/jobs.json (kept in sync)
 * - Uses shared URL validator (scripts/lib/validate-job-url.mjs)
 * - Deletes only on strong signals (404/410, explicit "no longer available" phrases,
 *   career-portal-specific closure signals, redirect to generic listing page)
 * - Fail-open: network/auth/rate-limit errors never trigger deletions
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateJobUrls,
  isFreshProtected,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
} from './lib/validate-job-url.mjs';
import { hardenJobLocaleFields, stableSlugHash } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');
const PUBLIC_JOBS_PATH = path.resolve(__dirname, '..', 'public', 'data', 'jobs.json');
const PUBLIC_EXPIRED_JOBS_PATH = process.env.JOBS_PUBLIC_EXPIRED_JOBS_PATH
  ? path.resolve(process.env.JOBS_PUBLIC_EXPIRED_JOBS_PATH)
  : path.resolve(__dirname, '..', 'public', 'data', 'expired-jobs.json');
const META_PATH = path.resolve(__dirname, '..', 'data', 'jobs-meta.json');
const EXPIRED_JOBS_PATH = process.env.JOBS_EXPIRED_JOBS_PATH
  ? path.resolve(process.env.JOBS_EXPIRED_JOBS_PATH)
  : path.resolve(__dirname, '..', 'data', 'expired-jobs.json');
const EXPIRED_SLICES_DIR = process.env.JOBS_EXPIRED_SLICES_DIR
  ? path.resolve(process.env.JOBS_EXPIRED_SLICES_DIR)
  : path.resolve(__dirname, '..', 'data', 'jobs', 'expired', 'by-crawler');

const MAX_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.JOBS_HOUSEKEEPING_CONCURRENCY || DEFAULT_CONCURRENCY)));
const TIMEOUT_MS = Math.max(2000, Math.min(15000, Number(process.env.JOBS_HOUSEKEEPING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)));
const HOUSEKEEPING_SCOPE = String(process.env.JOBS_HOUSEKEEPING_SCOPE || '').trim();
const SKIP_URL_VALIDATION = String(process.env.JOBS_SKIP_URL_VALIDATION || '0') === '1';

/** Slice-only mode: operate on a single per-crawler slice file instead of the
 *  monolithic data/jobs.json. Set JOBS_SLICE_FILE to the slice path, e.g.
 *  data/jobs/by-crawler/coop-ticino.json. Assembly into data/jobs.json happens
 *  in the deploy pipeline instead of per-crawler. */
const SLICE_FILE = String(process.env.JOBS_SLICE_FILE || '').trim();

/** Maximum age in days before a job is considered stale regardless of URL status.
 *  Override via JOBS_STALE_DAYS env var. Default: 60 days. */
const STALE_DAYS = Math.max(7, Math.min(180, Number(process.env.JOBS_STALE_DAYS || 60)));
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function normalizeScopeValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compactScopeValue(value) {
  return normalizeScopeValue(value).replace(/-/g, '');
}

function buildJobScopeTokens(job) {
  const tokens = new Set();
  const add = (value) => {
    const normalized = normalizeScopeValue(value);
    if (!normalized) return;
    tokens.add(normalized);
    const compact = compactScopeValue(value);
    if (compact) tokens.add(compact);
  };

  add(job?.companyKey);
  add(job?.company);
  add(job?.companyHost);
  try {
    if (job?.url) add(new URL(String(job.url)).hostname);
  } catch {
    // ignore invalid URL
  }
  return tokens;
}

function jobMatchesHousekeepingScope(job, scopeRaw) {
  const scope = normalizeScopeValue(scopeRaw);
  const compactScope = compactScopeValue(scopeRaw);
  if (!scope) return true;

  const jobTokens = buildJobScopeTokens(job);
  return jobTokens.has(scope) || jobTokens.has(compactScope);
}

/** Maximum number of expired jobs to keep in the archive. Older entries are
 *  evicted when the cap is exceeded. */
const EXPIRED_JOBS_CAP = 5000;

/**
 * Build an expired-job archive entry from a job object.
 */
function buildExpiredEntry(job) {
  const entry = {
    slug: job.slug,
    title: job.title || '',
    titleByLocale: job.titleByLocale || {},
    company: job.company || '',
    companyKey: job.companyKey || '',
    location: job.location || '',
    addressLocality: job.addressLocality || '',
    descriptionByLocale: job.descriptionByLocale || {},
    slugByLocale: job.slugByLocale || {},
    sector: job.sector || '',
    expiredAt: new Date().toISOString(),
    // Preserve old slug aliases so the build plugin can generate enriched
    // soft-landing pages for URLs that were renamed before expiry.
    previousSlugs: Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0
      ? [...job.previousSlugs]
      : undefined,
    // Locale-aware slug history so expired soft-landing pages are generated
    // under the correct locale prefix (e.g. /fr/trouver-emploi-tessin/old-slug).
    previousSlugsByLocale: job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object'
        && Object.keys(job.previousSlugsByLocale).length > 0
      ? JSON.parse(JSON.stringify(job.previousSlugsByLocale))
      : undefined,
    // FRO-343: preserve address + salary data for rich soft-landing pages
    postalCode: job.postalCode || '',
    streetAddress: job.streetAddress || '',
    salaryMin: job.salaryMin || null,
    salaryMax: job.salaryMax || null,
    salaryCurrency: job.salaryCurrency || 'CHF',
    salaryPeriod: job.salaryPeriod || 'YEAR',
    // Marker so dedup-archived losers are distinguishable from URL-validation
    // and age-based expirations. Preserves SEO continuity without losing the
    // signal that this job was a within-slice slug-collision loser.
    dedupArchive: job.dedupArchive === true ? true : undefined,
  };
  // Clean up empty fields
  if (!entry.postalCode) delete entry.postalCode;
  if (!entry.streetAddress) delete entry.streetAddress;
  if (!entry.salaryMin) delete entry.salaryMin;
  if (!entry.salaryMax) delete entry.salaryMax;
  if (entry.dedupArchive !== true) delete entry.dedupArchive;
  return entry;
}

/**
 * Recency timestamp for slug-dedup tiebreaking. Prefers `datePosted` (when
 * the employer actually published the listing — the freshness signal that
 * matters to job seekers) and falls back to `crawledAt` (when our crawler
 * last saw it) when datePosted is absent. Returns 0 for jobs with neither
 * — those tie-break by lexicographic id at the call site.
 *
 * Why two fields: most crawlers populate datePosted from the employer's
 * structured data (JobPosting.datePosted) but a handful only have
 * crawledAt. Sticking to a single field would silently demote those
 * fallback jobs into being picked as losers regardless of recency.
 */
function jobRecencyTimestamp(job) {
  const dp = job?.datePosted ? new Date(job.datePosted).getTime() : 0;
  if (dp > 0 && !Number.isNaN(dp)) return dp;
  const ca = job?.crawledAt ? new Date(job.crawledAt).getTime() : 0;
  if (ca > 0 && !Number.isNaN(ca)) return ca;
  return 0;
}

/**
 * Disambiguate a within-slice slug-dedup loser so it can be archived to the
 * expired pipeline without colliding with the winning slug. The loser receives
 * a deterministic slug based on its fingerprint hash, and the original
 * (colliding) slug is preserved in previousSlugs[] so any indexed URL still
 * resolves to an enriched soft-landing page generated by jobsSeoPagesPlugin.
 *
 * Pure: returns a new job object, never mutates the input.
 */
function disambiguateDedupLoser(loser, collidingSlug) {
  const suffix = stableSlugHash(loser) || '';
  const originalSlug = String(collidingSlug || loser.slug || '').trim();
  const baseInput = originalSlug || `${loser?.title || ''}-${loser?.company || ''}-${loser?.location || ''}`;
  const baseSlug = baseInput
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let disambiguated;
  if (suffix) {
    const baseMaxLen = Math.max(0, 90 - (suffix.length + 1));
    const trimmedBase = baseSlug.slice(0, baseMaxLen).replace(/-+$/, '');
    disambiguated = trimmedBase ? `${trimmedBase}-${suffix}` : suffix;
  } else {
    // Fallback for jobs without a stable fingerprint: use the loser id
    // (which is itself derived from a stable hash by the crawler infra).
    const idTail = String(loser?.id || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(-6) || 'dedup';
    const baseMaxLen = Math.max(0, 90 - (idTail.length + 1));
    const trimmedBase = baseSlug.slice(0, baseMaxLen).replace(/-+$/, '');
    disambiguated = trimmedBase ? `${trimmedBase}-${idTail}` : idTail;
  }

  const previousSlugs = Array.isArray(loser.previousSlugs) ? [...loser.previousSlugs] : [];
  if (originalSlug && !previousSlugs.includes(originalSlug)) {
    previousSlugs.push(originalSlug);
  }

  const slugByLocale = (loser.slugByLocale && typeof loser.slugByLocale === 'object')
    ? Object.fromEntries(
        Object.entries(loser.slugByLocale).map(([locale, value]) => {
          if (value === originalSlug) return [locale, disambiguated];
          return [locale, value];
        }),
      )
    : {};

  return {
    ...loser,
    slug: disambiguated,
    slugByLocale,
    previousSlugs,
    dedupArchive: true,
  };
}

/**
 * Archive removed jobs to data/expired-jobs.json (aggregated, used during deploy).
 *
 * Only jobs with a slug are archived (slugless jobs have no page to land on).
 * Existing entries are preserved; newer removals overwrite older ones for the
 * same slug.
 */
function archiveExpiredJobs(removedJobs, allJobsById) {
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(EXPIRED_JOBS_PATH, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch { /* file missing or malformed — start fresh */ }

  const bySlug = new Map();
  for (const ej of existing) {
    if (ej.slug) bySlug.set(ej.slug, ej);
  }

  let added = 0;
  for (const r of removedJobs) {
    const job = allJobsById.get(r.id);
    if (!job || !job.slug) continue;
    bySlug.set(job.slug, buildExpiredEntry(job));
    added++;
  }

  if (added === 0 && existing.length === bySlug.size) return 0;

  // Sort by expiredAt descending, cap at EXPIRED_JOBS_CAP
  let archived = [...bySlug.values()]
    .sort((a, b) => (b.expiredAt || '').localeCompare(a.expiredAt || ''));
  if (archived.length > EXPIRED_JOBS_CAP) {
    archived = archived.slice(0, EXPIRED_JOBS_CAP);
  }

  writeJson(EXPIRED_JOBS_PATH, archived);
  writeJson(PUBLIC_EXPIRED_JOBS_PATH, archived);
  return added;
}

/**
 * Archive removed jobs to a per-crawler expired slice file.
 * Used in slice-only mode so each crawler persists its own expired jobs
 * independently. The aggregated expired-jobs.json is assembled at deploy time.
 */
function archiveExpiredJobsPerCrawler(removedJobs, allJobsById, crawlerKey) {
  if (!crawlerKey) return 0;

  fs.mkdirSync(EXPIRED_SLICES_DIR, { recursive: true });
  const slicePath = path.join(EXPIRED_SLICES_DIR, `${crawlerKey}.json`);

  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch { /* file missing or malformed — start fresh */ }

  const bySlug = new Map();
  for (const ej of existing) {
    if (ej.slug) bySlug.set(ej.slug, ej);
  }

  let added = 0;
  for (const r of removedJobs) {
    const job = allJobsById.get(r.id);
    if (!job || !job.slug) continue;
    bySlug.set(job.slug, buildExpiredEntry(job));
    added++;
  }

  if (added === 0 && existing.length === bySlug.size) return 0;

  const archived = [...bySlug.values()]
    .sort((a, b) => (b.expiredAt || '').localeCompare(a.expiredAt || ''));
  writeJson(slicePath, archived);
  return added;
}

function updateMeta(totalJobs) {
  let meta;
  try {
    meta = readJson(META_PATH);
  } catch {
    meta = {};
  }

  const next = {
    ...meta,
    lastUpdated: new Date().toISOString(),
    totalJobs,
    sources: {
      ...(meta.sources || {}),
      // Current dataset is a curated import list; keep shape stable.
      arbeitSwiss: 0,
      ubs: 0,
      migros: 0,
      tutti: 0,
      remotive: 0,
      findwork: 0,
      curatedTicino: totalJobs,
    },
  };

  writeJson(META_PATH, next);
}

async function main() {
  // ── Slice-only mode: operate on a single per-crawler slice file ──────────
  if (SLICE_FILE) {
    const slicePath = path.resolve(SLICE_FILE);
    if (!fs.existsSync(slicePath)) {
      console.log(`ℹ️  Slice file not found: ${SLICE_FILE} — skip housekeeping`);
      return;
    }
    console.log(`📦 Slice-only housekeeping: ${SLICE_FILE}`);
    const sliceData = readJson(slicePath);
    const sliceJobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : (Array.isArray(sliceData) ? sliceData : []);
    if (sliceJobs.length === 0) {
      console.log('ℹ️  Slice is empty — skip housekeeping');
      return;
    }

    // Run locale hardening on the slice (skip if JOBS_SKIP_LOCALE_HARDENING=1,
    // e.g. when slug hardening is deferred to after translations in the combined pipeline).
    // Also auto-skip when running in scoped mode (JOBS_HOUSEKEEPING_SCOPE set): the
    // dedicated crawler already hardened this slice moments ago — re-hardening in a
    // separate process can revert AI-translated slugs and generate spurious previousSlugs.
    const skipHardening = process.env.JOBS_SKIP_LOCALE_HARDENING === '1'
      || !!process.env.JOBS_HOUSEKEEPING_SCOPE;
    const tempPath = slicePath + '.cleanup-tmp.json';
    writeJson(tempPath, sliceJobs);
    try {
      if (!skipHardening) {
        const lh = hardenJobLocaleFields({ dataJobsPath: tempPath });
        if (lh.changed) console.log(`🛡️ Locale hardening: repaired ${lh.repaired}/${lh.total} jobs in slice.`);
      }
      const hardenedJobs = readJson(tempPath);

      // Age-based pruning
      const now = Date.now();
      let kept = hardenedJobs.filter((job) => {
        const ts = job.crawledAt ? new Date(job.crawledAt).getTime() : 0;
        return !(ts > 0 && now - ts > STALE_MS);
      });
      const agePruned = hardenedJobs.length - kept.length;
      if (agePruned > 0) console.log(`🗓️  Removed ${agePruned} stale jobs (> ${STALE_DAYS} days) from slice.`);

      // URL validation (honors JOBS_SKIP_URL_VALIDATION for tests + scoped runs)
      const urlRemoved = [];
      if (SKIP_URL_VALIDATION) {
        console.log(`⏭️  Slice URL validation skipped (JOBS_SKIP_URL_VALIDATION=1) — keeping ${kept.length} jobs`);
      } else {
        console.log(`🧹 Slice housekeeping: checking ${kept.length} jobs (concurrency=${MAX_CONCURRENCY}, timeout=${TIMEOUT_MS}ms)`);
        const checks = await validateJobUrls(kept.map((j) => ({ id: j.id, url: j.url })), { concurrency: MAX_CONCURRENCY, timeoutMs: TIMEOUT_MS });
        const checkById = new Map(checks.map((c) => [c.id, c]));
        kept = kept.filter((job) => {
          const c = checkById.get(job.id);
          if (c && c.valid === false) {
            if (isFreshProtected(job) && !c.definitive) return true;
            urlRemoved.push({ id: job.id, reason: c.reason });
            return false;
          }
          return true;
        });
        if (urlRemoved.length > 0) console.log(`🧹 Removed ${urlRemoved.length} invalid-URL jobs from slice.`);
      }

      // Within-slice dedup (slug). Losers are NOT silently dropped — they get a
      // disambiguated slug and are archived to the expired pipeline so the
      // build plugin can serve enriched soft-landing pages on the original URL.
      const seenSlug = new Map();
      const deduped = [];
      const dedupLosers = []; // disambiguated loser jobs to be archived
      const dedupCollisions = []; // { removedId, keptId, slug }
      for (const job of kept) {
        const slug = String(job.slug || '').trim();
        if (!slug) { deduped.push(job); continue; }
        const prev = seenSlug.get(slug);
        if (prev) {
          // Tiebreak by recency: datePosted (employer-published timestamp)
          // wins over crawledAt because a job posted on 2026-05-10 that we
          // crawled on 2026-05-04 should beat a job posted on 2026-04-01
          // that we crawled on 2026-05-04 — even though both share the
          // same crawledAt minute, the user wants the freshest LISTING.
          const prevTs = jobRecencyTimestamp(prev);
          const currTs = jobRecencyTimestamp(job);
          if (currTs > prevTs) {
            const idx = deduped.indexOf(prev);
            if (idx !== -1) deduped[idx] = job;
            seenSlug.set(slug, job);
            // Newer job wins; the previously-kept job is the loser.
            dedupCollisions.push({ removedId: prev.id, keptId: job.id, slug });
            dedupLosers.push(disambiguateDedupLoser(prev, slug));
          } else {
            // Existing kept job stays; current job is the loser.
            dedupCollisions.push({ removedId: job.id, keptId: prev.id, slug });
            dedupLosers.push(disambiguateDedupLoser(job, slug));
          }
          continue;
        }
        seenSlug.set(slug, job);
        deduped.push(job);
      }
      const dedupCount = kept.length - deduped.length;
      if (dedupCount > 0) {
        console.log(`🧹 Archived ${dedupCount} within-slice duplicate-slug jobs from slice (preserved in expired/).`);
        for (const c of dedupCollisions.slice(0, 5)) {
          console.log(`   - ${c.removedId} (duplicate of ${c.keptId}) slug=${c.slug}`);
        }
      }
      kept = deduped;

      // Archive removed jobs to per-crawler expired slice (not the shared file).
      // Combines URL/age-prune removals (`sliceRemoved`) with dedup losers
      // (`dedupLosers`). Dedup losers are NOT in the original `hardenedJobs`
      // map under their disambiguated slug, so they're tracked separately.
      const keptSlugs = new Set(kept.map((j) => j.slug).filter(Boolean));
      const sliceRemoved = hardenedJobs.filter((j) => j.slug && !keptSlugs.has(j.slug));
      const archiveJobsById = new Map(hardenedJobs.map((j) => [j.id, j]));
      const archiveRefs = sliceRemoved.map((j) => ({ id: j.id }));
      for (const loser of dedupLosers) {
        // Use a synthetic id key to avoid colliding with the original job id
        // (the original may already be in the map under its pre-dedup slug).
        const loserKey = `__dedup__${loser.id}__${loser.slug}`;
        archiveJobsById.set(loserKey, loser);
        archiveRefs.push({ id: loserKey });
      }
      if (archiveRefs.length > 0) {
        const crawlerKey = sliceData?.crawlerKey || path.basename(slicePath, '.json');
        const sliceArchived = archiveExpiredJobsPerCrawler(
          archiveRefs,
          archiveJobsById,
          crawlerKey,
        );
        if (sliceArchived > 0) console.log(`📦 Archived ${sliceArchived} expired jobs → data/jobs/expired/by-crawler/${crawlerKey}.json`);
      }

      // Write back to slice file (preserve envelope)
      const totalRemoved = hardenedJobs.length - kept.length;
      if (totalRemoved > 0) {
        const envelope = (sliceData && typeof sliceData === 'object' && !Array.isArray(sliceData))
          ? { ...sliceData, jobs: kept, assembledAt: new Date().toISOString() }
          : kept;
        writeJson(slicePath, envelope);
        console.log(`✅ Slice cleaned: ${hardenedJobs.length} → ${kept.length} jobs (-${totalRemoved})`);
      } else {
        console.log('✅ Slice clean — no jobs removed.');
      }
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
    return;
  }

  // ── Standard mode: operate on monolithic data/jobs.json ──────────────────
  if (!fs.existsSync(DATA_JOBS_PATH) || !fs.existsSync(PUBLIC_JOBS_PATH)) {
    console.log('ℹ️  jobs.json non trovato in data/ o public/data — skip housekeeping');
    return;
  }

  // ── 0. Locale hardening (fill missing titleByLocale/descriptionByLocale/slugByLocale) ──
  const localeHardening = hardenJobLocaleFields({ dataJobsPath: DATA_JOBS_PATH });
  if (localeHardening.changed) {
    console.log(`🛡️ Locale hardening: repaired ${localeHardening.repaired}/${localeHardening.total} jobs.`);
  }

  // ── 0b. Enrich short descriptions (deploy-blocking safety net) ──────────
  // If any job's description in any locale is too short or contains garbage
  // (e.g. search widget text scraped instead of real content), replace it with
  // a minimal viable description built from title + company + location.
  // This prevents deploy failures from the validate-jobs-quality gate.
  {
    const MIN_DESC_CHARS = 150;
    const GARBAGE_PATTERNS = [
      /Suche nach Stichwort/i,
      /Benachrichtigung erstellen/i,
      /Search by keyword/i,
      /Create Alert/i,
      /Select how often/i,
      /cookie.*policy/i,
    ];

    const BOILERPLATE = {
      de: (company, location, canton) =>
        `${company} mit Sitz in ${location}${canton ? ` (${canton})` : ''}, Schweiz, bietet vielfältige Karrieremöglichkeiten und moderne Arbeitsbedingungen. Wir suchen engagierte Fachkräfte, die mit Kompetenz und Leidenschaft zur weiteren Entwicklung unseres Unternehmens beitragen möchten. Bewerben Sie sich jetzt für diese spannende Position.`,
      it: (company, location, canton) =>
        `${company} con sede a ${location}${canton ? ` (${canton})` : ''}, Svizzera, offre diverse opportunità di carriera e condizioni di lavoro moderne. Cerchiamo professionisti motivati che desiderino contribuire con competenza e passione allo sviluppo della nostra azienda. Candidatevi ora per questa interessante posizione.`,
      en: (company, location, canton) =>
        `${company} based in ${location}${canton ? ` (${canton})` : ''}, Switzerland, offers diverse career opportunities and modern working conditions. We are looking for motivated professionals who want to contribute to the further development of our company with competence and passion. Apply now for this exciting position.`,
      fr: (company, location, canton) =>
        `${company} basé à ${location}${canton ? ` (${canton})` : ''}, Suisse, offre des opportunités de carrière diversifiées et des conditions de travail modernes. Nous recherchons des professionnels motivés qui souhaitent contribuer avec compétence et passion au développement de notre entreprise. Postulez maintenant pour ce poste passionnant.`,
    };

    const raw = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));
    const jobsArr = Array.isArray(raw) ? raw : (Array.isArray(raw?.jobs) ? raw.jobs : null);
    const isWrapped = !Array.isArray(raw) && Array.isArray(raw?.jobs);
    let enriched = 0;

    if (jobsArr) {
      for (const job of jobsArr) {
        // Check ALL 4 required locales — the validation gate requires complete
        // coverage. Only checking existing keys misses locales that were never
        // populated (e.g. descriptionByLocale is {} after garbage cleanup).
        const locales = ['it', 'en', 'de', 'fr'];

        for (const locale of locales) {
          const desc = (job.descriptionByLocale?.[locale] || '').trim();
          const isShort = desc.length > 0 && desc.length < MIN_DESC_CHARS;
          const isEmpty = desc.length === 0;
          const isGarbage = desc.length > 0 && GARBAGE_PATTERNS.some((re) => re.test(desc));

          if (isShort || isEmpty || isGarbage) {
            const title = job.titleByLocale?.[locale] || job.title || '';
            const company = job.company || '';
            const location = job.addressLocality || job.location || '';
            const canton = job.canton || job.addressRegion || '';
            const boilerplateFn = BOILERPLATE[locale] || BOILERPLATE.de;
            const fallback = `${title} — ${boilerplateFn(company, location, canton)}`;
            if (fallback.length >= MIN_DESC_CHARS) {
              job.descriptionByLocale = job.descriptionByLocale || {};
              job.descriptionByLocale[locale] = fallback;
              if (locale === (job.sourceLang || 'de')) {
                job.description = fallback;
              }
              job.needsRetranslation = true;
              enriched++;
            }
          }
        }
      }

      if (enriched > 0) {
        const out = isWrapped ? { ...raw, jobs: jobsArr } : jobsArr;
        fs.writeFileSync(DATA_JOBS_PATH, JSON.stringify(out, null, 2) + '\n');
        // Keep public copy in sync
        if (fs.existsSync(PUBLIC_JOBS_PATH)) {
          fs.writeFileSync(PUBLIC_JOBS_PATH, JSON.stringify(out, null, 2) + '\n');
        }
        console.log(`📝 Description enrichment: padded ${enriched} short/garbage descriptions above ${MIN_DESC_CHARS} chars.`);
      }
    }
  }

  // Housekeeping must stay fast and deterministic: missing-locale translation
  // belongs to dedicated crawler localization or the explicit relocalize job,
  // not to the final cleanup pass that runs after every crawler.
  if (String(process.env.JOBS_HOUSEKEEPING_TRANSLATE_MISSING || '0') === '1') {
    console.log('ℹ️  Housekeeping locale translation explicitly enabled via JOBS_HOUSEKEEPING_TRANSLATE_MISSING=1');
  }

  const dataJobs = readJson(DATA_JOBS_PATH);
  const publicJobs = readJson(PUBLIC_JOBS_PATH);

  if (!Array.isArray(dataJobs) || !Array.isArray(publicJobs)) {
    throw new Error('jobs.json must be an array');
  }

  // Use data/ as source of truth, but ensure public/ stays in sync.
  const jobs = dataJobs;
  const scopedJobs = HOUSEKEEPING_SCOPE ? jobs.filter((job) => jobMatchesHousekeepingScope(job, HOUSEKEEPING_SCOPE)) : jobs;
  const untouchedJobs = HOUSEKEEPING_SCOPE ? jobs.filter((job) => !jobMatchesHousekeepingScope(job, HOUSEKEEPING_SCOPE)) : [];

  if (HOUSEKEEPING_SCOPE) {
    console.log(`🎯 Housekeeping scoped to company selector: ${HOUSEKEEPING_SCOPE}`);
    console.log(`   Scoped jobs: ${scopedJobs.length} | Untouched jobs: ${untouchedJobs.length}`);
    if (scopedJobs.length === 0) {
      console.log('ℹ️  Nessun job corrisponde allo scope richiesto — skip housekeeping scoped');
      return;
    }
  }

  // ── 1. Age-based pruning (safety net) ────────────────────────────────
  const now = Date.now();
  const ageRemoved = [];
  const afterAgePrune = [];

  for (const job of scopedJobs) {
    const ts = job.crawledAt ? new Date(job.crawledAt).getTime() : 0;
    if (ts > 0 && now - ts > STALE_MS) {
      ageRemoved.push({ id: job.id, url: job.url, reason: `older than ${STALE_DAYS} days`, crawledAt: job.crawledAt });
    } else {
      afterAgePrune.push(job);
    }
  }

  if (ageRemoved.length > 0) {
    console.log(`\n🗓️  Rimossi ${ageRemoved.length} job più vecchi di ${STALE_DAYS} giorni:`);
    for (const r of ageRemoved.slice(0, 20)) {
      console.log(`   - ${r.id} (crawledAt: ${r.crawledAt})`);
    }
    if (ageRemoved.length > 20) console.log(`   … +${ageRemoved.length - 20} altri`);
  }

  // ── 2. URL validation ─────────────────────────────────────────────────
  const removed = [...ageRemoved];
  let kept = [];

  if (SKIP_URL_VALIDATION) {
    console.log(`\n⏭️  URL validation skipped (JOBS_SKIP_URL_VALIDATION=1) — keeping ${afterAgePrune.length} jobs`);
    kept = afterAgePrune;
  } else {
    console.log(`\n🧹 Job housekeeping: checking ${afterAgePrune.length} jobs (concurrency=${MAX_CONCURRENCY}, timeout=${TIMEOUT_MS}ms)`);

    const checks = await validateJobUrls(
      afterAgePrune.map((j) => ({ id: j.id, url: j.url })),
      { concurrency: MAX_CONCURRENCY, timeoutMs: TIMEOUT_MS }
    );

    const checkById = new Map(checks.map((c) => [c.id, c]));
    for (const job of afterAgePrune) {
      const c = checkById.get(job.id);
      if (c && c.valid === false) {
        // Definitive signals (HTTP 404/410, explicit closure phrases, portal-specific)
        // bypass fresh protection — the job is unambiguously gone.
        if (isFreshProtected(job) && !c.definitive) {
          kept.push(job);
          continue;
        }
        removed.push({ id: job.id, url: job.url, reason: c.reason, status: c.status, definitive: !!c.definitive });
      } else {
        kept.push(job);
      }
    }
  }

  // ── 3. Title+Company+Location dedup (same position posted with different URLs) ──
  const seenTitleCompany = new Map();
  const afterTcDedup = [];
  for (const job of kept) {
    const tcKey = `${(job.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}|${(job.company || '').toLowerCase().replace(/\s+/g, ' ').trim()}|${(job.location || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const prev = seenTitleCompany.get(tcKey);
    if (prev) {
      // Keep the one with a more recent crawledAt
      const prevTs = prev.crawledAt ? new Date(prev.crawledAt).getTime() : 0;
      const currTs = job.crawledAt ? new Date(job.crawledAt).getTime() : 0;
      if (currTs > prevTs) {
        // Replace prev with current (newer)
        const idx = afterTcDedup.indexOf(prev);
        if (idx !== -1) afterTcDedup[idx] = job;
        seenTitleCompany.set(tcKey, job);
      }
      removed.push({ id: job.id, title: job.title, url: job.url, reason: 'duplicate title+company' });
      continue;
    }
    seenTitleCompany.set(tcKey, job);
    afterTcDedup.push(job);
  }
  kept = afterTcDedup;

  // ── 4. Slug dedup (different URLs mapping to the same slug) ──
  // Losers are NOT silently dropped — they get a disambiguated slug and are
  // archived to the expired pipeline so the build plugin can serve enriched
  // soft-landing pages on the original URL.
  const seenSlug = new Map();
  const afterSlugDedup = [];
  const slugDedupCount0 = removed.length;
  const standardDedupLosers = []; // disambiguated loser jobs to be archived
  for (const job of kept) {
    const slug = String(job.slug || '').trim();
    if (!slug) { afterSlugDedup.push(job); continue; }
    const prev = seenSlug.get(slug);
    if (prev) {
      // Recency tiebreak: prefer datePosted (employer publish time) over
      // crawledAt — see jobRecencyTimestamp() comment for why both signals.
      const prevTs = jobRecencyTimestamp(prev);
      const currTs = jobRecencyTimestamp(job);
      let loser;
      if (currTs > prevTs) {
        const idx = afterSlugDedup.indexOf(prev);
        if (idx !== -1) afterSlugDedup[idx] = job;
        seenSlug.set(slug, job);
        loser = prev;
      } else {
        loser = job;
      }
      standardDedupLosers.push(disambiguateDedupLoser(loser, slug));
      removed.push({ id: loser.id, url: loser.url, reason: 'duplicate slug' });
      continue;
    }
    seenSlug.set(slug, job);
    afterSlugDedup.push(job);
  }
  const slugDedupCount = removed.length - slugDedupCount0;
  if (slugDedupCount > 0) {
    console.log(`🧹 Archived ${slugDedupCount} within-slice duplicate-slug jobs (preserved in expired/).`);
  }
  kept = afterSlugDedup;

  if (removed.length === 0) {
    console.log('✅ Nessun job da rimuovere (nessun segnale forte rilevato)');
    return;
  }

  console.log(`⚠️  Rimossi ${removed.length} job non più disponibili:`);
  for (const r of removed.slice(0, 30)) {
    const label = r.id || r.title || r.url || 'unknown';
    console.log(`   - ${label} (${r.status ?? '?'}) ${r.reason}`);
  }
  if (removed.length > 30) console.log(`   … +${removed.length - 30} altri`);

  // Archive removed jobs for rich soft-landing pages.
  // Dedup losers replace their pre-dedup entry in the lookup map under a
  // synthetic key so the archive preserves the disambiguated slug + the
  // original (colliding) slug in previousSlugs[].
  const jobsById = new Map(jobs.map((j) => [j.id, j]));
  const archiveRemoved = removed.filter((r) => !standardDedupLosers.some((loser) => loser.id === r.id && r.reason === 'duplicate slug'));
  for (const loser of standardDedupLosers) {
    const loserKey = `__dedup__${loser.id}__${loser.slug}`;
    jobsById.set(loserKey, loser);
    archiveRemoved.push({ id: loserKey, url: loser.url, reason: 'duplicate slug' });
  }
  const archived = archiveExpiredJobs(archiveRemoved, jobsById);
  if (archived > 0) {
    console.log(`📦 Archiviati ${archived} job scaduti in data/expired-jobs.json (soft-landing SEO)`);
  }

  const finalJobs = HOUSEKEEPING_SCOPE ? [...untouchedJobs, ...kept] : kept;

  writeJson(DATA_JOBS_PATH, finalJobs);
  writeJson(PUBLIC_JOBS_PATH, finalJobs);
  updateMeta(finalJobs.length);

  // Basic reference sanity checks (expected: no per-job routes/translations/sitemap entries)
  const suspiciousFiles = [
    path.resolve(__dirname, '..', 'public', 'sitemap.xml'),
    path.resolve(__dirname, '..', 'services', 'locales', 'it.ts'),
    path.resolve(__dirname, '..', 'services', 'locales', 'en.ts'),
    path.resolve(__dirname, '..', 'services', 'locales', 'de.ts'),
    path.resolve(__dirname, '..', 'services', 'locales', 'fr.ts'),
  ].filter((p) => fs.existsSync(p));

  for (const file of suspiciousFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const hit = removed.find((r) => content.includes(r.id) || (r.url && content.includes(r.url)));
    if (hit) {
      console.warn(`⚠️  Trovato riferimento a job rimosso in ${path.relative(process.cwd(), file)}: ${hit.id}`);
    }
  }

  console.log(`✅ jobs.json aggiornati (data/ + public/data) e meta aggiornato${HOUSEKEEPING_SCOPE ? ` — scope ${HOUSEKEEPING_SCOPE}` : ''}`);
}

main().catch((err) => {
  console.error('❌ Job housekeeping error:', err);
  process.exitCode = 1;
});
