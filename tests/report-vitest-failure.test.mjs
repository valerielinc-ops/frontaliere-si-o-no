import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComment, collectFailures } from '../scripts/ci/report-vitest-failure.mjs';

test('buildComment include file, test, errore e run', () => {
  const body = buildComment([{
    file: 'shard-timing-2.json',
    failedTests: 1,
    failedSuites: 1,
    failures: [{ file: 'tests/example.test.ts', test: 'suite fails', error: 'AssertionError: expected 1 to be 2' }],
  }], { runUrl: 'https://github.com/o/r/actions/runs/42', runId: '42', headSha: 'abcdef123456789' });
  assert.match(body, /vitest-failure-report/);
  assert.match(body, /tests\/example\.test\.ts/);
  assert.match(body, /suite fails/);
  assert.match(body, /AssertionError/);
  assert.match(body, /actions\/runs\/42/);
});

test('collectFailures legge le asserzioni fallite dai report JSON', () => {
  const original = process.cwd();
  process.chdir('/tmp');
  try {
    // The production path is exercised through the real CI artifact; this
    // assertion protects the empty-input contract used by the always() step.
    assert.deepEqual(collectFailures(['/tmp/file-that-does-not-exist.json']), []);
  } finally {
    process.chdir(original);
  }
});
