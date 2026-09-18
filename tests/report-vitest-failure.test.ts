import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildComment, collectFailures } from '../scripts/ci/report-vitest-failure.mjs';

describe('report-vitest-failure', () => {
  it('buildComment include file, test, errore e run', () => {
    const body = buildComment([{
      file: 'shard-timing-related.json',
      failedTests: 1,
      failedSuites: 1,
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
});
