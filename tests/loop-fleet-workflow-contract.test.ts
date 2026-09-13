import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowDir = path.resolve('.github/workflows');
const loopWorkflows = [
  'loop-l0-data-truth.yml',
  'loop-l1-reliability.yml',
  'loop-l2-demand-utility.yml',
  'loop-l3-job-quality.yml',
  'loop-l4-alert-return.yml',
  'loop-l5-decision-moments.yml',
  'loop-l6-content-factuality.yml',
  'loop-l7-experiment-allocator.yml',
  'loop-l8-revenue-attribution.yml',
  'loop-l9-employer-activation.yml',
  'loop-l10-fleet-control.yml',
  'technical-operations-supervisor.yml',
];

describe('loop fleet workflow contract', () => {
  it('records canonical evidence for every loop with a read-only contents token', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('record-loop-fleet-evidence.mjs');
      expect(source, name).toContain('--registry data/loop-fleet/loop-registry.json');
      expect(source, name).toContain('retention-days: 90');
      expect(source, name).toContain('contents: read');
      expect(source, name).not.toMatch(/contents:\s*write/u);
    }
  });

  it('uploads lifecycle evidence for every loop', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const uploadsWholeDirectory = /path:\s+\$\{\{\s*runner\.temp\s*\}\}\/loop-fleet-[^/]+\/\s*$/mu.test(source);
      expect(uploadsWholeDirectory || source.includes('lifecycle-events.jsonl'), name).toBe(true);
    }
  });

  it('keeps the status roll-up read-only', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-status.yml'), 'utf8');
    expect(source).toContain('actions: read');
    expect(source).toContain('--strict');
    expect(source).toContain('inputs.strict');
    expect(source).not.toMatch(/issues:\s*write|contents:\s*write|pull-requests:\s*write/u);
  });

  it('persists only through a reviewed branch and PR', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger.yml'), 'utf8');
    expect(source).toContain('workflow_run:');
    expect(source).toContain('merge-loop-fleet-ledger.mjs');
    expect(source).toContain('--ledger-dir data/loop-fleet/ledger');
    expect(source).toContain('git checkout -b "$branch"');
    expect(source).toContain('gh pr create');
    expect(source).toContain('Validate source run provenance');
    expect(source).toContain('source_branch');
    expect(source).toContain("!= 'main'");
    expect(source).not.toMatch(/contents:\s*write/u);
    expect(source).toContain('Direct writes to main');
    expect(source).toContain('lifecycle-events.jsonl');
  });

  it('keeps the automatic ledger recovery probe bounded and unable to write repository content', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger-reconcile.yml'), 'utf8');
    expect(source).toContain("cron: '*/20 * * * *'");
    expect(source).toContain('actions: write');
    expect(source).toContain('contents: read');
    expect(source).not.toMatch(/contents:\s*write/u);
    expect(source).not.toMatch(/pull-requests:\s*write/u);
    expect(source).toContain('LOOP_FLEET_RECONCILE_MAX_DISPATCHES: \'3\'');
    expect(source).toContain('loop-fleet-ledger-reconcile.mjs');
  });
});
