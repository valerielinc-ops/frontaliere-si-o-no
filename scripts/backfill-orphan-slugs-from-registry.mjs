#!/usr/bin/env node
/**
 * backfill-orphan-slugs-from-registry.mjs
 *
 * Reconciles "orphan" slugs registered in `data/all-known-job-slugs.json` but
 * not owned by any current job (i.e. not in any `slug`, `slugByLocale`,
 * `previousSlugs`, or `previousSlugsByLocale`).
 *
 * Many of these orphans come from rename-drift cases where a vendor moved a
 * job between cities or cantons across crawler runs, before the stable-id
 * matchKey fix (PR #161 / 2026-05-13) was in place. The old slug stays
 * registered in the cathedral frozen-URL registry but the current job record
 * no longer references it — so the bridge page emitter doesn't link them.
 * Result: the SPA shows JobOrphanView for the old URL even though the job is
 * still live under a new slug.
 *
 * This script:
 *   1. Computes the set of orphan slugs (registered but unowned).
 *   2. For each orphan, finds the best-matching current job using
 *      title-only Jaccard similarity (company + location tokens subtracted as
 *      noise — same algorithm as `slugMatchesTitle`).
 *   3. Requires the job's company-token to appear in the orphan slug as a
 *      sanity check before assigning.
 *   4. If the best score >= THRESHOLD, adds the orphan slug to the matched
 *      job's `previousSlugs` and (if a locale is inferable) the appropriate
 *      `previousSlugsByLocale` bucket.
 *
 * Usage:
 *   node scripts/backfill-orphan-slugs-from-registry.mjs --dry-run
 *   node scripts/backfill-orphan-slugs-from-registry.mjs --apply
 *
 * Flags:
 *   --threshold N   Jaccard cutoff (default 0.7).
 *   --max N         Cap per-job previousSlugs growth (default 30).
 *   --apply         Persist changes. Without it, only summary is printed.
 *
 * Idempotent: a slug already present in a job's previousSlugs/previousSlugsByLocale
 * is skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slugify,
  slugTokenSet,
} from './lib/regenerate-slugs-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');
const REGISTRY_PATH = path.resolve(ROOT, 'data', 'all-known-job-slugs.json');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const thresholdIdx = args.indexOf('--threshold');
const THRESHOLD = thresholdIdx !== -1 ? parseFloat(args[thresholdIdx + 1]) || 0.7 : 0.7;
const maxIdx = args.indexOf('--max');
const MAX_PER_JOB = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) || 30 : 30;
const verbose = args.includes('--verbose');

const LOCALES = ['it', 'en', 'de', 'fr'];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, v) {
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
}

/**
 * Infer locale of a slug by majority-locale of token suffixes.
 * Heuristic: known IT/EN/DE/FR markers. Defaults to 'it'.
 */
function inferOrphanLocale(slug, registryRecord) {
  if (!registryRecord || typeof registryRecord !== 'object') return null;
  for (const loc of LOCALES) {
    const v = registryRecord[loc];
    if (typeof v === 'string' && v.includes(slug)) return loc;
  }
  return null;
}

function noiseTokensFor(company, location) {
  const out = new Set();
  for (const text of [company, location]) {
    for (const t of slugTokenSet(slugify(text))) out.add(t);
  }
  return out;
}

function titleOnlyTokens(slug, noise) {
  const out = new Set();
  for (const t of slugTokenSet(slug)) if (!noise.has(t)) out.add(t);
  return out;
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function buildOwnedSet(allJobs) {
  const owned = new Set();
  for (const job of allJobs) {
    if (job.slug) owned.add(job.slug);
    if (job.slugByLocale) {
      for (const s of Object.values(job.slugByLocale)) if (s) owned.add(s);
    }
    if (Array.isArray(job.previousSlugs)) {
      for (const s of job.previousSlugs) if (s) owned.add(s);
    }
    if (job.previousSlugsByLocale) {
      for (const arr of Object.values(job.previousSlugsByLocale)) {
        if (Array.isArray(arr)) for (const s of arr) if (s) owned.add(s);
      }
    }
  }
  return owned;
}

function loadAllJobs() {
  const files = fs.readdirSync(BY_CRAWLER_DIR).filter((f) => f.endsWith('.json'));
  const byFile = new Map();
  const allJobs = [];
  for (const f of files) {
    const fp = path.join(BY_CRAWLER_DIR, f);
    const data = readJson(fp);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    byFile.set(f, { fp, data, jobs });
    for (const j of jobs) allJobs.push({ file: f, job: j });
  }
  return { byFile, allJobs };
}

function indexJobsByCompanyTokens(allJobs) {
  // Map<companyToken, Array<{file, job, companyTokens, titleTokens, location}>>
  const index = new Map();
  for (const { file, job } of allJobs) {
    const company = String(job.company || '');
    if (!company) continue;
    const companyTokens = slugTokenSet(slugify(company));
    if (companyTokens.size === 0) continue;
    const location = String(job.location || '');
    const noise = noiseTokensFor(company, location);
    const title = String(job.title || '');
    const titleTokens = titleOnlyTokens(slugify(title), noise);
    const entry = { file, job, companyTokens, titleTokens, location, noise };
    for (const tok of companyTokens) {
      let arr = index.get(tok);
      if (!arr) {
        arr = [];
        index.set(tok, arr);
      }
      arr.push(entry);
    }
  }
  return index;
}

function findBestMatch(orphanSlug, companyIndex) {
  const orphanTokens = slugTokenSet(orphanSlug);
  if (orphanTokens.size === 0) return null;
  // Collect candidate jobs: any job whose ALL company-tokens are present in the orphan.
  const candidateSet = new Set();
  for (const tok of orphanTokens) {
    const arr = companyIndex.get(tok);
    if (!arr) continue;
    for (const entry of arr) {
      // Sanity: all company tokens of this entry must appear in the orphan.
      let allPresent = true;
      for (const ct of entry.companyTokens) {
        if (!orphanTokens.has(ct)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) candidateSet.add(entry);
    }
  }
  if (candidateSet.size === 0) return null;
  // Score by title-only Jaccard.
  let best = null;
  for (const entry of candidateSet) {
    const orphanTitleTokens = titleOnlyTokens(orphanSlug, entry.noise);
    const score = jaccard(orphanTitleTokens, entry.titleTokens);
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

async function main() {
  console.log(`🔧 backfill-orphan-slugs-from-registry — ${APPLY ? 'APPLY' : 'DRY RUN'} (threshold=${THRESHOLD}, max=${MAX_PER_JOB}/job)`);

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`❌ Registry not found: ${REGISTRY_PATH}`);
    process.exit(1);
  }
  const registry = readJson(REGISTRY_PATH);
  const registryKeys = Object.keys(registry);
  console.log(`📋 Registry slugs: ${registryKeys.length}`);

  const { byFile, allJobs } = loadAllJobs();
  console.log(`📁 Current jobs: ${allJobs.length} across ${byFile.size} files`);

  const owned = buildOwnedSet(allJobs.map((x) => x.job));
  console.log(`✅ Slugs owned by current jobs: ${owned.size}`);

  const orphans = registryKeys.filter((k) => !owned.has(k));
  console.log(`👻 Orphan slugs (registered but unowned): ${orphans.length}`);

  const companyIndex = indexJobsByCompanyTokens(allJobs);
  console.log(`🏢 Companies indexed: ${companyIndex.size} unique company tokens`);

  let matched = 0;
  let belowThreshold = 0;
  let noCandidate = 0;
  const perFileMutations = new Map(); // file → Set<jobIndex>
  const sample = [];

  for (const orphan of orphans) {
    const best = findBestMatch(orphan, companyIndex);
    if (!best) {
      noCandidate++;
      continue;
    }
    if (best.score < THRESHOLD) {
      belowThreshold++;
      continue;
    }
    matched++;
    const { entry } = best;
    const job = entry.job;
    // Add to previousSlugs (flat) — dedupe.
    if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
    if (!job.previousSlugs.includes(orphan) && job.previousSlugs.length < MAX_PER_JOB) {
      job.previousSlugs.push(orphan);
    }
    // Infer locale via registry record (e.g. record.it points to /cerca-lavoro-…/<orphan>).
    const loc = inferOrphanLocale(orphan, registry[orphan]);
    if (loc) {
      if (!job.previousSlugsByLocale || typeof job.previousSlugsByLocale !== 'object') {
        job.previousSlugsByLocale = {};
      }
      if (!Array.isArray(job.previousSlugsByLocale[loc])) job.previousSlugsByLocale[loc] = [];
      const bucket = job.previousSlugsByLocale[loc];
      if (!bucket.includes(orphan) && bucket.length < MAX_PER_JOB) {
        bucket.push(orphan);
      }
    }
    let set = perFileMutations.get(entry.file);
    if (!set) {
      set = new Set();
      perFileMutations.set(entry.file, set);
    }
    set.add(job);
    if (sample.length < 15) {
      sample.push({ orphan, target: job.slug, score: best.score.toFixed(3), locale: loc || '?' });
    }
    if (verbose) {
      console.log(`  ✓ ${orphan} → ${job.slug} (score=${best.score.toFixed(3)}, locale=${loc || '?'})`);
    }
  }

  console.log('');
  console.log(`📊 Results:`);
  console.log(`   matched (>=${THRESHOLD}):     ${matched}`);
  console.log(`   below threshold:    ${belowThreshold}`);
  console.log(`   no company candidate: ${noCandidate}`);
  console.log(`   files affected:     ${perFileMutations.size}`);
  console.log('');
  if (sample.length) {
    console.log('🔍 Sample matches:');
    for (const s of sample) {
      console.log(`   ${s.orphan}`);
      console.log(`     → ${s.target} (score=${s.score}, locale=${s.locale})`);
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('💡 Dry run. Re-run with --apply to persist.');
    return;
  }

  // Persist mutated per-crawler files.
  let writes = 0;
  for (const [file, jobsSet] of perFileMutations) {
    const meta = byFile.get(file);
    writeJson(meta.fp, meta.data);
    writes++;
    if (verbose) console.log(`💾 wrote ${file} (${jobsSet.size} jobs touched)`);
  }
  console.log(`✅ Persisted ${writes} files.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
