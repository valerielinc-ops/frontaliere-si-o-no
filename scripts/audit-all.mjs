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
 * Exit codes:
 *   0 — every audit passed
 *   1 — one or more audits failed (gate or threshold)
 *   2 — dist/ missing or fatal error
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

  const result = await runAudits({ distDir: distArg, auditors: selected, verbose, writeReports: true });

  const fails = result.reports.filter((r) => !r.passed);
  const passes = result.reports.length - fails.length;

  if (verbose) {
    console.log('');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log(`audit-all: ${passes} passed, ${fails.length} failed`);
    console.log(`audit-all: walked ${result.filesScanned} files in ${result.totalElapsedSec.toFixed(2)}s total`);
    console.log(`audit-all:   - walk:    ${result.walkElapsedSec.toFixed(2)}s`);
    console.log(`audit-all:   - collect: ${result.collectElapsedSec.toFixed(2)}s`);
    console.log('══════════════════════════════════════════════════════════════════════');
  }

  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('audit-all: fatal', err);
  process.exit(2);
});
