import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCrawlerShellBody, reportCrawlerAlert } from '../scripts/generate-crawler-group-workflows.mjs';

function runBody(body: string, env: NodeJS.ProcessEnv = {}) {
  try {
    return {
      exitCode: 0,
      stdout: execFileSync('bash', ['-c', body], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      }),
    };
  } catch (error: any) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? '' };
  }
}

describe('crawler failure reporter propagation', () => {
  it('captures and exposes a failing reporter independently of the crawler verdict', () => {
    const lines = reportCrawlerAlert({ slug: 'fixture', run: 'false', indent: 2 });
    expect(lines.join('\n')).toContain('report_exit=$?');
    expect(lines.join('\n')).toContain('alert reporter failed fixture');

    const result = runBody(`set +e\n${lines.join('\n')}\nif [ "$report_exit" -ne 0 ]; then exit 7; fi`);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain('alert reporter failed fixture');
  });

  it('marks a member red and emits an error when issue creation fails', () => {
    const body = buildCrawlerShellBody({
      slug: 'fixture-crawler',
      runStep: { run: 'false' },
      postSteps: [{
        name: 'Report failure to GitHub Issues',
        if: 'failure()',
        run: 'echo REPORT_ATTEMPTED\nfalse',
      }],
    });

    const result = runBody(body);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('REPORT_ATTEMPTED');
    expect(result.stdout).toContain('alert reporter failed fixture-crawler');
  });

  it('keeps the timed target verdict while exposing a failing reporter', () => {
    const body = buildCrawlerShellBody({
      slug: 'timed-fixture',
      targetTimeoutMinutes: 1,
      runStep: { run: 'false' },
      postSteps: [{
        name: 'Report failure to GitHub Issues',
        if: 'failure()',
        run: 'echo TIMED_REPORT_ATTEMPTED\nfalse',
      }],
    });

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-report-timeout-'));
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'timeout'), [
      '#!/usr/bin/env bash',
      'while [[ "${1:-}" == --* ]]; do shift; done',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'), { mode: 0o755 });

    try {
      const result = runBody(body, { PATH: `${bin}:${process.env.PATH ?? ''}` });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain('TIMED_REPORT_ATTEMPTED');
      expect(result.stdout).toContain('alert reporter failed timed-fixture');
      expect(body).toContain('outside timeout');
      expect(body).toContain('timeout --signal=TERM --kill-after=30s 1m bash -c');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
