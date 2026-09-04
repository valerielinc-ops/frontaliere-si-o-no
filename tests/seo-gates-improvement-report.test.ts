import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import {
  isNiceToHaveGate,
  partitionImprovements,
  renderIssueBody,
  renderAdvisorySummary,
} from '../scripts/ci/seo-gates-improvement-report.mjs';
import { GATES } from '../scripts/cathedral-seo-gates-check.mjs';

/**
 * Guardrail for issue #7354.
 *
 * `cathedral-seo-gates-check.yml` filed `chore(seo-gates): possible rebaseline
 * opportunity` whenever a gate measured better than its committed baseline.
 * For every gate it can report, that request is one the owner already refused:
 * VISION.md driver D9 (owner instruction 2026-08-25, given on issue #5983 —
 * the same issue, naming these same gates and numbers) forbids tightening the
 * baseline of a "nice-to-have" gate when the measurement improves, and says
 * such an issue "si chiude senza toccare il file di baseline, citando questo
 * driver". Mirrored as the second delimited exception to AGENTS.md #1.
 *
 * The issue was therefore unactionable the moment it was filed, and — with a
 * stable dedup title — it came back unchanged (#5983 on 2026-08-17, #7354 on
 * 2026-09-04), each time routed to the autonomous fixer, which spent a run
 * rediscovering D9 and closed it `needs-human`. These tests pin the filter
 * that stops it at the source, and pin that it is a filter and not a mute:
 * a gate outside `QUALITY_GATES` still gets its issue, and regressions are
 * untouched.
 */

describe('isNiceToHaveGate', () => {
  it('covers the standalone audits by their `audit:<name>` key', () => {
    expect(isNiceToHaveGate('max-bfs-depth')).toBe(true);
    expect(isNiceToHaveGate('orphan-sitemap-pages')).toBe(true);
  });

  it('covers the audit:all sub-auditors by their `audit:all/<name>` key', () => {
    expect(isNiceToHaveGate('text-html-ratio')).toBe(true);
    expect(isNiceToHaveGate('title-length')).toBe(true);
    expect(isNiceToHaveGate('title-no-disambig-hash')).toBe(true);
  });

  it('leaves a gate Google actually requires outside D9', () => {
    // Zero-tolerance structured-data gate: not in QUALITY_GATES, so an
    // improvement on it still deserves an issue.
    expect(isNiceToHaveGate('image-object-license')).toBe(false);
    expect(isNiceToHaveGate('some-future-hard-gate')).toBe(false);
  });

  it('classifies every cathedral gate the check script declares', () => {
    // Fails loudly if a gate is renamed on one side only — the failure mode
    // that would silently re-open the treadmill.
    const classified = GATES.map((g) => [g.name, isNiceToHaveGate(g.name)]);
    expect(Object.fromEntries(classified)).toEqual({
      'text-html-ratio': true,
      'orphan-sitemap-pages': true,
      'image-object-license': false,
      'max-bfs-depth': true,
      'title-length': true,
      'title-no-disambig-hash': true,
    });
  });
});

describe('partitionImprovements', () => {
  const verdict = {
    gates: [
      { name: 'text-html-ratio', status: 'improved', current: 2618, baseline: 6912, delta: -4294 },
      { name: 'max-bfs-depth', status: 'improved', current: 13245, baseline: 26398, delta: -13153 },
      { name: 'image-object-license', status: 'improved', current: 0, baseline: 3, delta: -3 },
      { name: 'title-length', status: 'pass' },
      { name: 'orphan-sitemap-pages', status: 'regressed' },
    ],
  };

  it('routes the two gates of #7354 to the job summary, not to an issue', () => {
    const { advisory, actionable } = partitionImprovements(verdict);
    expect(advisory.map((g) => g.name)).toEqual(['text-html-ratio', 'max-bfs-depth']);
    expect(actionable.map((g) => g.name)).toEqual(['image-object-license']);
  });

  it('never looks at a gate that did not improve', () => {
    const { advisory, actionable } = partitionImprovements(verdict);
    const seen = [...advisory, ...actionable].map((g) => g.name);
    expect(seen).not.toContain('title-length');
    expect(seen).not.toContain('orphan-sitemap-pages');
  });

  it('is empty on a verdict with no improvements', () => {
    const { advisory, actionable } = partitionImprovements({ gates: [{ status: 'pass' }] });
    expect(advisory).toEqual([]);
    expect(actionable).toEqual([]);
  });
});

describe('renderIssueBody', () => {
  it('says why the gate is exempt from D9, so the fixer does not re-litigate it', () => {
    const body = renderIssueBody(
      [
        {
          name: 'image-object-license',
          current: 0,
          baseline: 3,
          delta: -3,
          rebaselineCmd: 'npm run audit:image-object-license:rebaseline',
          notes: 'Must be 0.',
        },
      ],
      'https://example.test/run/1',
    );
    expect(body).toContain('D9 does NOT cover');
    expect(body).toContain('`image-object-license`');
    expect(body).toContain('https://example.test/run/1');
  });
});

describe('renderAdvisorySummary', () => {
  it('records the improvement with the driver that explains the inaction', () => {
    const summary = renderAdvisorySummary([
      { name: 'text-html-ratio', current: 2618, baseline: 6912, delta: -4294 },
    ]);
    expect(summary).toContain('VISION.md D9');
    expect(summary).toContain('| text-html-ratio | 2618 | 6912 | -4294 |');
  });

  it('renders nothing when there is nothing to record', () => {
    expect(renderAdvisorySummary([])).toBe('');
  });
});

describe('cathedral-seo-gates-check.yml wiring', () => {
  const workflow = YAML.parse(
    readFileSync(join(process.cwd(), '.github/workflows/cathedral-seo-gates-check.yml'), 'utf8'),
  );
  const steps = workflow.jobs.check.steps as Array<Record<string, unknown>>;
  const improvements = steps.find((s) => s.id === 'improvements')!;

  it('routes the improvement path through the partitioning script', () => {
    expect(String(improvements.run)).toContain('scripts/ci/seo-gates-improvement-report.mjs');
  });

  it('files the issue only when the script produced a body', () => {
    const run = String(improvements.run);
    expect(run).toContain('rm -f /tmp/issue-body.md');
    expect(run).toMatch(/if \[ ! -f \/tmp\/issue-body\.md \]; then[\s\S]*?exit 0/);
    // The creator call must come after that guard, never before it.
    expect(run.indexOf('github-issue-creator.mjs')).toBeGreaterThan(
      run.indexOf('if [ ! -f /tmp/issue-body.md ]'),
    );
  });

  it('keeps the regression path intact — D9 is about improvements only', () => {
    const failgate = steps.find((s) => s.id === 'failgate')!;
    expect(String(failgate.if)).toBe("steps.gates.outcome == 'failure'");
    expect(String(failgate.run)).toContain('do NOT widen the baseline');
    expect(String(failgate.run)).toContain('github-issue-creator.mjs');
  });

  it('still never mutates a baseline', () => {
    const runs = steps.map((s) => String(s.run ?? '')).join('\n');
    expect(runs).not.toContain(':rebaseline');
    expect(workflow.permissions.contents).toBe('read');
  });
});
