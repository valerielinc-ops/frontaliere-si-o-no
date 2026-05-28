#!/usr/bin/env node
/**
 * audit-no-dotfile-html.mjs
 *
 * 0-tolerance gate: fails if any HTML file emitted under `dist/` has a
 * basename that starts with `.` (e.g. `dist/articoli-frontaliere/<slug>/.html`).
 *
 * Why exists: incident 2026-05-28 — `ogPagesPlugin` concatenated `+ '.html'`
 * onto a canonicalPath that already ended in `/`, producing a dotfile
 * `<slug>/.html` instead of the intended flat sibling `<slug>.html`. The
 * post-walk coordinator then rewrote it into a redirect bridge. GitHub
 * Pages served that dotfile for the trailing-slash URL with
 * `content-type=application/octet-stream`, masking the real
 * `<slug>/index.html` (full article) and reducing the served body to a
 * 1.7 KB infinite-redirect stub. ~2 540 articles affected; AdSense RPM
 * collapsed from 3.04 to 1.74 CHF in a single day because the stubs
 * carry no SPA bundle and no AdSense tags.
 *
 * Wired into `post-deploy-validate-dist.yml` as a strict gate (count must
 * stay at zero — there is no legitimate use case for a `dist/**\/.html`
 * dotfile).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const distDir = path.resolve(process.cwd(), "dist");

if (!fs.existsSync(distDir)) {
  console.error("[audit-no-dotfile-html] dist/ not found — nothing to audit");
  process.exit(0);
}

const offenders = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip static-asset directories that may legitimately ship dotfiles
      // (none currently, but matches the post-walk coordinator convention).
      if (entry.name === "assets" || entry.name === "data" || entry.name === "images") continue;
      walk(p);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".html")) continue;
    if (entry.name.startsWith(".")) {
      const rel = path.relative(distDir, p);
      const size = fs.statSync(p).size;
      offenders.push({ rel, size });
    }
  }
}

walk(distDir);

if (offenders.length === 0) {
  console.log("\x1b[32m[audit-no-dotfile-html]\x1b[0m PASS — no dotfile .html under dist/");
  process.exit(0);
}

console.error(
  `\x1b[31m[audit-no-dotfile-html]\x1b[0m FAIL — ${offenders.length} dotfile .html files under dist/`,
);
const sample = offenders.slice(0, 20);
for (const o of sample) {
  console.error(`  - dist/${o.rel} (${o.size} bytes)`);
}
if (offenders.length > sample.length) {
  console.error(`  … ${offenders.length - sample.length} more`);
}
console.error(
  "Hint: a build plugin likely concatenated `+ '.html'` onto a path ending in `/`. " +
    "Strip the trailing slash before the concat (see ogPagesPlugin.ts:1049 fix).",
);
process.exit(1);
