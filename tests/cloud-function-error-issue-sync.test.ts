/**
 * Cloud Functions error monitor (scripts/lib/cloud-function-logs.mjs,
 * scripts/cloud-function-error-issue-sync.mjs, .github/workflows/cloud-function-errors.yml).
 *
 * Pinned: per-function counting over both function generations, pagination and
 * the page-cap lower bound, 403 naming the missing role, no payload in the
 * issue body, and a reconcile that never closes on an unreadable or capped read.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  alertEntries,
  buildIssueBody,
  functionFromIssue,
  functionReconcile,
  main,
  titleFor,
} from '../scripts/cloud-function-error-issue-sync.mjs';
import { MAX_PAGES, buildFilter, fetchFunctionErrors, functionNameOf } from '../scripts/lib/cloud-function-logs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/cloud-function-errors.yml'), 'utf8');
const now = new Date('2026-10-15T12:00:00Z');

const entry = (name: string, type = 'cloud_function', ts = '2026-10-15T11:00:00Z', key = 'function_name') => ({
  timestamp: ts,
  textPayload: 'payload with user@example.test must never be copied',
  resource: { type, labels: { [key]: name } },
});

describe('cloud logging reader', () => {
  it('filters severity, both function generations and the window', () => {
    const f = buildFilter({ since: new Date('2026-10-14T12:00:00Z') });
    expect(f).toContain('severity>=ERROR');
    expect(f).toContain('resource.type="cloud_function"');
    expect(f).toContain('resource.type="cloud_run_revision"');
    expect(f).toContain('2026-10-14T12:00:00.000Z');
  });

  it('names functions from 1st and 2nd gen labels and rejects unsafe names', () => {
    expect(functionNameOf(entry('sendEmail'))).toBe('sendEmail');
    expect(functionNameOf(entry('send-email', 'cloud_run_revision', 'x', 'service_name'))).toBe('send-email');
    expect(functionNameOf(entry('bad name\n## injected'))).toBeNull();
    expect(functionNameOf({})).toBeNull();
  });

  it('counts per function across pages, latest timestamp, sorted by errors', async () => {
    const pages = [
      { entries: [entry('a'), entry('b', 'cloud_function', '2026-10-15T10:00:00Z'), entry('a', 'cloud_function', '2026-10-15T11:30:00Z')], nextPageToken: 'p2' },
      { entries: [entry('a'), entry('c', 'cloud_run_revision', 'x', 'service_name')] },
    ];
    const f = vi.fn(async () => Response.json(pages.shift()));
    const r = await fetchFunctionErrors({ token: 't', now, fetchImpl: f as unknown as typeof fetch });
    expect(r.complete).toBe(true);
    expect(r.entries).toBe(5);
    expect(r.functions.map((x: { name: string; errors: number }) => [x.name, x.errors])).toEqual([['a', 3], ['b', 1], ['c', 1]]);
    expect(r.functions[0].latestAt).toBe('2026-10-15T11:30:00Z');
  });

  it('marks the read incomplete when the page cap is hit', async () => {
    const f = vi.fn(async () => Response.json({ entries: [entry('a')], nextPageToken: 'more' }));
    const r = await fetchFunctionErrors({ token: 't', now, fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(MAX_PAGES);
    expect(r.complete).toBe(false);
  });

  it('names the missing role on 403', async () => {
    const f = vi.fn(async () => new Response('denied', { status: 403 }));
    await expect(fetchFunctionErrors({ token: 't', now, fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/roles\/logging\.viewer/);
  });
});

describe('issue sync', () => {
  const measurement = (over = {}) => ({
    projectId: 'p',
    window: { hours: 24, from: '2026-10-14T12:00:00.000Z', to: '2026-10-15T12:00:00.000Z' },
    functions: [{ name: 'a', errors: 9, latestAt: '2026-10-15T11:00:00Z' }, { name: 'b', errors: 2, latestAt: '' }],
    entries: 11,
    complete: true,
    minErrors: 5,
    ...over,
  });

  it('mints only above the threshold, with a stable title and no payload', () => {
    const m = measurement();
    expect(alertEntries(m, 5).map((e: { name: string }) => e.name)).toEqual(['a']);
    expect(titleFor(m.functions[0])).toBe('Cloud Function error: a');
    expect(functionFromIssue({ title: 'Cloud Function error: a' })).toBe('a');
    expect(functionFromIssue({ title: 'Other' })).toBeNull();
    const body = buildIssueBody(m.functions[0], m);
    expect(body).toContain('## Scheda');
    expect(body).toContain('Log payloads are withheld');
    expect(body).not.toMatch(/user@example/);
  });

  it('reconcile: clean below threshold, defect above, never clean on an incomplete read', () => {
    const rec = (m: object) => functionReconcile(m as never);
    expect(rec(measurement()).verdictFor({ title: 'Cloud Function error: b' })).toMatchObject({ clean: true, complete: true });
    expect(rec(measurement()).verdictFor({ title: 'Cloud Function error: a' })).toMatchObject({ clean: false, complete: true });
    expect(rec(measurement()).verdictFor({ title: 'Cloud Function error: gone' })).toMatchObject({ clean: true, complete: true });
    expect(rec(measurement({ complete: false })).verdictFor({ title: 'Cloud Function error: b' })).toMatchObject({ clean: false, complete: false });
    expect(rec(measurement()).verdictFor({ title: 'Unrelated' })).toMatchObject({ complete: false });
  });

  it('exits 1 and writes nothing when Cloud Logging cannot be read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await main({
      dryRun: true,
      getToken: async () => 't',
      fetchImpl: (async () => new Response('no', { status: 403 })) as unknown as typeof fetch,
      env: {},
    });
    err.mockRestore();
    expect(out).toMatchObject({ measurement: null, exitCode: 1 });
  });

  it('dry-run prints the issue for a failing function and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const batch = { entries: Array.from({ length: 6 }, () => entry('a')) };
    const out = await main({
      dryRun: true,
      getToken: async () => 't',
      fetchImpl: (async () => Response.json(batch)) as unknown as typeof fetch,
      env: {},
    });
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(out.exitCode).toBe(0);
    expect(printed).toContain('Cloud Function error: a');
  });
});

describe('workflow', () => {
  it('runs hourly, fails red when it cannot measure and never uses the workflow token for issues', () => {
    expect(workflow).toContain("cron: '23 * * * *'");
    expect(workflow).toContain('node scripts/cloud-function-error-issue-sync.mjs');
    expect(workflow).toContain('GITHUB_PAT');
    expect(workflow).toContain('Workflow Failure: ${{ github.workflow }}');
    expect(workflow).toContain('roles/logging.viewer');
  });

  it('installs dependencies before the sync so google-auth-library can mint the token', () => {
    const install = workflow.indexOf('run: npm ci');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(workflow.indexOf('node scripts/cloud-function-error-issue-sync.mjs'));
    expect(workflow).toContain('GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-sa.json');
  });
});
