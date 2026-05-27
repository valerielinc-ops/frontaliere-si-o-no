/**
 * E1 — Analytics instrumentation regression tests.
 *
 * Why this file exists: PostHog dashboards were 100% null on the `step`,
 * `action`, `endpoint`, `cta_id` properties because callsites and emitters
 * were forwarding GA4-legacy names (`step_name`, `api_endpoint`) instead of
 * the canonical PostHog keys. These source-level regex asserts are the tripwire
 * that stops the regression reoccurring.
 *
 * Rules enforced:
 *   1. analytics.ts `funnel_step` payload must include `step:` and `funnel:`.
 *   2. analytics.ts `app_error` payload must include `endpoint:` and `status:`.
 *   3. analytics.ts `ui_interaction` payload must include `cta_id:`.
 *   4. analytics.ts exposes a `trackCtaClick` helper and its payload includes
 *      `cta_id:` and `target_url:`.
 *   5. errorReporter.ts always forwards a non-empty `apiEndpoint` when calling
 *      `trackAppError` (fallback to `context`) so PostHog `endpoint` is never null.
 *   6. Every callsite of `trackFunnelStep(` in app code passes a step label as
 *      first positional argument (no bare `trackFunnelStep()` calls).
 *   7. Every callsite of `trackCtaClick(` passes a cta id as first argument.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');

const analyticsSrc = readFileSync(
  resolve(repoRoot, 'services/analytics.ts'),
  'utf8',
);
const errorReporterSrc = readFileSync(
  resolve(repoRoot, 'services/errorReporter.ts'),
  'utf8',
);

/** Recursively collect .ts/.tsx files from a directory, skipping node_modules/tests. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'tests') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const appFiles = collectSourceFiles(repoRoot).filter((f) =>
  /\/(components|hooks|services|App\.tsx)/.test(f),
);

describe('analytics.ts — funnel_step payload', () => {
  it('emits `step:` in the funnel_step log payload', () => {
    // Match the trackFunnelStep body
    const funnelBlock = analyticsSrc.match(/trackFunnelStep:[\s\S]*?log\('funnel_step',[\s\S]*?\);/);
    expect(funnelBlock).not.toBeNull();
    expect(funnelBlock![0]).toMatch(/\bstep,/);
    // Legacy alias for GA4 reports still present
    expect(funnelBlock![0]).toMatch(/step_name:\s*step/);
  });

  it('emits `funnel:` in the funnel_step log payload', () => {
    const funnelBlock = analyticsSrc.match(/trackFunnelStep:[\s\S]*?log\('funnel_step',[\s\S]*?\);/);
    expect(funnelBlock).not.toBeNull();
    expect(funnelBlock![0]).toMatch(/\bfunnel,/);
    expect(funnelBlock![0]).toMatch(/funnel_name:\s*funnel/);
  });
});

describe('analytics.ts — app_error payload', () => {
  it('emits `endpoint:` in the app_error log payload', () => {
    const block = analyticsSrc.match(/log\('app_error',[\s\S]*?\}\);/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\bendpoint:\s*truncate\(/);
  });

  it('emits `status:` in the app_error log payload', () => {
    const block = analyticsSrc.match(/log\('app_error',[\s\S]*?\}\);/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\bstatus:\s*info\.statusCode/);
  });

  it('emits `method:` in the app_error log payload', () => {
    const block = analyticsSrc.match(/log\('app_error',[\s\S]*?\}\);/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\bmethod:\s*truncate\(info\.apiMethod/);
  });
});

describe('analytics.ts — ui_interaction payload', () => {
  it('emits `cta_id:` in the ui_interaction log payload', () => {
    const block = analyticsSrc.match(/trackUIInteraction:[\s\S]*?log\('ui_interaction',[\s\S]*?\}\);/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/cta_id:/);
  });
});

describe('analytics.ts — trackCtaClick helper', () => {
  it('exposes a `trackCtaClick` method on Analytics', () => {
    expect(analyticsSrc).toMatch(/trackCtaClick:\s*\(/);
  });

  it('emits `cta_id:` and `target_url:` in the cta_click log payload', () => {
    const block = analyticsSrc.match(/trackCtaClick:[\s\S]*?log\('cta_click',[\s\S]*?\}\);/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/cta_id:\s*ctaId/);
    expect(block![0]).toMatch(/target_url:\s*truncate\(details\.targetUrl/);
  });

  it('emits all five utm_* keys in the cta_click log payload', () => {
    const block = analyticsSrc.match(/trackCtaClick:[\s\S]*?log\('cta_click',[\s\S]*?\}\);/);
    expect(block).not.toBeNull();
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      expect(block![0]).toMatch(new RegExp(`${key}:`));
    }
  });
});

describe('analytics.ts — job_auth funnel aliasing', () => {
  it('trackJobAuthFunnel emits both `step` and `funnel: \'job_auth\'`', () => {
    const block = analyticsSrc.match(/trackJobAuthFunnel:[\s\S]*?\},\n/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/step:\s*action/);
    expect(block![0]).toMatch(/funnel:\s*'job_auth'/);
  });
});

describe('errorReporter.ts — api_error fallbacks', () => {
  it('always resolves an `apiEndpoint` (falls back to `context`) when forwarding to trackAppError', () => {
    expect(errorReporterSrc).toMatch(/const resolvedEndpoint\s*=\s*options\.apiEndpoint\s*\|\|\s*context/);
  });

  it('always resolves a `statusCode` (falls back to 0) when forwarding to trackAppError', () => {
    expect(errorReporterSrc).toMatch(/const resolvedStatus\s*=\s*options\.statusCode\s*\?\?\s*0/);
  });

  it('forwards the resolved endpoint + status into Analytics.trackAppError', () => {
    const block = errorReporterSrc.match(/Analytics\.trackAppError\([\s\S]*?\}\);/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/apiEndpoint:\s*resolvedEndpoint/);
    expect(block![0]).toMatch(/statusCode:\s*resolvedStatus/);
  });
});

describe('callsite hygiene — no empty trackFunnelStep()', () => {
  it('every `trackFunnelStep(` callsite in app code passes a step argument', () => {
    const emptyCalls: string[] = [];
    for (const file of appFiles) {
      const src = readFileSync(file, 'utf8');
      // A trackFunnelStep call with nothing (or only whitespace) inside the parens
      // is a bug — PostHog will record step=null. The regex matches `(` optionally
      // followed by whitespace then `)`.
      if (/\btrackFunnelStep\(\s*\)/.test(src)) {
        emptyCalls.push(file);
      }
    }
    expect(emptyCalls).toEqual([]);
  });

  it('every `trackCtaClick(` callsite in app code passes a ctaId argument', () => {
    const emptyCalls: string[] = [];
    for (const file of appFiles) {
      const src = readFileSync(file, 'utf8');
      if (/\btrackCtaClick\(\s*\)/.test(src)) {
        emptyCalls.push(file);
      }
    }
    expect(emptyCalls).toEqual([]);
  });
});
