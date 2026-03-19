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
import { hardenJobLocaleFields } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');
const PUBLIC_JOBS_PATH = path.resolve(__dirname, '..', 'public', 'data', 'jobs.json');
const META_PATH = path.resolve(__dirname, '..', 'data', 'jobs-meta.json');

const MAX_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.JOBS_HOUSEKEEPING_CONCURRENCY || DEFAULT_CONCURRENCY)));
const TIMEOUT_MS = Math.max(2000, Math.min(15000, Number(process.env.JOBS_HOUSEKEEPING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)));
const HOUSEKEEPING_SCOPE = String(process.env.JOBS_HOUSEKEEPING_SCOPE || '').trim();

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
      adzuna: 0,
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

    // Run locale hardening on the slice
    const tempPath = slicePath + '.cleanup-tmp.json';
    writeJson(tempPath, sliceJobs);
    try {
      const lh = hardenJobLocaleFields({ dataJobsPath: tempPath });
      if (lh.changed) console.log(`🛡️ Locale hardening: repaired ${lh.repaired}/${lh.total} jobs in slice.`);
      const hardenedJobs = readJson(tempPath);

      // Age-based pruning
      const now = Date.now();
      let kept = hardenedJobs.filter((job) => {
        const ts = job.crawledAt ? new Date(job.crawledAt).getTime() : 0;
        return !(ts > 0 && now - ts > STALE_MS);
      });
      const agePruned = hardenedJobs.length - kept.length;
      if (agePruned > 0) console.log(`🗓️  Removed ${agePruned} stale jobs (> ${STALE_DAYS} days) from slice.`);

      // URL validation
      console.log(`🧹 Slice housekeeping: checking ${kept.length} jobs (concurrency=${MAX_CONCURRENCY}, timeout=${TIMEOUT_MS}ms)`);
      const checks = await validateJobUrls(kept.map((j) => ({ id: j.id, url: j.url })), { concurrency: MAX_CONCURRENCY, timeoutMs: TIMEOUT_MS });
      const checkById = new Map(checks.map((c) => [c.id, c]));
      const urlRemoved = [];
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

      // Within-slice dedup (slug)
      const seenSlug = new Map();
      const deduped = [];
      for (const job of kept) {
        const slug = String(job.slug || '').trim();
        if (!slug) { deduped.push(job); continue; }
        const prev = seenSlug.get(slug);
        if (prev) {
          const prevTs = prev.crawledAt ? new Date(prev.crawledAt).getTime() : 0;
          const currTs = job.crawledAt ? new Date(job.crawledAt).getTime() : 0;
          if (currTs > prevTs) {
            const idx = deduped.indexOf(prev);
            if (idx !== -1) deduped[idx] = job;
            seenSlug.set(slug, job);
          }
          continue;
        }
        seenSlug.set(slug, job);
        deduped.push(job);
      }
      kept = deduped;

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
  console.log(`\n🧹 Job housekeeping: checking ${afterAgePrune.length} jobs (concurrency=${MAX_CONCURRENCY}, timeout=${TIMEOUT_MS}ms)`);

  const checks = await validateJobUrls(
    afterAgePrune.map((j) => ({ id: j.id, url: j.url })),
    { concurrency: MAX_CONCURRENCY, timeoutMs: TIMEOUT_MS }
  );

  const removed = [...ageRemoved];
  let kept = [];

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
      removed.push({ id: job.id, url: job.url, reason: 'duplicate title+company' });
      continue;
    }
    seenTitleCompany.set(tcKey, job);
    afterTcDedup.push(job);
  }
  kept = afterTcDedup;

  // ── 4. Slug dedup (different URLs mapping to the same slug) ──
  const seenSlug = new Map();
  const afterSlugDedup = [];
  for (const job of kept) {
    const slug = String(job.slug || '').trim();
    if (!slug) { afterSlugDedup.push(job); continue; }
    const prev = seenSlug.get(slug);
    if (prev) {
      const prevTs = prev.crawledAt ? new Date(prev.crawledAt).getTime() : 0;
      const currTs = job.crawledAt ? new Date(job.crawledAt).getTime() : 0;
      if (currTs > prevTs) {
        const idx = afterSlugDedup.indexOf(prev);
        if (idx !== -1) afterSlugDedup[idx] = job;
        seenSlug.set(slug, job);
      }
      removed.push({ id: job.id, url: job.url, reason: 'duplicate slug' });
      continue;
    }
    seenSlug.set(slug, job);
    afterSlugDedup.push(job);
  }
  kept = afterSlugDedup;

  if (removed.length === 0) {
    console.log('✅ Nessun job da rimuovere (nessun segnale forte rilevato)');
    return;
  }

  console.log(`⚠️  Rimossi ${removed.length} job non più disponibili:`);
  for (const r of removed.slice(0, 30)) {
    console.log(`   - ${r.id} (${r.status ?? '?'}) ${r.reason}`);
  }
  if (removed.length > 30) console.log(`   … +${removed.length - 30} altri`);

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
