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

describe('playwright launch self-heal guard', () => {
  it('every chromium.launch() in scripts/ routes through ensure-chromium.mjs#launchChromium', () => {
    const offenders: string[] = [];
    for (const file of walk(SCRIPTS)) {
      const rel = path.relative(ROOT, file);
      if (rel === HELPER_REL) continue; // the helper itself is the single allowed launch site
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const matches = code.match(/\bchromium\s*\.\s*launch\s*\(/g);
      if (matches) offenders.push(`${rel} (${matches.length}×)`);
    }
    expect(
      offenders,
      `Raw chromium.launch() found — route these through launchChromium() from ${HELPER_REL} ` +
        `so the Chromium binary self-installs on crawler workflows that lack an explicit install step:\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
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
