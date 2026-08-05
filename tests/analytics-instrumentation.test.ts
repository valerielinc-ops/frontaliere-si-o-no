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

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
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
    // lstat (not stat) so broken symlinks don't throw ENOENT — they're skipped.
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
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

describe('analytics.ts — app_error message truncation vs GA4 100-char cap (#4589)', () => {
  it('uses the bracket-stripped classifiableMessage (not the raw decoded message) for both error_message params', () => {
    // Anchored on `const classifiableMessage` (trackAppError's own declaration) rather than a bare
    // `log('exception', ...)` match — services/analytics.ts's legacy `trackError` wrapper also calls
    // `log('exception', { description, fatal });` earlier in the file with no error_message param at all.
    const trackAppErrorBody = analyticsSrc.match(/const classifiableMessage[\s\S]*?log\('app_error',[\s\S]*?\}\);/);
    expect(trackAppErrorBody).not.toBeNull();
    expect(trackAppErrorBody![0]).toMatch(/error_message:\s*truncate\(classifiableMessage,\s*100\)/);
    expect(trackAppErrorBody![0]).toMatch(/error_message:\s*truncate\(classifiableMessage,\s*200\)/);
  });

  it('strips a leading `[Component:X] ` diagnostic prefix before computing classifiableMessage', () => {
    expect(analyticsSrc).toMatch(
      /const classifiableMessage = decodedMessage\.replace\(\/\^\\\[\[\^\\\]\]\*\\\]\\s\*\/, ''\);/,
    );
  });

  it('the strip-then-truncate keeps an ISSUE_DENY_PATTERNS substring within GA4\'s ~100-char param cap for a realistic ErrorBoundary version-skew message (regression: #4589 filed a spurious backlog issue because it did not)', () => {
    // Mirrors ErrorBoundary.tsx's `[ErrorBoundary:${crashedComponent}] version_skew ${error.name}: ${msg}` shape
    // and services/analytics.ts's `classifiableMessage` regex — kept as a literal here (not re-imported) because
    // trackAppError is an internal arrow function with Firebase side effects, same testing convention as the
    // source-regex assertions above in this file.
    const raw =
      "[ErrorBoundary:Lazy] version_skew SyntaxError: The requested module './router.js' does not provide an export named 'isJobSlugMapReady'";
    const classifiable = raw.replace(/^\[[^\]]*\]\s*/, '');
    expect(classifiable.slice(0, 100)).toMatch(/does not provide an export named/);
    // Sanity check that this is a real regression guard: the UN-stripped message truncates BEFORE the
    // deny-list-relevant substring, which is exactly how #4589 slipped past scripts/lib/error-issue-sync.mjs.
    expect(raw.slice(0, 100)).not.toMatch(/does not provide an export named/);
  });

  it('the exception event `description` param uses the stripped classifiableMessage, not the raw annotated decodedMessage (regression: #5061)', () => {
    // scripts/analytics-report.mjs falls back to the `exception` event's
    // `description` custom dimension (customEvent:description) when the
    // `app_error`/`error_message` dimension isn't registered/available, and
    // app-error-issue-sync.mjs runs ISSUE_DENY_PATTERNS against whatever that
    // fallback yields. A `description` built from the FULL annotated
    // decodedMessage (`[type] [Component:Name] message`) reproduces the exact
    // #4589 truncation bug one level up: GA4's ~100-char ingestion cap slices
    // the deny-relevant substring off before app-error-issue-sync.mjs ever
    // sees it, so an already self-healed version-skew SyntaxError filed a
    // spurious backlog issue (#5061).
    const exceptionBlock = analyticsSrc.match(/const classifiableMessage[\s\S]*?log\('exception',[\s\S]*?\}\);/);
    expect(exceptionBlock).not.toBeNull();
    expect(exceptionBlock![0]).toMatch(/description:\s*truncate\(`\[\$\{type\}\]\s*\$\{classifiableMessage\}`/);
    expect(exceptionBlock![0]).not.toMatch(/description:\s*truncate\(`\[\$\{type\}\]\s*\$\{decodedMessage\}`/);
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

describe('analytics.ts — dead-click detector allowlist (#4304)', () => {
  it('treats native form controls and <summary> as actionable (not dead-click candidates)', () => {
    const block = analyticsSrc.match(/const actionable = target\.closest\(\s*[\s\S]*?\)\s*as HTMLElement \| null;/);
    expect(block).not.toBeNull();
    for (const tag of ['select', 'input', 'textarea', 'summary']) {
      expect(block![0]).toMatch(new RegExp(`\\b${tag}\\b`));
    }
  });

  it('excludes clicks inside the Funding Choices consent widget and Google Translate wrapper spans', () => {
    const block = analyticsSrc.match(/function detectDeadClick\(target: HTMLElement\): void \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\[class\*="fc-"\]/);
    expect(block![0]).toMatch(/google-anno/);
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
