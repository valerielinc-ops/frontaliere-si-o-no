#!/usr/bin/env node
/**
 * audit-no-merge-markers.mjs
 *
 * 0-tolerance gate: fails if any tracked file contains unresolved Git
 * conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
 *
 * Wired into `tests.yml` and `deploy.yml`. Lives at the data-validation
 * tier — runs in seconds, blocks the build before any expensive step.
 *
 * Why exists: incident 2026-05-21 — a concurrent cron committed 92 job
 * slice files with unresolved `git stash pop` conflicts. The downstream
 * `assemble-jobs-dataset.mjs` silently skipped each malformed slice and
 * the production deploy shipped with 2 603 jobs instead of 5 922.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SCAN_ROOTS = [
  "data/jobs/by-crawler",
  "data/jobs/expired/by-crawler",
  "data",
  "scripts",
  "build-plugins",
  "components",
  "services",
  "src",
  "tests",
  ".github",
];

// Files where a literal `<<<<<<< ` at start-of-line is legitimate (this
// script's own self-test fixtures, the recovery script's regexes, etc.).
const ALLOW = new Set([
  "scripts/audit-no-merge-markers.mjs",
  "scripts/recover-conflict-marker-slices.mjs",
  "tests/scripts/audit-no-merge-markers.test.ts",
]);

const MARKER_RE = /^(<<<<<<< |=======$|>>>>>>> )/m;

function listFilesViaGit() {
  // Prefer git ls-files so we ignore .gitignore and submodule contents.
  try {
    const out = execSync("git ls-files -z", { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    return out
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

function listFilesViaFs(roots) {
  const found = [];
  const stack = roots.filter((r) => fs.existsSync(r));
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === "node_modules" ||
          ent.name === "dist" ||
          ent.name === ".git" ||
          ent.name === ".cache" ||
          ent.name === ".claude"
        ) {
          continue;
        }
        stack.push(full);
      } else if (ent.isFile()) {
        found.push(full);
      }
    }
  }
  return found;
}

function isTextFile(filePath) {
  // Cheap heuristic: skip known binary extensions. Markers in PNGs aren't
  // a thing we care about.
  return !/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|mp3|pdf|zip|gz|tgz|tar|bin)$/i.test(filePath);
}

function main() {
  const allFiles = listFilesViaGit() ?? listFilesViaFs(SCAN_ROOTS);
  const candidates = allFiles.filter(
    (f) => isTextFile(f) && !ALLOW.has(f.split(path.sep).join("/")),
  );

  const hits = [];
  for (const file of candidates) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue; // unreadable / not a regular file
    }
    if (MARKER_RE.test(content)) {
      hits.push(file);
    }
  }

  if (hits.length === 0) {
    console.log(`✅ audit-no-merge-markers: 0 files contain merge conflict markers (scanned ${candidates.length}).`);
    return;
  }

  console.error(`❌ audit-no-merge-markers: ${hits.length} file(s) contain merge conflict markers:`);
  for (const f of hits) console.error(`  - ${f}`);
  console.error("");
  console.error(
    "Resolve the conflicts (do not commit raw <<<<<<< / ======= / >>>>>>> markers).\n" +
      "For job slice files specifically, run: node scripts/recover-conflict-marker-slices.mjs",
  );
  process.exit(1);
}

main();
