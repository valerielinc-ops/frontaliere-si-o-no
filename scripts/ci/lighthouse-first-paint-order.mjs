#!/usr/bin/env node
/**
 * Lighthouse CI check: on the SPA-takeover pages the static HTML must paint
 * BEFORE the SPA mount hides it (issue 11666).
 *
 * index.tsx sets the user-timing mark `ft:static-handoff-hide` right before it
 * fades #root (which holds the static HTML) to `opacity: 0`. If the observed
 * first contentful paint comes after that mark, the static HTML never reached
 * the screen and the page stayed blank until React rendered: a simulated
 * mobile FCP of 8-13 s instead of ~4.6 s on /cerca-lavoro-ticino/. That race
 * is invisible to the budget assertions, which judge the BEST of 3 runs, so
 * this check judges EVERY run.
 *
 * Usage: node scripts/ci/lighthouse-first-paint-order.mjs [--dir .lighthouseci]
 * Exit 0 = every checked run painted first; 1 = a run hid before painting or
 * lacks the mark; 2 = no LHR for a checked page (nothing was verified).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HIDE_MARK = 'ft:static-handoff-hide';
/**
 * Pages where the mount hides prerendered static HTML (route without
 * `staticOverlay`, static fallback present). `/` is NOT one of them: it ships
 * `#loading-shell`, so `hasStaticContent()` is false and nothing is hidden —
 * the mark would never be set there.
 */
export const CHECKED_PATHS = ['/cerca-lavoro-ticino/'];

/** One verdict per LHR of a checked page; `null` for pages this check ignores. */
export function evaluateLhr(lhr) {
  let pathname;
  try {
    pathname = new URL(lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl).pathname;
  } catch {
    return null;
  }
  if (!CHECKED_PATHS.includes(pathname)) return null;
  const metrics = lhr.audits?.metrics?.details?.items?.[0] ?? {};
  const fcp = metrics.observedFirstContentfulPaint;
  const marks = lhr.audits?.['user-timings']?.details?.items ?? [];
  const mark = marks.find((item) => item?.name === HIDE_MARK);
  const base = { pathname, formFactor: lhr.configSettings?.formFactor ?? 'unknown', fetchTime: lhr.fetchTime };
  if (typeof fcp !== 'number') return { ...base, ok: false, reason: 'observed FCP missing from the LHR' };
  if (!mark || typeof mark.startTime !== 'number') {
    return { ...base, fcp, ok: false, reason: `mark ${HIDE_MARK} missing (mount without the first-paint wait?)` };
  }
  const ok = fcp <= mark.startTime;
  return {
    ...base,
    fcp,
    hide: mark.startTime,
    ok,
    reason: ok ? 'static HTML painted before the hide' : 'static HTML hidden before its first paint',
  };
}

export function evaluateDir(dir) {
  const files = readdirSync(dir).filter((name) => /^(lhr-.*|.*\.report)\.json$/.test(name)).sort();
  const verdicts = [];
  for (const name of files) {
    const verdict = evaluateLhr(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    if (verdict) verdicts.push({ file: name, ...verdict });
  }
  const missingPaths = CHECKED_PATHS.filter((path) => !verdicts.some((v) => v.pathname === path));
  return { verdicts, missingPaths };
}

function main(argv) {
  const dirFlag = argv.indexOf('--dir');
  const dir = dirFlag >= 0 ? argv[dirFlag + 1] : '.lighthouseci';
  let result;
  try {
    result = evaluateDir(dir);
  } catch (error) {
    console.error(`::error title=First-paint order::cannot read LHRs in ${dir}: ${error.message}`);
    return 2;
  }
  for (const v of result.verdicts) {
    const timing = typeof v.hide === 'number'
      ? `FCP ${Math.round(v.fcp)} ms vs hide ${Math.round(v.hide)} ms`
      : `FCP ${typeof v.fcp === 'number' ? Math.round(v.fcp) : '?'} ms`;
    console.log(`${v.ok ? 'ok  ' : 'FAIL'} ${v.formFactor} ${v.pathname} ${timing} — ${v.reason} (${v.file})`);
  }
  const failed = result.verdicts.filter((v) => !v.ok);
  if (result.missingPaths.length) {
    console.error(`::error title=First-paint order::no LHR for ${result.missingPaths.join(', ')} in ${dir}`);
    return 2;
  }
  if (failed.length) {
    console.error(`::error title=First-paint order::${failed.length}/${result.verdicts.length} run(s) failed the first-paint order check (issue 11666)`);
    return 1;
  }
  console.log(`First-paint order ok on ${result.verdicts.length} run(s).`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
