#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/extract-crawler-manifest.mjs — parse all .github/workflows/update-jobs-*.yml
// and produce data/crawler-manifest.json, the input consumed by
// scripts/generate-crawler-group-workflows.mjs.
//
// For each crawler workflow file we extract:
//   - name        : workflow `name:` field
//   - file         : source filename (for traceability / re-run diffing)
//   - crawlerSlug : derived from filename (update-jobs-<slug>.yml -> <slug>),
//                   used to build a unique step `id:` and the
//                   SLUG_HISTORY_SUMMARY_FILE path.
//   - bespokeSteps: the ordered list of steps AFTER the common
//                   checkout/setup-node prep, preserved VERBATIM (name/env/run/
//                   if/continue-on-error/id) — this is everything that makes a
//                   crawler's commit-and-push / error-reporting mechanism its
//                   own (Non-Negotiable constraint: do not genericize this).
//
// We do NOT hand-classify "install deps" vs "run crawler" vs "commit" by name
// matching — real inspection showed step names and even step COUNT vary
// (Playwright installs, `npm ci --ignore-scripts` on 10 crawlers, differently
// worded housekeeping/commit step names). The only steps that are safe to
// hoist to a single shared group-level step (byte-identical `uses:`/`with:`
// across the whole corpus, pure environment prep, no commit/error-reporting
// semantics) are `actions/checkout` and `actions/setup-node`. Everything from
// "Install dependencies" onward is preserved per-crawler, verbatim, as the
// body of that crawler's own `background: true` step.
//
// Usage: node scripts/extract-crawler-manifest.mjs
// Output: data/crawler-manifest.json
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const WORKFLOWS_DIR = path.resolve('.github/workflows');
const OUT_PATH = path.resolve('data/crawler-manifest.json');

function isCheckoutStep(step) {
  return !!(step.uses && step.uses.startsWith('actions/checkout'));
}
function isSetupNodeStep(step) {
  return !!(step.uses && step.uses.startsWith('actions/setup-node'));
}

function slugFromFilename(filename) {
  // update-jobs-<slug>.yml -> <slug>
  return filename.replace(/^update-jobs-/, '').replace(/\.yml$/, '');
}

function main() {
  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.startsWith('update-jobs-') && f.endsWith('.yml'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // stable, deterministic order

  if (files.length === 0) {
    console.error('No update-jobs-*.yml files found — nothing to extract.');
    process.exit(1);
  }

  const manifest = [];
  const errors = [];

  for (const file of files) {
    const fullPath = path.join(WORKFLOWS_DIR, file);
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (error) {
      errors.push(`${file}: YAML parse error — ${error.message}`);
      continue;
    }

    const workflowName = doc.name || file;
    const jobKeys = Object.keys(doc.jobs || {});
    if (jobKeys.length !== 1) {
      errors.push(`${file}: expected exactly 1 job, found ${jobKeys.length}`);
      continue;
    }
    const job = doc.jobs[jobKeys[0]];
    const steps = job.steps || [];

    const checkoutIdx = steps.findIndex(isCheckoutStep);
    const setupNodeIdx = steps.findIndex(isSetupNodeStep);
    if (checkoutIdx === -1 || setupNodeIdx === -1) {
      errors.push(`${file}: missing checkout or setup-node step`);
      continue;
    }

    // Everything after setup-node is bespoke and preserved verbatim.
    const prepEndIdx = Math.max(checkoutIdx, setupNodeIdx) + 1;
    const bespokeSteps = steps.slice(prepEndIdx);

    if (bespokeSteps.length === 0) {
      errors.push(`${file}: no bespoke steps found after checkout/setup-node`);
      continue;
    }

    const crawlerSlug = slugFromFilename(file);

    manifest.push({
      file,
      workflowName,
      crawlerSlug,
      originalJobKey: jobKeys[0],
      originalTimeoutMinutes: job['timeout-minutes'] ?? null,
      originalConcurrencyGroup: (doc.concurrency && doc.concurrency.group) || null,
      bespokeSteps,
    });
  }

  if (errors.length > 0) {
    console.error(`❌ ${errors.length} file(s) failed extraction:`);
    for (const e of errors) console.error(`   - ${e}`);
    process.exit(1);
  }

  // Stable order (already sorted by filename via `files`).
  fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`✅ Extracted ${manifest.length} crawler manifests -> ${path.relative('.', OUT_PATH)}`);
}

main();
