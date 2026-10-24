#!/usr/bin/env node
/**
 * Post-build gate: every active job detail page of THIS build still carries
 * JobPosting JSON-LD in the final dist (owner decision 2026-10-24).
 *
 * The jobs SEO plugin already asserts the HTML it queues (and fails the build
 * on a miss). This gate re-reads the same pages from `dist/` after every later
 * plugin and the locale prune have run, so a post-processing step that strips
 * or overwrites an active page cannot ship either. Its input is the sidecar the
 * plugin writes when `JOBPOSTING_COVERAGE_OUT` is set (the deploy build step
 * sets it); a missing sidecar fails, because "nothing checked" must never read
 * as green.
 *
 * Zero tolerance: this judges what this build emits (AGENTS.md
 * Non-Negotiable #1). The coverage rate is printed on every run.
 *
 * Usage:
 *   JOBPOSTING_COVERAGE_OUT=/tmp/jobposting-coverage.json \
 *     node scripts/ci/assert-active-jobposting-coverage.mjs [distDir]
 */
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyActiveJobPostingCoverage } from '../lib/active-jobposting-coverage.mjs';

export function readDistPage(distDir, pagePath) {
  const rel = String(pagePath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const file = rel ? path.join(distDir, rel, 'index.html') : path.join(distDir, 'index.html');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function runActiveJobPostingCoverageGate({ distDir, sidecarPath, log = console.log, error = console.error }) {
  if (!sidecarPath) {
    error('✖ JOBPOSTING_COVERAGE_OUT is not set: the build did not record its active job pages.');
    return 2;
  }
  let sidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch (err) {
    error(`✖ active JobPosting sidecar unreadable at ${sidecarPath}: ${err?.message || err}`);
    return 2;
  }
  const listed = Array.isArray(sidecar?.pages) ? sidecar.pages.length : 0;
  if (Number(sidecar?.total) !== listed) {
    error(`✖ active JobPosting sidecar is truncated: total=${sidecar?.total} listed=${listed}`);
    return 2;
  }
  const expectedTotal = sidecar?.expectedTotal;
  if (expectedTotal === undefined || expectedTotal === null) {
    if (Number(sidecar?.total) === 0) {
      error('✖ active JobPosting sidecar has no independent active-population count: an empty sidecar cannot pass coverage.');
      return 2;
    }
  } else if (!Number.isInteger(expectedTotal) || expectedTotal < 0 || Number(sidecar?.total) !== expectedTotal) {
    error(`✖ active JobPosting population mismatch: expected=${expectedTotal} recorded=${sidecar?.total}`);
    return 2;
  }
  const report = verifyActiveJobPostingCoverage(sidecar, (pagePath) => readDistPage(distDir, pagePath));
  const rate = report.pages === 0 ? 100 : (100 * report.withJobPosting) / report.pages;
  log(
    `[jobposting-coverage:dist] active=${report.pages} checked=${report.checked} absent=${report.absent} `
    + `with-jobposting=${report.withJobPosting} missing=${report.missing.length} rate=${rate.toFixed(3)}%`,
  );
  if (report.missing.length === 0 && report.absent === 0) return 0;
  if (report.absent > 0) {
    error(`✖ ${report.absent} active job detail page(s) recorded by the build are absent from ${distDir}.`);
  }
  for (const page of report.missing.slice(0, 30)) {
    error(`✖ no JobPosting: ${page.locale} ${page.path}${page.indexable === false ? ' (noindex)' : ''}`);
  }
  if (report.missing.length > 30) error(`  … and ${report.missing.length - 30} more`);
  error('An active job ALWAYS emits JobPosting (docs/SEO-RULES.md, "JobPosting Structured Data").');
  return 1;
}

if ((() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})()) {
  const distDir = path.resolve(process.argv[2] || 'dist');
  process.exit(runActiveJobPostingCoverageGate({ distDir, sidecarPath: process.env.JOBPOSTING_COVERAGE_OUT }));
}
