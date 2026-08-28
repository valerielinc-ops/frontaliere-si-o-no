/**
 * The closer must run when a workflow goes green, not only on the hourly cron.
 * Wiring `--resolve` into every opener is the 300-file churn this reconciler
 * exists to avoid; `workflow_run` is that close-on-green for every current and
 * future writer, including the three GH013 recoveries (#6627/#6630/#6633)
 * that stayed open until the delayed :17 cron.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const YML = resolve(import.meta.dirname, '../.github/workflows/close-recovered-failure-issues.yml');
const raw = readFileSync(YML, 'utf8');
const wf = parse(raw);

describe('close-recovered-failure-issues.yml closes on the green run itself', () => {
  it('listens for any repo workflow completing, not a named allowlist', () => {
    expect(wf.on.workflow_run, 'workflow_run trigger must exist').toBeTruthy();
    expect(wf.on.workflow_run.types).toEqual(['completed']);
    // An allowlist would miss the next scheduled writer the same way the
    // copypaste `--resolve` would. Omit `workflows:` so coverage is total.
    expect(wf.on.workflow_run.workflows).toBeUndefined();
  });

  it('keeps the hourly cron as the safety net', () => {
    expect(wf.on.schedule).toEqual([{ cron: '17 * * * *' }]);
    expect(wf.on.workflow_dispatch).toBeTruthy();
  });

  it('on workflow_run, only a successful main run that is not this closer starts the job', () => {
    const jobIf = String(wf.jobs.reconcile.if);
    expect(jobIf).toContain("github.event_name != 'workflow_run'");
    expect(jobIf).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(jobIf).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(jobIf).toContain("github.event.workflow_run.name != 'Close Recovered Failure Issues'");
  });

  it('collapses a burst of green writers onto one reconcile', () => {
    expect(wf.concurrency.group).toBe('close-recovered-failure-issues');
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
  });

  it('still invokes the shipped closer script (not a reimplementation)', () => {
    const step = (wf.jobs.reconcile.steps as Array<{ name?: string; run?: string }>).find((s) =>
      /Close recovered failure issues/.test(String(s.name || '')),
    );
    expect(step?.run).toContain('scripts/ci/close-recovered-failure-issues.mjs');
  });
});
