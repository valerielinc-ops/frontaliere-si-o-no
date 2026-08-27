import { describe, expect, it } from 'vitest';
import { buildComment, collectFailures } from '../scripts/ci/report-vitest-failure.mjs';

describe('report-vitest-failure', () => {
  it('buildComment include file, test, errore e run', () => {
    const body = buildComment([{
      file: 'shard-timing-2.json',
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

  it('collectFailures legge le asserzioni fallite dai report JSON', () => {
    expect(collectFailures(['/tmp/file-that-does-not-exist.json'])).toEqual([]);
  });
});
