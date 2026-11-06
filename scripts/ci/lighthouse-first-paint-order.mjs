#!/usr/bin/env node
import { realpathSync } from 'node:fs';
/**
 * Lighthouse CI check: on the SPA-takeover pages the static HTML must paint
 * BEFORE the SPA handoff either hides it or intentionally keeps it visible
 * through the React takeover (issue 11666).
 *
 * index.tsx sets `ft:static-handoff-hide` before fading #root (which holds the
 * static HTML) to `opacity: 0`, or `ft:static-handoff-preserve` when the
 * already-visible JobBoard main stays in place. The bare JobBoard root MUST
 * use the preserve path: run 38814246437 proved that FCP can precede `hide` in
 * all three attempts while LCP still lands at 9.3-10.0 s because the painted
 * candidate is removed during the takeover. This check therefore verifies
 * both the route-specific handoff kind and its ordering on EVERY run.
 *
 * Usage: node scripts/ci/lighthouse-first-paint-order.mjs [--dir .lighthouseci]
 * Exit 0 = every checked run painted first; 1 = a run handed off before
 * painting or lacks the mark; 2 = no LHR for a checked page (nothing was
 * verified).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HIDE_MARK = 'ft:static-handoff-hide';
export const PRESERVE_MARK = 'ft:static-handoff-preserve';
/**
 * Pages where the mount hides prerendered static HTML (route without
 * `staticOverlay`, static fallback present). `/` is NOT one of them: it ships
 * `#loading-shell`, so `hasStaticContent()` is false and nothing is hidden —
 * the mark would never be set there.
 */
export const CHECKED_PATHS = ['/cerca-lavoro-ticino/']; // cathedral-allow: URL pubblica della pagina misurata da Lighthouse; script .mjs, non puo' importare SECTION_LEGACY_TI_PATH (TS)
export const REQUIRED_HANDOFF_MARK_BY_PATH = Object.freeze({
  '/cerca-lavoro-ticino/': PRESERVE_MARK, // cathedral-allow: same measured public URL as CHECKED_PATHS
});

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
  const requiredMarkName = REQUIRED_HANDOFF_MARK_BY_PATH[pathname];
  const handoffMarks = marks.filter((item) => item?.name === HIDE_MARK || item?.name === PRESERVE_MARK);
  const mark = handoffMarks.find((item) => item?.name === requiredMarkName);
  const base = { pathname, formFactor: lhr.configSettings?.formFactor ?? 'unknown', fetchTime: lhr.fetchTime };
  if (typeof fcp !== 'number') return { ...base, ok: false, reason: 'observed FCP missing from the LHR' };
  if (!mark || typeof mark.startTime !== 'number') {
    return {
      ...base,
      fcp,
      ok: false,
      reason: `required mark ${requiredMarkName} missing (observed: ${handoffMarks.map((item) => item.name).join(', ') || 'none'})`,
    };
  }
  const unexpectedMark = handoffMarks.find((item) => item?.name !== requiredMarkName);
  if (unexpectedMark) {
    return {
      ...base,
      fcp,
      handoff: mark.startTime,
      handoffKind: 'preserve',
      ok: false,
      reason: `unexpected mark ${unexpectedMark.name} observed alongside required ${requiredMarkName}`,
    };
  }
  const ok = fcp <= mark.startTime;
  return {
    ...base,
    fcp,
    handoff: mark.startTime,
    handoffKind: mark.name === PRESERVE_MARK ? 'preserve' : 'hide',
    ok,
    reason: ok
      ? mark.name === PRESERVE_MARK ? 'static HTML painted before the visibility-preserving handoff' : 'static HTML painted before the hide'
      : mark.name === PRESERVE_MARK ? 'static HTML handed off before its first paint' : 'static HTML hidden before its first paint',
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
    const timing = typeof v.handoff === 'number'
      ? `FCP ${Math.round(v.fcp)} ms vs ${v.handoffKind} ${Math.round(v.handoff)} ms`
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

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  process.exitCode = main(process.argv.slice(2));
}
