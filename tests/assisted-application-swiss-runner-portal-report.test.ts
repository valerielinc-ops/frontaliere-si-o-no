import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reportPortalOutcomeFromRunDir,
  runPortalStopReporter,
} from '../scripts/assisted-application/local-runner.mjs';

// Synthetic markers only: no candidate data.
let runDir: string;
const startedAt = Date.UTC(2026, 10, 26, 10, 0, 0);
beforeEach(() => { runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-portal-report-test-')); });
afterEach(() => { fs.rmSync(runDir, { recursive: true, force: true }); });

const put = (name: string, value: unknown) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value));

describe('swiss runner portal stop report', () => {
  it('reports a stop: the reporter gets both marker paths and an opaque run reference', async () => {
    put('portal-stop.json', { host: 'portal.example.test', reason: 'no_sign_in_button' });
    const report = vi.fn(async (_args: any) => 0);
    const result = await reportPortalOutcomeFromRunDir({ runDir, mode: 'submit', runnerId: 'swiss-abcd1234', startedAt, report });
    expect(result).toEqual({ reported: true, stop: true, pass: false });
    const args = report.mock.calls[0][0];
    expect(args.stopReportFile).toBe(path.join(runDir, 'portal-stop.json'));
    expect(args.portalPassFile).toBe(path.join(runDir, 'portal-pass.json'));
    expect(args.runUrl).toBe('swiss-runner:swiss-abcd1234@2026-11-26T10:00:00.000Z');
    expect(args.runUrl).not.toMatch(/\/|http/);
  });

  it('reports a pass so the recovered portal-stop issues are closed (dry_run too)', async () => {
    put('portal-pass.json', { host: 'portal.example.test', channel: 'x', mode: 'dry_run', step: 3, stage: 'final_review' });
    const report = vi.fn(async (_args: any) => 0);
    const result = await reportPortalOutcomeFromRunDir({ runDir, mode: 'dry_run', startedAt, report });
    expect(result).toEqual({ reported: true, stop: false, pass: true });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no marker exists (killed agent: no invented issue)', async () => {
    const report = vi.fn(async (_args: any) => 0);
    expect(await reportPortalOutcomeFromRunDir({ runDir, mode: 'submit', startedAt, report })).toEqual({ reported: false, reason: 'no_marker' });
    expect(report).not.toHaveBeenCalled();
  });

  it('skips modes the workflow step skips', async () => {
    put('portal-stop.json', { host: 'portal.example.test' });
    const report = vi.fn(async (_args: any) => 0);
    expect((await reportPortalOutcomeFromRunDir({ runDir, mode: 'preview', startedAt, report })).reported).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it('survives a reporter that throws or exits non-zero: logged, never thrown', async () => {
    put('portal-stop.json', { host: 'portal.example.test' });
    const lines: string[] = [];
    const write = (text: string) => lines.push(text);
    const thrown = await reportPortalOutcomeFromRunDir({ runDir, mode: 'submit', startedAt, write, report: async () => { throw new Error('gh exploded'); } });
    expect(thrown).toEqual({ reported: false, reason: 'reporter_error' });
    const failed = await reportPortalOutcomeFromRunDir({ runDir, mode: 'submit', startedAt, write, report: async () => 1 });
    expect(failed).toEqual({ reported: false, reason: 'reporter_failed' });
    expect(lines.join('')).toContain('portal report failed');
    expect(lines.join('')).not.toContain('gh exploded');
  });

  it('default reporter runs report-portal-stop with the Remote Config token and only the marker paths', async () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spawnImpl = vi.fn((..._args: any[]) => { setImmediate(() => child.emit('close', 0)); return child; });
    const code = await runPortalStopReporter({
      stopReportFile: '/tmp/s.json', portalPassFile: '/tmp/p.json', runUrl: 'swiss-runner:x@t',
      rcEnv: { GITHUB_PAT: 'fixture-token' }, env: { PATH: '/bin' }, repoRoot: '/repo', spawnImpl: spawnImpl as any,
    });
    expect(code).toBe(0);
    const [, argv, options] = spawnImpl.mock.calls[0];
    expect(argv[0]).toBe('/repo/scripts/assisted-application/report-portal-stop.mjs');
    expect(options.env).toMatchObject({ GH_TOKEN: 'fixture-token', GH_REPO: 'valerielinc-ops/frontaliere-si-o-no', STOP_REPORT: '/tmp/s.json', PORTAL_PASS: '/tmp/p.json', RUN_URL: 'swiss-runner:x@t' });
  });
});
