/**
 * `workflow_run` without a `workflows:` allowlist looks like "listen to any
 * workflow completing", but GitHub Actions rejects that as an INVALID
 * workflow file — not a filtered/no-op trigger, the whole file stops
 * parsing (actionlint: "no workflow is configured for 'workflow_run' event").
 * #6656 added it on 2026-08-28 to close recovery issues faster than the
 * hourly cron; it silently killed every trigger in this file (cron included)
 * for ~2.5 days before being reverted. This test locks in the reverted,
 * working shape so `workflow_run` doesn't come back the same way.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const YML = resolve(import.meta.dirname, '../.github/workflows/close-recovered-failure-issues.yml');
const raw = readFileSync(YML, 'utf8');
const wf = parse(raw);

describe('close-recovered-failure-issues.yml stays parseable by GitHub Actions', () => {
  it('does not use workflow_run without an explicit workflows: allowlist', () => {
    // Either absent, or present with a non-empty `workflows:` list — both are
    // valid. `workflow_run` with no `workflows:` is the one shape GitHub
    // rejects outright.
    if (wf.on.workflow_run) {
      expect(
        Array.isArray(wf.on.workflow_run.workflows) && wf.on.workflow_run.workflows.length > 0,
        'workflow_run without workflows: is an invalid workflow file on GitHub Actions',
      ).toBe(true);
    }
  });

  it('relies on the hourly cron + manual dispatch as the only triggers', () => {
    expect(wf.on.schedule).toEqual([{ cron: '17 * * * *' }]);
    expect(wf.on.workflow_dispatch).toBeTruthy();
  });

  it('does not cancel-in-progress (single hourly run, nothing to collapse)', () => {
    expect(wf.concurrency.group).toBe('close-recovered-failure-issues');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  it('still invokes the shipped closer script (not a reimplementation)', () => {
    const step = (wf.jobs.reconcile.steps as Array<{ name?: string; run?: string }>).find((s) =>
      /close-recovered-failure-issues\.mjs/.test(String(s.run || '')),
    );
    expect(step?.run).toContain('scripts/ci/close-recovered-failure-issues.mjs');
  });
});
