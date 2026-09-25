/**
 * Source-prevention guard for the fleet-wide "Chromium binary not installed"
 * crawler-failure class.
 *
 * ~398/425 dedicated-crawler workflows reach a Playwright browser fallback
 * (enabled by default in the shared crawler) but `npm ci` does not install the
 * browser binary. Any `chromium.launch()` that is NOT routed through
 * `scripts/lib/ensure-chromium.mjs#launchChromium` will throw
 * "Executable doesn't exist" on those workflows and silently lose jobs (or open
 * a Crawler Failure issue). The reviewer kept catching this per-crawler — an
 * unbounded manual loop.
 *
 * This guard makes the gap impossible to merge: every browser launch must go
 * through the self-healing `launchChromium`, which installs Chromium on-demand.
 * If you add a new `chromium.launch(...)`, route it through `launchChromium`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test } from '../scripts/lib/ensure-chromium.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const HELPER_REL = 'scripts/lib/ensure-chromium.mjs';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.(mjs|js|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip line comments + block comments so we only match real code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** A file pulls in Playwright via static import, CJS require, or dynamic import(). */
function importsPlaywright(src: string): boolean {
  return /\b(?:from|import|require)\s*\(?\s*['"](?:playwright(?:-core)?|@playwright\/test)['"]/.test(src);
}

/**
 * Count raw Playwright browser launches in a source file (comments already
 * stripped). The literal `chromium.launch(` only catches the canonical binding
 * name — an aliased/destructured binding (`const { chromium: cr } = await
 * import('playwright'); cr.launch()`) would slip past it. So when the file
 * imports Playwright at all, ANY `.launch(` is a raw launch that must route
 * through launchChromium; otherwise we fall back to the literal `chromium.launch(`
 * (covers a `chromium` re-exported from a local module without a direct import).
 */
function rawLaunchCount(code: string): number {
  if (importsPlaywright(code)) {
    return (code.match(/\.\s*launch\s*\(/g) || []).length;
  }
  return (code.match(/\bchromium\s*\.\s*launch\s*\(/g) || []).length;
}

describe('playwright launch self-heal guard', () => {
  it('every Playwright browser launch in scripts/ routes through ensure-chromium.mjs#launchChromium', () => {
    const offenders: string[] = [];
    for (const file of walk(SCRIPTS)) {
      const rel = path.relative(ROOT, file);
      if (rel === HELPER_REL) continue; // the helper itself is the single allowed launch site
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = rawLaunchCount(code);
      if (count > 0) offenders.push(`${rel} (${count}×)`);
    }
    expect(
      offenders,
      `Raw chromium.launch() found — route these through launchChromium() from ${HELPER_REL} ` +
        `so the Chromium binary self-installs on crawler workflows that lack an explicit install step:\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('flags aliased/destructured Playwright launches the literal regex would miss', () => {
    // Literal binding — caught by both old and new logic.
    expect(rawLaunchCount(`import { chromium } from 'playwright';\nawait chromium.launch();`)).toBe(1);
    // Aliased import binding — bypasses the literal `chromium.launch(` check.
    expect(rawLaunchCount(`import { chromium as cr } from 'playwright';\nawait cr.launch();`)).toBe(1);
    // Destructured dynamic import with rename.
    expect(rawLaunchCount(`const { chromium: cr } = await import('playwright');\nawait cr.launch();`)).toBe(1);
    // Namespace dynamic import.
    expect(rawLaunchCount(`const pw = await import('playwright-core');\nawait pw.chromium.launch();`)).toBe(1);
    // @playwright/test specifier.
    expect(rawLaunchCount(`import { chromium } from '@playwright/test';\nawait chromium.launch();`)).toBe(1);
  });

  it('does not flag launches routed through launchChromium or non-Playwright code', () => {
    // The self-healing helper is the sanctioned launch path.
    expect(rawLaunchCount(`import { launchChromium } from './lib/ensure-chromium.mjs';\nawait launchChromium();`)).toBe(0);
    // A `.launch(` on an unrelated object in a file with no Playwright import.
    expect(rawLaunchCount(`const rocket = makeRocket();\nrocket.launch();`)).toBe(0);
  });

  it('classifies missing-browser errors as installable, real errors as not', () => {
    const { isMissingBrowserError } = __test;
    // Missing binary / missing system libs → install-and-retry
    expect(isMissingBrowserError(new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1234/chrome-linux/chrome"))).toBe(true);
    expect(isMissingBrowserError(new Error('Please run the following command to download new browsers: npx playwright install'))).toBe(true);
    expect(isMissingBrowserError(new Error('error while loading shared libraries: libnss3.so: cannot open shared object file'))).toBe(true);
    expect(isMissingBrowserError(new Error('Host system is missing dependencies to run browsers'))).toBe(true);
    // Real launch failures → must NOT trigger a pointless install (rethrow)
    expect(isMissingBrowserError(new Error('Target page, context or browser has been closed'))).toBe(false);
    expect(isMissingBrowserError(new Error('Out of memory'))).toBe(false);
    expect(isMissingBrowserError(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(false);
    expect(isMissingBrowserError(undefined)).toBe(false);
  });
});
