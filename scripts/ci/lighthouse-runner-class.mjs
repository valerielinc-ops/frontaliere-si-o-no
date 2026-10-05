#!/usr/bin/env node
/**
 * Lighthouse runner-class observer (advisory, issue 11666).
 *
 * The mobile FCP/LCP of the SPA pages (`/`, `/cerca-lavoro-ticino/`) is
 * bimodal in Lighthouse CI, and the mode follows the GitHub runner, not the
 * code: on the 2026-10-04 runner (`benchmarkIndex` ~3,400) every page painted
 * before DOMContentLoaded; on the 02/03/05-10 runners (~2,270-2,480) the SPA
 * pages painted only after the app started — observed first paint 1.3-2.4 s
 * instead of ~0.3 s, simulated mobile FCP 8-13 s instead of 4.6 s on
 * /cerca-lavoro-ticino/. The budget assertions cannot tell the two apart, so
 * this prints, for every run, the runner class next to the paint mode. A
 * regression issue then says whether it came with a slower runner.
 *
 * Mode: `slow` = observed first paint AFTER DOMContentLoaded (the static HTML
 * did not reach the screen before the app's JavaScript ran), `fast` otherwise.
 *
 * Usage: node scripts/ci/lighthouse-runner-class.mjs [--dir .lighthouseci] [--out file.md]
 * Reads `lhr-*.json` (LHCI) and `*.report.json` (Lighthouse CLI). Always exits
 * 0 unless the directory cannot be read: it measures, it does not gate.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LHR_FILE = /^(lhr-.*|.*\.report)\.json$/;

/** One row per LHR; `null` when the file is not a usable LHR. */
export function rowFromLhr(lhr) {
  if (!lhr || typeof lhr !== 'object' || !lhr.audits) return null;
  let path;
  try {
    path = new URL(lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl).pathname;
  } catch {
    return null;
  }
  const metrics = lhr.audits.metrics?.details?.items?.[0] ?? {};
  const firstPaint = metrics.observedFirstPaint;
  const dcl = metrics.observedDomContentLoaded;
  const fcp = lhr.audits['first-contentful-paint']?.numericValue;
  let mode = 'unknown';
  if (typeof firstPaint === 'number' && typeof dcl === 'number') mode = firstPaint > dcl ? 'slow' : 'fast';
  return {
    path,
    formFactor: lhr.configSettings?.formFactor ?? 'unknown',
    fetchTime: lhr.fetchTime ?? '',
    benchmarkIndex: lhr.environment?.benchmarkIndex,
    firstPaint,
    dcl,
    fcp,
    mode,
  };
}

export function collectRows(dir) {
  const rows = [];
  for (const name of readdirSync(dir).filter((n) => LHR_FILE.test(n)).sort()) {
    let lhr;
    try {
      lhr = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const row = rowFromLhr(lhr);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.fetchTime.localeCompare(b.fetchTime));
}

const ms = (v) => (typeof v === 'number' ? String(Math.round(v)) : 'n/a');

export function renderMarkdown(rows) {
  if (rows.length === 0) return '_Runner class: no Lighthouse result to read._\n';
  const lines = [
    '| page | form factor | benchmarkIndex | first paint (ms) | DCL (ms) | mode | simulated FCP (ms) |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.path} | ${r.formFactor} | ${ms(r.benchmarkIndex)} | ${ms(r.firstPaint)} | ${ms(r.dcl)} | ${r.mode} | ${ms(r.fcp)} |`);
  }
  const bench = rows.map((r) => r.benchmarkIndex).filter((v) => typeof v === 'number');
  const slow = rows.filter((r) => r.mode === 'slow').length;
  const range = bench.length ? `${Math.round(Math.min(...bench))}-${Math.round(Math.max(...bench))}` : 'n/a';
  lines.push('');
  lines.push(`Runner benchmarkIndex ${range}; ${slow}/${rows.length} run(s) in slow mode (first paint after DOMContentLoaded). Reference, mobile: index ~3,400 on 2026-10-04 with every page fast; ~2,400 on 02/03/05-10 with / and /cerca-lavoro-ticino/ slow.`);
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const dir = arg('--dir', '.lighthouseci');
  const out = arg('--out', '');
  let markdown;
  try {
    markdown = renderMarkdown(collectRows(dir));
  } catch (error) {
    console.error(`::warning title=Lighthouse runner class::cannot read ${dir}: ${error.message}`);
    return 1;
  }
  process.stdout.write(markdown);
  if (out) writeFileSync(out, markdown);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
