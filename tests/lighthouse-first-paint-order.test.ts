import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  CHECKED_PATHS,
  HIDE_MARK,
  PRESERVE_MARK,
  REQUIRED_HANDOFF_MARK_BY_PATH,
  evaluateLhr,
} from '../scripts/ci/lighthouse-first-paint-order.mjs';
import {
  STATIC_HANDOFF_HIDE_MARK,
  STATIC_HANDOFF_PRESERVE_MARK,
} from '@/services/staticFallbackHandoff';

const ROOT = resolve(__dirname, '..');

/** Minimal LHR: observed FCP plus an optional handoff mark (values from the runner traces of run 37337515121). */
function lhr(path: string, fcp: number, mark?: number, markName = HIDE_MARK) {
  return {
    finalDisplayedUrl: `https://frontaliereticino.ch${path}`,
    configSettings: { formFactor: 'mobile' },
    audits: {
      metrics: { details: { items: [{ observedFirstContentfulPaint: fcp }] } },
      'user-timings': { details: { items: mark === undefined ? [] : [{ name: markName, startTime: mark }] } },
    },
  };
}

describe('lighthouse first-paint order check', () => {
  it('reads the same mark the mount sets', () => {
    expect(HIDE_MARK).toBe(STATIC_HANDOFF_HIDE_MARK);
    expect(PRESERVE_MARK).toBe(STATIC_HANDOFF_PRESERVE_MARK);
    expect(REQUIRED_HANDOFF_MARK_BY_PATH['/cerca-lavoro-ticino/']).toBe(PRESERVE_MARK);
  });

  it('requires the visibility-preserving handoff and checks its paint order', () => {
    expect(evaluateLhr(lhr('/cerca-lavoro-ticino/', 1300, 1310, PRESERVE_MARK))?.ok).toBe(true);
    expect(evaluateLhr(lhr('/cerca-lavoro-ticino/', 2349, 990))?.ok).toBe(false);
    expect(evaluateLhr(lhr('/cerca-lavoro-ticino/', 2349, 990, PRESERVE_MARK))?.ok).toBe(false);
  });

  it('rejects the three-run regression shape where FCP precedes a destructive hide', () => {
    for (const [fcp, hide] of [[2334, 2553], [2323, 2647], [2348, 2528]]) {
      const verdict = evaluateLhr(lhr('/cerca-lavoro-ticino/', fcp, hide));
      expect(verdict?.ok).toBe(false);
      expect(verdict?.reason).toContain(`required mark ${PRESERVE_MARK} missing`);
      expect(verdict?.reason).toContain(HIDE_MARK);
    }
  });

  it('rejects contradictory preserve and hide marks on the same navigation', () => {
    const report = lhr('/cerca-lavoro-ticino/', 1300, 1310, PRESERVE_MARK);
    report.audits['user-timings'].details.items.push({ name: HIDE_MARK, startTime: 1320 });
    expect(evaluateLhr(report)?.ok).toBe(false);
    expect(evaluateLhr(report)?.reason).toContain(`unexpected mark ${HIDE_MARK}`);
  });

  it('fails when the mark is missing on a checked page', () => {
    const verdict = evaluateLhr(lhr('/cerca-lavoro-ticino/', 2349));
    expect(verdict?.ok).toBe(false);
    expect(verdict?.reason).toContain(PRESERVE_MARK);
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
