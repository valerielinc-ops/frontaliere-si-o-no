import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildComment, collectFailures } from '../scripts/ci/report-vitest-failure.mjs';

const SCRIPT = join(process.cwd(), 'scripts/ci/report-vitest-failure.mjs');

function writeFakeGh(dir, exitCode) {
  const file = join(dir, 'fake-gh');
  writeFileSync(file, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(file, 0o755);
  return file;
}

function writeReportFixture(dir) {
  const file = join(dir, 'shard-timing-related.json');
  writeFileSync(file, JSON.stringify({
    success: false,
    numFailedTests: 1,
    numFailedTestSuites: 1,
    testResults: [{
      name: '/runner/tests/example.test.ts',
      assertionResults: [{
        status: 'failed',
        fullName: 'suite fails',
        failureMessages: ['AssertionError: expected 1 to be 2'],
      }],
    }],
  }));
  return file;
}

describe('report-vitest-failure', () => {
  it('buildComment include file, test, errore e run', () => {
    const body = buildComment([{
      file: 'shard-timing-related.json',
      failedTests: 1,
      failedFiles: 1,
      failures: [{
        file: 'tests/example.test.ts',
        test: 'suite fails',
        error: 'AssertionError: expected 1 to be 2',
      }],
    }], {
      runUrl: 'https://github.com/o/r/actions/runs/42',
      runId: '42',
      headSha: 'abcdef123456789',
    });

    expect(body).toMatch(/vitest-failure-report/);
    expect(body).toMatch(/tests\/example\.test\.ts/);
    expect(body).toMatch(/suite fails/);
    expect(body).toMatch(/AssertionError/);
    expect(body).toMatch(/actions\/runs\/42/);
  });

  it('buildComment segnala quando il report JSON non è disponibile', () => {
    const body = buildComment([], { runId: '42' });

    expect(body).toMatch(/reporter JSON non è disponibile/);
    expect(body).toMatch(/Run ID: `42`/);
  });

  it('collectFailures legge le asserzioni fallite dal report prodotto da tests.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frontaliere-vitest-report-'));
    const report = join(dir, 'shard-timing-related.json');
    writeFileSync(report, JSON.stringify({
      success: false,
      numFailedTests: 1,
      numFailedTestSuites: 1,
      testResults: [{
        name: '/runner/tests/example.test.ts',
        assertionResults: [{
          status: 'failed',
          fullName: 'suite fails',
          failureMessages: ['AssertionError: expected 1 to be 2'],
        }],
      }],
    }));

    const groups = collectFailures([report]);
    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe(report);
    expect(groups[0].failures[0]).toMatchObject({
      file: 'tests/example.test.ts',
      test: 'suite fails',
    });
    expect(groups[0].failures[0].error).toContain('expected 1 to be 2');
  });

  it('conta i FILE falliti da testResults, non le suite di Vitest (file + describe)', () => {
    // Forma reale: un test rosso dentro un `describe` fa due suite rosse
    // (`getSuites` = file + describe annidati), ma il file rosso è uno solo.
    const dir = mkdtempSync(join(tmpdir(), 'frontaliere-vitest-report-files-'));
    const report = join(dir, 'shard-timing-related.json');
    writeFileSync(report, JSON.stringify({
      success: false,
      numFailedTests: 2,
      numFailedTestSuites: 3,
      numTotalTestSuites: 6,
      testResults: [
        {
          name: '/runner/tests/red.test.ts',
          status: 'failed',
          assertionResults: [
            { status: 'failed', fullName: 'blocco a rosso', failureMessages: ['AssertionError: a'] },
            { status: 'failed', fullName: 'blocco b rosso', failureMessages: ['AssertionError: b'] },
          ],
        },
        { name: '/runner/tests/green.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }] },
      ],
    }));

    const groups = collectFailures([report]);
    expect(groups[0].failedFiles).toBe(1);
    const body = buildComment(groups);
    expect(body).toContain('- Test falliti: **2** — file falliti: **1**');
    expect(body).not.toMatch(/suite falliti|\*\*3\*\*/);
  });

  it('quando gh fallisce (403/fork), avvisa su stdout e scrive il summary, exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frontaliere-vitest-publish-fail-'));
    const fakeGh = writeFakeGh(dir, 1);
    const report = writeReportFixture(dir);
    const summary = join(dir, 'step-summary.md');
    writeFileSync(summary, '');

    const stdout = execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TRUSTED_GH_BIN: fakeGh,
        PR_NUMBER: '42',
        GH_REPO: 'o/r',
        VITEST_REPORT_FILES: report,
        GITHUB_STEP_SUMMARY: summary,
      },
    });

    expect(stdout).toMatch(/::warning title=Vitest failure report::/);
    expect(existsSync(summary)).toBe(true);
    const summaryContent = readFileSync(summary, 'utf8');
    expect(summaryContent).toMatch(/vitest-failure-report/);
    expect(summaryContent).toMatch(/suite fails/);
  });

  it('quando gh riesce, non produce warning ne scrive il summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frontaliere-vitest-publish-ok-'));
    const fakeGh = writeFakeGh(dir, 0);
    const report = writeReportFixture(dir);
    const summary = join(dir, 'step-summary.md');
    writeFileSync(summary, '');

    const stdout = execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TRUSTED_GH_BIN: fakeGh,
        PR_NUMBER: '42',
        GH_REPO: 'o/r',
        VITEST_REPORT_FILES: report,
        GITHUB_STEP_SUMMARY: summary,
      },
    });

    expect(stdout).not.toMatch(/::warning/);
    expect(readFileSync(summary, 'utf8')).toBe('');
  });
});
