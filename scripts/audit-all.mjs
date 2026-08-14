#!/usr/bin/env node
/**
 * audit-all.mjs
 *
 * Unified entry point for the audit pipeline. Imports every migrated audit
 * (each exposes a `factory()` creating a fresh Auditor closure), runs them
 * through `runAudits()` in ONE Node process, walking dist/ exactly once.
 *
 * Replaces the per-audit `npm run audit:<name>` calls that today fan out 12+
 * Node processes (each loading V8 + dependencies, each walking dist/ from
 * scratch). On the 7 GB ubuntu-latest free runner, that fan-out forced
 * everything serial to avoid OOM (post-deploy-validate-dist.yml comments
 * spell out the history).
 *
 * Usage:
 *   node scripts/audit-all.mjs                       # run all registered audits
 *   node scripts/audit-all.mjs --audits=text-html-ratio,footer-root-presence
 *   node scripts/audit-all.mjs --dist=path/to/dist   # default: ./dist
 *   AUDIT_STRICT=1 node scripts/audit-all.mjs        # detect AST mutation
 *
 * Sampling (opt-in, CI speed lever — see scripts/lib/audit-runner.mjs's
 * sampleFiles() for the rotation guarantee this relies on):
 *   AUDIT_SAMPLE_RATE=0.25 AUDIT_SAMPLE_SALT=$GITHUB_RUN_NUMBER node scripts/audit-all.mjs
 * Defaults to rate=1 (no sampling, full scan) when unset — every invocation
 * outside the one CI step that opts in keeps scanning 100% of dist/, exactly
 * as before this option existed. AUDIT_SAMPLE_SALT should increment every
 * run (e.g. the GitHub Actions run number) so the sampled slice rotates —
 * over `round(1/AUDIT_SAMPLE_RATE)` consecutive runs, every file in dist/
 * gets scanned at least once. This trades per-run completeness for
 * wall-clock; it does NOT lower any gate's pass/fail threshold — see
 * AGENTS.md non-negotiable #1 and the rationale in audit-runner.mjs.
 *
 * Exit codes:
 *   0 — every audit passed
 *   1 — one or more audits failed (gate or threshold)
 *   2 — dist/ missing or fatal error
 *
 * Machine-readable failure list (issue #4828)
 * ------------------------------------------
 * On every completed run this prints ONE line in a stable format:
 *
 *   audit-all: failed-audits=<name>[,<name>...]        (empty when all passed)
 *
 * `validate-dist-postbuild` parses it so the `integrity-verdict` classifier
 * can see WHICH auditor failed instead of the opaque bundle name `audit:all`.
 * Before this line existed, one red cosmetic auditor (e.g. `text-html-ratio`)
 * arrived at the classifier as the unclassifiable name `audit:all`, hit
 * default-deny, and sequestered `publish` — the exact failure mode #4828
 * tracks, re-entering through the bundle. Printed unconditionally (not behind
 * `verbose`) because the consumer is a machine, not a reader; a missing line
 * makes the workflow fall back to the opaque name, i.e. fail closed.
 */
import { stat } from 'node:fs/promises';
import { runAudits, filterAuditors, DEFAULT_DIST } from './lib/audit-runner.mjs';

// ─── Register migrated audits ────────────────────────────────────────────────
// Each migration imports the audit's `factory()` and the runner instantiates
// a fresh Auditor per pass. Add new audits here as they migrate.

import { factory as footerRootPresence } from './audit-footer-root-presence.mjs';
import { factory as jsonldNoNestedScripts } from './audit-jsonld-no-nested-scripts.mjs';
import { factory as titleLength } from './audit-title-length.mjs';
import { factory as titleNoDisambigHash } from './audit-title-no-disambig-hash.mjs';
import { factory as h1TitleDuplicates } from './audit-h1-title-duplicates.mjs';
import { factory as textHtmlRatio } from './audit-text-html-ratio.mjs';
import { factory as salaryLandingTemplate } from './audit-salary-landing-template.mjs';
import { factory as pageWeight } from './audit-page-weight.mjs';
import { factory as contentDuplicates } from './audit-content-duplicates.mjs';
import { factory as faqpageValidity } from './audit-faqpage-validity.mjs';
import { factory as imageObjectLicense } from './audit-image-object-license.mjs';
import { factory as noLiteralMarkdown } from './audit-no-literal-markdown.mjs';
import { factory as breadcrumbCoverage } from './audit-breadcrumb-coverage.mjs';

const REGISTRY = [
  { factory: footerRootPresence, name: 'footer-root-presence' },
  { factory: jsonldNoNestedScripts, name: 'jsonld-no-nested-scripts' },
  { factory: titleLength, name: 'title-length' },
  { factory: titleNoDisambigHash, name: 'title-no-disambig-hash' },
  { factory: h1TitleDuplicates, name: 'h1-title-duplicates' },
  { factory: textHtmlRatio, name: 'text-html-ratio' },
  { factory: salaryLandingTemplate, name: 'salary-landing-template' },
  { factory: pageWeight, name: 'page-weight' },
  { factory: contentDuplicates, name: 'content-duplicates' },
  { factory: faqpageValidity, name: 'faqpage-validity' },
  { factory: imageObjectLicense, name: 'image-object-license' },
  { factory: noLiteralMarkdown, name: 'no-literal-markdown' },
  { factory: breadcrumbCoverage, name: 'breadcrumb-coverage' },
];

// ─── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const a = args.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : fallback;
}

const distArg = getArg('dist', DEFAULT_DIST);
const auditFilter = getArg('audits', undefined); // CSV of audit names
const verbose = !args.includes('--quiet');

// Opt-in sampling (see file header docs above). CLI flags take precedence
// over env vars so a local `--sample-rate=` override doesn't require
// unsetting the CI env var; both default to "off" (full scan).
const sampleRate = Number(getArg('sample-rate', process.env.AUDIT_SAMPLE_RATE ?? '1'));
const sampleSalt = Number(getArg('sample-salt', process.env.AUDIT_SAMPLE_SALT ?? '0'));

async function main() {
  const s = await stat(distArg).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`audit-all: dist not found or not a directory: ${distArg}`);
    process.exit(2);
  }

  // Instantiate fresh auditors from factories
  const auditors = REGISTRY.map((r) => r.factory());

  // Optional filter
  const selected = filterAuditors(auditors, auditFilter);
  if (selected.length === 0) {
    console.error(`audit-all: no auditors selected (filter=${auditFilter ?? '∅'})`);
    process.exit(2);
  }

  if (verbose) {
    console.log(`audit-all: running ${selected.length} of ${auditors.length} registered auditors`);
    console.log(`audit-all: dist = ${distArg}`);
    console.log(`audit-all: auditors = ${selected.map((a) => a.name).join(', ')}`);
  }

  const result = await runAudits({ distDir: distArg, auditors: selected, verbose, writeReports: true, sampleRate, sampleSalt });

  const fails = result.reports.filter((r) => !r.passed);
  const passes = result.reports.length - fails.length;

  if (verbose) {
    console.log('');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log(`audit-all: ${passes} passed, ${fails.length} failed`);
    console.log(`audit-all: walked ${result.filesScanned} files in ${result.totalElapsedSec.toFixed(2)}s total`);
    console.log(`audit-all:   - walk:    ${result.walkElapsedSec.toFixed(2)}s`);
    console.log(`audit-all:   - collect: ${result.collectElapsedSec.toFixed(2)}s`);
    if (result.sampling) {
      const { activeBucket, totalBuckets, filesOnDisk, filesScanned } = result.sampling;
      console.log(
        `audit-all:   - SAMPLED: bucket ${activeBucket + 1}/${totalBuckets} — ${filesScanned}/${filesOnDisk} files ` +
        `(${((filesScanned / filesOnDisk) * 100).toFixed(1)}%). Full coverage needs ${totalBuckets} consecutive runs.`,
      );
    }
    console.log('══════════════════════════════════════════════════════════════════════');
  }

  // Machine-readable, unconditional, single line — see the header block.
  // Consumed by the "Publish gate results" step of validate-dist-postbuild.
  console.log(`audit-all: failed-audits=${fails.map((r) => r.name).join(',')}`);

  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('audit-all: fatal', err);
  process.exit(2);
});
