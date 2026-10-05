import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { CHECKED_PATHS, HIDE_MARK, evaluateLhr } from '../scripts/ci/lighthouse-first-paint-order.mjs';
import { STATIC_HANDOFF_HIDE_MARK } from '@/services/staticFallbackHandoff';

const ROOT = resolve(__dirname, '..');

/** Minimal LHR: observed FCP plus an optional hide mark (values from the runner traces of run 37337515121). */
function lhr(path: string, fcp: number, hide?: number) {
  return {
    finalDisplayedUrl: `https://frontaliereticino.ch${path}`,
    configSettings: { formFactor: 'mobile' },
    audits: {
      metrics: { details: { items: [{ observedFirstContentfulPaint: fcp }] } },
      'user-timings': { details: { items: hide === undefined ? [] : [{ name: HIDE_MARK, startTime: hide }] } },
    },
  };
}

describe('lighthouse first-paint order check', () => {
  it('reads the same mark the mount sets', () => {
    expect(HIDE_MARK).toBe(STATIC_HANDOFF_HIDE_MARK);
  });

  it('passes when the static HTML painted before the hide and fails when it painted after', () => {
    expect(evaluateLhr(lhr('/cerca-lavoro-ticino/', 1300, 1310))?.ok).toBe(true);
    expect(evaluateLhr(lhr('/cerca-lavoro-ticino/', 2349, 990))?.ok).toBe(false);
  });

  it('fails when the mark is missing on a checked page', () => {
    const verdict = evaluateLhr(lhr('/cerca-lavoro-ticino/', 2349));
    expect(verdict?.ok).toBe(false);
    expect(verdict?.reason).toContain(HIDE_MARK);
  });

  it('ignores pages whose mount never hides static HTML (the homepage ships #loading-shell)', () => {
    expect(CHECKED_PATHS).not.toContain('/');
    expect(evaluateLhr(lhr('/', 1301))).toBeNull();
  });

  it('runs in lighthouse-ci.yml after the first attempt, before a retry empties .lighthouseci/, and never gates', () => {
    const steps = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/lighthouse-ci.yml'), 'utf8'))
      .jobs.lighthouse.steps as Array<{ id?: string; run?: string; 'continue-on-error'?: boolean }>;
    const at = (id: string) => steps.findIndex((s) => s.id === id);
    const check = at('first-paint-order');
    expect(check).toBeGreaterThan(at('lhci'));
    expect(check).toBeLessThan(at('lhci-retry'));
    expect(steps[check]['continue-on-error']).toBe(true);
    expect(steps[check].run).toContain('scripts/ci/lighthouse-first-paint-order.mjs --dir .lighthouseci');
  });
});
