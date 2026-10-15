#!/usr/bin/env node
/**
 * recover-conflict-marker-slices.mjs
 *
 * Recovery script for data/jobs/by-crawler/<slice>.json files that got committed
 * with unresolved Git merge-conflict markers (<<<<<<< / ======= / >>>>>>>).
 *
 * Root cause (May 2026 incident): a concurrent cron did `git stash && git pull
 * && git stash pop` while writing slices, the pop conflicted, and the file
 * was committed verbatim. The downstream `assemble-jobs-dataset.mjs` silently
 * skipped each malformed slice, dropping ~3.5k jobs from production.
 *
 * Strategy: strip the marker lines (keep both sides' content), then char-walk
 * the resulting bytes to extract every balanced top-level job object inside
 * the `jobs` array. Dedupe by `id` (keeping the entry with the most recent
 * `lastUpdatedAt` / `firstSeenAt`), and re-emit the slice with its preserved
 * crawlerKey + assembledAt header.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { writeJsonAtomic } from "./lib/atomic-write-json.mjs";
import { preserveSlugHistory } from "./lib/slug-preservation-guard.mjs";

const SLICE_DIRS = [
  path.resolve("data/jobs/by-crawler"),
  path.resolve("data/jobs/expired/by-crawler"),
  path.resolve("data/translation-cache"),
];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function conflictRecoveryProof(fullPath, original, output) {
  return {
    kind: "conflict-marker-recovery",
    path: fullPath,
    sourceDigest: sha256(original),
    candidateDigest: sha256(`${JSON.stringify(output, null, 2)}\n`),
  };
}

function linesWithoutTrailingCarriageReturn(text) {
  return text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function stripMarkers(text) {
  // Drop the conflict marker lines entirely. We keep ALL content from both
  // sides; the extraction phase will dedupe via id and tolerate stray syntax.
  return linesWithoutTrailingCarriageReturn(text)
    .filter((ln) => !/^(<<<<<<<|>>>>>>>|=======$)/.test(ln))
    .join("\n");
}

function extractHeader(text) {
  // Match `"crawlerKey": "..."` and `"assembledAt": "..."` from the file
  // preamble. These are stable single-line fields.
  const crawlerKey = text.match(/"crawlerKey"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const assembledAt = text.match(/"assembledAt"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  return { crawlerKey, assembledAt };
}

/**
 * Walk the cleaned text and extract every balanced `{...}` object inside the
 * outer `jobs` array. Respects string boundaries (including escaped quotes).
 */
function extractJobObjects(text) {
  // Slice files come in two shapes:
  //   - Active:  { "crawlerKey": "...", "assembledAt": "...", "jobs": [ {...}, ... ] }
  //   - Expired: [ {...}, {...}, ... ]
  // Locate the outer `[` of the array regardless of which shape.
  const jobsKeyIdx = text.indexOf('"jobs"');
  let i = jobsKeyIdx !== -1 ? text.indexOf("[", jobsKeyIdx) : text.indexOf("[");
  if (i === -1) return [];
  i++; // Step past `[`.

  const objects = [];
  const len = text.length;

  while (i < len) {
    // Skip whitespace, commas, stray characters until next `{` or end `]`.
    while (i < len && text[i] !== "{" && text[i] !== "]") i++;
    if (i >= len || text[i] === "]") break;

    // Walk a balanced object starting at i.
    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (; i < len; i++) {
      const c = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\" && inString) {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++; // include closing brace
          objects.push(text.slice(start, i));
          break;
        }
      }
    }
    if (depth !== 0) {
      // Unbalanced — give up on rest of file.
      break;
    }
  }

  return objects;
}

function parseJobObjects(rawObjects) {
  const parsed = [];
  for (const raw of rawObjects) {
    try {
      parsed.push(JSON.parse(raw));
    } catch {
      // Skip individual job objects that fail to parse on their own — the
      // marker stripping can leave odd whitespace around an object that
      // straddled a marker. We accept the data loss for that single job.
    }
  }
  return parsed;
}

function stripConflictSide(text, side) {
  const kept = [];
  let conflictSide = null;
  for (const line of linesWithoutTrailingCarriageReturn(text)) {
    if (/^<<<<<<<(?:\s|$)/.test(line)) {
      conflictSide = "ours";
      continue;
    }
    if (/^=======$/.test(line)) {
      conflictSide = "theirs";
      continue;
    }
    if (/^>>>>>>>/.test(line)) {
      conflictSide = null;
      continue;
    }
    if (conflictSide === null || conflictSide === side) kept.push(line);
  }
  return kept.join("\n");
}

function parsedJobsFromConflictSide(text, side) {
  try {
    const parsed = JSON.parse(stripConflictSide(text, side));
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

function preserveRecoveredSlugHistory(sliceDir, fullPath, original, output) {
  if (path.resolve(sliceDir) !== path.resolve("data/jobs/by-crawler")) return;
  // The original file is intentionally malformed, so writeJsonAtomic cannot
  // parse it as its own history source. Recover both conflict sides explicitly
  // and run the same preservation guard against each before the atomic write.
  for (const side of ["ours", "theirs"]) {
    preserveSlugHistory(fullPath, output, {
      previousValue: { jobs: parsedJobsFromConflictSide(original, side) },
      root: process.cwd(),
    });
  }
}

function dedupeJobs(jobs) {
  const byId = new Map();
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const id = job.id ?? job.slug ?? null;
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, job);
      continue;
    }
    // Prefer the one with the most recent lastUpdatedAt / firstSeenAt.
    const stampNew = job.lastUpdatedAt ?? job.firstSeenAt ?? job.crawledAt ?? "";
    const stampOld = existing.lastUpdatedAt ?? existing.firstSeenAt ?? existing.crawledAt ?? "";
    if (stampNew > stampOld) byId.set(id, job);
  }
  return [...byId.values()];
}

function rebuildSlice(sliceDir, file) {
  const fullPath = path.join(sliceDir, file);
  const original = fs.readFileSync(fullPath, "utf8");

  if (!/^(<<<<<<<|>>>>>>>|=======$)/m.test(original)) {
    return { file, status: "clean", jobs: null };
  }

  const cleaned = stripMarkers(original);

  // Fast path: many conflicts are within an object (translation-cache shape)
  // where stripping markers yields valid JSON outright. Try that first.
  try {
    const parsed = JSON.parse(cleaned);
    preserveRecoveredSlugHistory(sliceDir, fullPath, original, parsed);
    writeJsonAtomic(fullPath, parsed, {
      // `writeJsonAtomic` transports this through its existing housekeeping
      // proof option; the integrity guard validates the exact source/candidate
      // digests before allowing a malformed conflict file to be replaced.
      housekeepingProof: conflictRecoveryProof(fullPath, original, parsed),
    });
    return { file, status: "recovered", rawObjects: 0, parsed: 0, deduped: 0, strategy: "strip-only" };
  } catch {
    // Fall through to object-extraction strategy.
  }

  const isTopLevelArray = cleaned.trimStart().startsWith("[");
  const { crawlerKey, assembledAt } = isTopLevelArray
    ? { crawlerKey: null, assembledAt: null }
    : extractHeader(cleaned);
  const rawObjects = extractJobObjects(cleaned);
  const parsed = parseJobObjects(rawObjects);
  const deduped = dedupeJobs(parsed);

  if (deduped.length === 0) {
    return {
      file,
      status: "no-recoverable-jobs",
      rawObjects: rawObjects.length,
      parsed: parsed.length,
    };
  }

  const output = isTopLevelArray
    ? deduped
    : {
        crawlerKey: crawlerKey ?? file.replace(/\.json$/, ""),
        assembledAt: assembledAt ?? new Date().toISOString(),
        jobs: deduped,
      };

  // Validate the assembled JSON round-trips cleanly before writing.
  const serialized = JSON.stringify(output, null, 2);
  JSON.parse(serialized);

  preserveRecoveredSlugHistory(sliceDir, fullPath, original, output);
  writeJsonAtomic(fullPath, output, {
    housekeepingProof: conflictRecoveryProof(fullPath, original, output),
  });

  return {
    file,
    status: "recovered",
    rawObjects: rawObjects.length,
    parsed: parsed.length,
    deduped: deduped.length,
  };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");

  let totalFiles = 0;
  let totalRecovered = 0;
  let totalNoRecovery = 0;
  let totalAffected = 0;

  for (const sliceDir of SLICE_DIRS) {
    if (!fs.existsSync(sliceDir)) continue;
    const files = fs.readdirSync(sliceDir).filter((f) => f.endsWith(".json"));
    const affected = files.filter((f) => {
      const text = fs.readFileSync(path.join(sliceDir, f), "utf8");
      return /^(<<<<<<<|>>>>>>>|=======$)/m.test(text);
    });
    totalFiles += files.length;
    totalAffected += affected.length;
    const rel = path.relative(process.cwd(), sliceDir);
    console.log(`Scanning ${rel}: ${files.length} slices, ${affected.length} affected.`);

    if (affected.length === 0) continue;

    if (dryRun) {
      for (const f of affected) console.log(`  - ${rel}/${f}`);
      continue;
    }

    for (const f of affected) {
      const result = rebuildSlice(sliceDir, f);
      if (result.status === "recovered") {
        totalRecovered++;
        console.log(
          `  ✅ ${rel}/${f}: parsed=${result.parsed} raw=${result.rawObjects} → kept ${result.deduped} unique jobs`,
        );
      } else if (result.status === "no-recoverable-jobs") {
        totalNoRecovery++;
        console.log(
          `  ❌ ${rel}/${f}: NO RECOVERABLE JOBS (raw=${result.rawObjects}, parsed=${result.parsed})`,
        );
      }
    }
  }

  console.log("");
  if (dryRun) {
    console.log(`Dry-run: would rebuild ${totalAffected} slice(s).`);
    return;
  }
  console.log(
    `Done. Recovered: ${totalRecovered} | Unrecoverable: ${totalNoRecovery} | Skipped clean: ${totalFiles - totalAffected}`,
  );

  if (totalNoRecovery > 0) {
    console.error(`\n❌ ${totalNoRecovery} slice(s) had no recoverable jobs. Inspect above.`);
    process.exit(2);
  }
}

main();
