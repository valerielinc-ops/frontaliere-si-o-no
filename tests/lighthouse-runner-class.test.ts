import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { collectRows, renderMarkdown, rowFromLhr } from '../scripts/ci/lighthouse-runner-class.mjs';

const ROOT = resolve(__dirname, '..');

/** Minimal LHR with the fields the observer reads (values from the 2026-10-04/05 production runs). */
function lhr(url: string, benchmarkIndex: number, firstPaint: number, dcl: number, fcp: number) {
  return {
    finalDisplayedUrl: url,
    fetchTime: '2026-10-05T11:30:23.625Z',
    configSettings: { formFactor: 'mobile' },
    environment: { benchmarkIndex },
    audits: {
      metrics: { details: { items: [{ observedFirstPaint: firstPaint, observedDomContentLoaded: dcl }] } },
      'first-contentful-paint': { numericValue: fcp },
    },
  };
}

describe('lighthouse runner-class observer', () => {
  it('marks a run slow when the first paint comes after DOMContentLoaded', () => {
    const slow = rowFromLhr(lhr('https://frontaliereticino.ch/cerca-lavoro-ticino/', 2445, 2361, 722, 10192));
    const fast = rowFromLhr(lhr('https://frontaliereticino.ch/cerca-lavoro-ticino/', 3434, 286, 317, 4660));
    expect(slow).toMatchObject({ path: '/cerca-lavoro-ticino/', benchmarkIndex: 2445, mode: 'slow' });
    expect(fast).toMatchObject({ benchmarkIndex: 3434, mode: 'fast' });
  });

  it('reports unknown instead of guessing when the observed metrics are missing', () => {
    const row = rowFromLhr({ finalUrl: 'https://frontaliereticino.ch/', audits: {} });
    expect(row?.mode).toBe('unknown');
    expect(rowFromLhr({ notAnLhr: true })).toBeNull();
  });

  describe('directory scan', () => {
    let dir = '';
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

    it('reads LHCI and Lighthouse CLI file names and ignores traces', () => {
      dir = mkdtempSync(join(tmpdir(), 'lh-runner-class-'));
      writeFileSync(join(dir, 'lhr-1.json'), JSON.stringify(lhr('https://frontaliereticino.ch/', 2448, 1301, 588, 4765)));
      writeFileSync(join(dir, 'cerca-lavoro-ticino-1.report.json'), JSON.stringify(lhr('https://frontaliereticino.ch/cerca-lavoro-ticino/', 2445, 2361, 722, 10192)));
      writeFileSync(join(dir, 'cerca-lavoro-ticino-1.report-0.trace.json'), JSON.stringify({ traceEvents: [] }));

      const rows = collectRows(dir);
      expect(rows.map((r: { path: string }) => r.path)).toEqual(['/', '/cerca-lavoro-ticino/']);
      const markdown = renderMarkdown(rows);
      expect(markdown).toContain('| /cerca-lavoro-ticino/ | mobile | 2445 | 2361 | 722 | slow | 10192 |');
      expect(markdown).toContain(`${rows.length}/${rows.length} run(s) in slow mode`);
    });
  });
});

describe('lighthouse-ci.yml wiring', () => {
  const steps = (YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/lighthouse-ci.yml'), 'utf8'))
    .jobs.lighthouse.steps as Array<{ id?: string; name?: string; run?: string; 'continue-on-error'?: boolean }>);
  const indexOf = (id: string) => steps.findIndex((s) => s.id === id);

  it('records the runner class after the first attempt and before any retry empties .lighthouseci/', () => {
    const observer = indexOf('runner-class');
    expect(observer).toBeGreaterThan(indexOf('lhci'));
    expect(observer).toBeLessThan(indexOf('lhci-retry'));
    expect(steps[observer]['continue-on-error']).toBe(true);
    expect(steps[observer].run).toContain('scripts/ci/lighthouse-runner-class.mjs --dir .lighthouseci');
  });

  it('puts the runner-class table in the regression issue body', () => {
    const open = steps.find((s) => s.name === 'Open issue on regression');
    expect(open?.run).toContain('lighthouse-runner-class.md');
    expect(open?.run).toContain('${RUNNER_CLASS}');
  });
});
