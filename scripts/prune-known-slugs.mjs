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
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const TRACKING_PATH = path.resolve("data/all-known-job-slugs.json");
const ACTIVE_JOBS_PATH = path.resolve("data/jobs.json");
const GSC_ENRICHED_PATH = path.resolve("data/orphan-enriched-data.json");
const DEFAULT_CAP = 20_000;

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

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const capFromEnv = Number(process.env.PRUNE_KNOWN_SLUGS_CAP);
  const cap = Number.isFinite(capFromEnv) && capFromEnv > 0 ? capFromEnv : DEFAULT_CAP;

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

  console.log("prune-known-slugs:");
  console.log(`  before:           ${beforeCount}`);
  console.log(`  active-dedup:     -${dedupRemoved}`);
  console.log(`  tail-cap (≤${cap}):  -${capRemoved}`);
  console.log(`  after:            ${finalCount}`);
  if (dedupRemoved > 0) {
    console.log(`  active-dedup samples (first 5): ${dedupSamples.slice(0, 5).join(", ")}`);
  }

  if (dryRun) {
    console.log("(dry-run — no file written)");
    return;
  }
  if (dedupRemoved === 0 && capRemoved === 0) {
    console.log("✅ no changes — file untouched.");
    return;
  }

  fs.writeFileSync(TRACKING_PATH, JSON.stringify(tracking, null, 2) + "\n", "utf8");
  console.log(`✅ wrote ${TRACKING_PATH}`);
}

main();
