#!/usr/bin/env node
/**
 * prune-known-slugs.mjs
 *
 * Trim `data/all-known-job-slugs.json` to keep build artifacts under the
 * GitHub Pages size limit. Performs two passes:
 *
 * 1. ACTIVE/EXPIRED DEDUP (Task C from incident 2026-05-21):
 *    Remove tracking entries whose slug (or any locale slug variant)
 *    matches an actively-listed job. After the 92-slice recovery, many
 *    employers came back to active state but their tracking entries
 *    remained as "expired", triggering soft-landing pages that compete
 *    with the live job pages.
 *
 * 2. TAIL CAP (Task B):
 *    Cap the remaining tracking entries to PRUNE_KNOWN_SLUGS_CAP (default
 *    20_000). Entries are ranked by GSC value when available
 *    (`data/orphan-enriched-data.json` → totalImpressions DESC) and the
 *    tail is dropped. Removed entries lose their soft-landing pages —
 *    they fall back to the SPA 404 → search redirect.
 *
 * Idempotent. Re-runs without flag stay no-op when nothing exceeds cap.
 * Honors CLAUDE.md #1: cap is only EVER raised manually, never silently
 * lowered. Default cap was chosen to bring the artifact under 1.86 GiB.
 *
 * Usage:
 *   node scripts/prune-known-slugs.mjs              # apply
 *   node scripts/prune-known-slugs.mjs --dry-run    # report only
 *   PRUNE_KNOWN_SLUGS_CAP=15000 node scripts/prune-known-slugs.mjs
 *   MAX_PREVIOUS_SLUGS_PER_JOB=3 node scripts/prune-known-slugs.mjs
 *
 * Pass 3 (previousSlugs traffic-aware trim):
 *   Each active job's `previousSlugs` + `previousSlugsByLocale[locale]` arrays
 *   feed jobsSeoPagesPlugin's full-content bridge emission — up to ~8 pages
 *   per old slug (4 locales × canton-aware + legacy-TI). 97 jobs had ≥10
 *   previousSlugs after the 2026-05-21 recovery, producing 32k extra pages.
 *
 *   Trim rule (user-stated, 2026-05-21):
 *     1. Keep ALL old slugs with GSC impressions > 0 (no upper limit).
 *        These are the slugs Google has actually indexed; dropping them
 *        loses real SEO equity.
 *     2. If NONE of a job's old slugs has impressions > 0 (entire history
 *        is "dark" — vendor-API churn, never indexed), fallback to the
 *        MOST RECENT N (`MAX_PREVIOUS_SLUGS_PER_JOB`, default 3).
 *
 *   GSC data sourced from `data/orphan-enriched-data.json` (1.7k entries
 *   today; refreshed by `sync-gsc-orphans.yml`). Slugs absent from the
 *   enrichment file are treated as 0 impressions (worst-case).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const TRACKING_PATH = path.resolve("data/all-known-job-slugs.json");
const ACTIVE_JOBS_PATH = path.resolve("data/jobs.json");
const GSC_ENRICHED_PATH = path.resolve("data/orphan-enriched-data.json");
const DEFAULT_CAP = 20_000;
const DEFAULT_MAX_PSL_PER_JOB = 3;

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function collectActiveSlugs(activeJobs) {
  const arr = Array.isArray(activeJobs) ? activeJobs : (activeJobs?.jobs ?? []);
  const slugs = new Set();
  for (const j of arr) {
    if (!j || typeof j !== "object") continue;
    if (j.slug) slugs.add(j.slug);
    if (j.slugByLocale && typeof j.slugByLocale === "object") {
      for (const v of Object.values(j.slugByLocale)) if (v) slugs.add(v);
    }
    if (Array.isArray(j.previousSlugs)) {
      for (const v of j.previousSlugs) if (v) slugs.add(v);
    }
  }
  return slugs;
}

function collectGscPriority(orphanEnriched) {
  const priority = new Map();
  if (!Array.isArray(orphanEnriched)) return priority;
  for (const entry of orphanEnriched) {
    if (!entry?.slug) continue;
    const impressions = Number(entry.totalImpressions) || 0;
    priority.set(entry.slug, impressions);
  }
  return priority;
}

function loadGscImpressions() {
  // Per-slug aggregated GSC impressions. Sourced from
  // data/orphan-enriched-data.json (refreshed by sync-gsc-orphans.yml).
  // Returns Map<slug, impressions>. Slugs absent from the map are treated
  // as 0 impressions (worst-case assumption when GSC data is missing).
  const map = new Map();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(GSC_ENRICHED_PATH, "utf8"));
  } catch {
    return map;
  }
  const arr = Array.isArray(data) ? data : Object.values(data);
  for (const entry of arr) {
    if (!entry?.slug) continue;
    const imp = Number(entry.totalImpressions) || 0;
    // Multiple entries may share a slug (per-locale rows) — keep the max.
    const prev = map.get(entry.slug) ?? 0;
    if (imp > prev) map.set(entry.slug, imp);
  }
  return map;
}

function trimSlugArray(slugs, gscImp, fallbackCap) {
  // Strategy (user-stated, 2026-05-21):
  //   1. Keep ALL slugs with GSC impressions > 0.
  //   2. If NONE has impressions > 0 (whole array is dark), keep the MOST
  //      RECENT `fallbackCap` entries — most likely to still carry
  //      indexing that hasn't surfaced in our GSC sync yet.
  // A slug missing from `gscImp` is treated as 0 impressions.
  const withTraffic = slugs.filter((s) => (gscImp.get(s) ?? 0) > 0);
  if (withTraffic.length > 0) return withTraffic;
  return slugs.slice(-fallbackCap);
}

function capJobPreviousSlugs(activeJobs, fallbackCap, gscImp) {
  // Mutates active jobs in place. See `trimSlugArray` for the rule.
  const arr = Array.isArray(activeJobs) ? activeJobs : (activeJobs?.jobs ?? []);
  let flatTrimmed = 0;
  let localeTrimmed = 0;
  let jobsAffected = 0;
  let jobsKeptByTraffic = 0;
  let jobsFallbackTopN = 0;
  for (const j of arr) {
    if (!j || typeof j !== "object") continue;
    let touched = false;
    let trafficWin = false;
    if (Array.isArray(j.previousSlugs) && j.previousSlugs.length > 0) {
      const trimmed = trimSlugArray(j.previousSlugs, gscImp, fallbackCap);
      if (trimmed.length !== j.previousSlugs.length) {
        flatTrimmed += j.previousSlugs.length - trimmed.length;
        j.previousSlugs = trimmed;
        touched = true;
      }
      if (trimmed.some((s) => (gscImp.get(s) ?? 0) > 0)) trafficWin = true;
    }
    if (j.previousSlugsByLocale && typeof j.previousSlugsByLocale === "object") {
      for (const locale of Object.keys(j.previousSlugsByLocale)) {
        const v = j.previousSlugsByLocale[locale];
        if (!Array.isArray(v) || v.length === 0) continue;
        const trimmed = trimSlugArray(v, gscImp, fallbackCap);
        if (trimmed.length !== v.length) {
          localeTrimmed += v.length - trimmed.length;
          j.previousSlugsByLocale[locale] = trimmed;
          touched = true;
        }
        if (trimmed.some((s) => (gscImp.get(s) ?? 0) > 0)) trafficWin = true;
      }
    }
    if (touched) {
      jobsAffected++;
      if (trafficWin) jobsKeptByTraffic++;
      else jobsFallbackTopN++;
    }
  }
  return { flatTrimmed, localeTrimmed, jobsAffected, jobsKeptByTraffic, jobsFallbackTopN };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const capFromEnv = Number(process.env.PRUNE_KNOWN_SLUGS_CAP);
  const cap = Number.isFinite(capFromEnv) && capFromEnv > 0 ? capFromEnv : DEFAULT_CAP;
  const pslCapFromEnv = Number(process.env.MAX_PREVIOUS_SLUGS_PER_JOB);
  const pslCap = Number.isFinite(pslCapFromEnv) && pslCapFromEnv > 0
    ? pslCapFromEnv
    : DEFAULT_MAX_PSL_PER_JOB;

  const tracking = readJson(TRACKING_PATH, null);
  if (!tracking || typeof tracking !== "object" || Array.isArray(tracking)) {
    console.error(`❌ ${TRACKING_PATH} missing or wrong shape — refusing to prune.`);
    process.exit(2);
  }

  const beforeCount = Object.keys(tracking).length;

  const activeJobs = readJson(ACTIVE_JOBS_PATH, null);
  if (!activeJobs) {
    console.error(`❌ ${ACTIVE_JOBS_PATH} missing — refusing to prune (run assemble first).`);
    process.exit(2);
  }
  const activeSlugs = collectActiveSlugs(activeJobs);
  if (activeSlugs.size === 0) {
    console.error("❌ Active slug set is empty — refusing to prune (safety guard).");
    process.exit(2);
  }

  // PASS 1: drop tracking entries whose slug matches an active job slug
  // (any locale). The active emission pipeline owns those URLs now; the
  // soft-landing for the same slug would emit a "Position no longer
  // available" page that competes with the live one.
  let dedupRemoved = 0;
  const dedupSamples = [];
  for (const key of Object.keys(tracking)) {
    if (activeSlugs.has(key)) {
      dedupSamples.push(key);
      delete tracking[key];
      dedupRemoved++;
      continue;
    }
    // Also drop if any locale variant of the tracking entry matches an
    // active slug — covers entries whose primary key differs but a locale
    // sibling collides.
    const localePaths = tracking[key];
    if (localePaths && typeof localePaths === "object") {
      let hit = false;
      for (const p of Object.values(localePaths)) {
        if (typeof p !== "string") continue;
        const tail = p.split("/").pop();
        if (tail && activeSlugs.has(tail)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        dedupSamples.push(key);
        delete tracking[key];
        dedupRemoved++;
      }
    }
  }

  // PASS 2: cap the tail.
  const afterDedup = Object.keys(tracking).length;
  let capRemoved = 0;
  if (afterDedup > cap) {
    const priority = collectGscPriority(readJson(GSC_ENRICHED_PATH, []));
    const ranked = Object.keys(tracking)
      .map((key) => ({ key, score: priority.get(key) ?? 0 }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.key.localeCompare(b.key);
      });
    const survivors = new Set(ranked.slice(0, cap).map((r) => r.key));
    for (const key of Object.keys(tracking)) {
      if (!survivors.has(key)) {
        delete tracking[key];
        capRemoved++;
      }
    }
  }

  const finalCount = Object.keys(tracking).length;

  // PASS 3: prune per-job previousSlugs / previousSlugsByLocale arrays.
  // Traffic-aware: keep all slugs with GSC impressions > 0; fallback to
  // most-recent `pslCap` per array when the entire history is dark.
  // Mutates data/jobs.json in place (gitignored, regenerated by assemble
  // each deploy — full history preserved in committed slice files).
  const gscImp = loadGscImpressions();
  const pslReport = capJobPreviousSlugs(activeJobs, pslCap, gscImp);

  console.log("prune-known-slugs:");
  console.log(`  before:                          ${beforeCount}`);
  console.log(`  active-dedup:                    -${dedupRemoved}`);
  console.log(`  tail-cap (≤${cap}):              -${capRemoved}`);
  console.log(`  after:                           ${finalCount}`);
  console.log(`  GSC enrichment loaded:           ${gscImp.size} slugs`);
  console.log(`  previousSlugs (keep-if-traffic, else top-${pslCap}):`);
  console.log(`    jobs affected:                 ${pslReport.jobsAffected}`);
  console.log(`      kept ≥1 by GSC traffic:      ${pslReport.jobsKeptByTraffic}`);
  console.log(`      fallback to top-${pslCap} (all dark):  ${pslReport.jobsFallbackTopN}`);
  console.log(`    entries removed:               -${pslReport.flatTrimmed} flat, -${pslReport.localeTrimmed} per-locale`);
  if (dedupRemoved > 0) {
    console.log(`  active-dedup samples (first 5): ${dedupSamples.slice(0, 5).join(", ")}`);
  }

  if (dryRun) {
    console.log("(dry-run — no file written)");
    return;
  }

  if (dedupRemoved !== 0 || capRemoved !== 0) {
    fs.writeFileSync(TRACKING_PATH, JSON.stringify(tracking, null, 2) + "\n", "utf8");
    console.log(`✅ wrote ${TRACKING_PATH}`);
  } else {
    console.log("ℹ️  tracking file unchanged.");
  }

  if (pslReport.jobsAffected > 0) {
    fs.writeFileSync(ACTIVE_JOBS_PATH, JSON.stringify(activeJobs, null, 2) + "\n", "utf8");
    console.log(`✅ wrote ${ACTIVE_JOBS_PATH} (previousSlugs trimmed)`);
  } else {
    console.log("ℹ️  no jobs exceeded previousSlugs cap.");
  }
}

main();
