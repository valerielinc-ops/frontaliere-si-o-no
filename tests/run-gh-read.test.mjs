import test from 'node:test';
import assert from 'node:assert/strict';
import { runGhRead } from '../scripts/ci/run-gh-read.mjs';

test('run-gh-read retries installation rate limits and returns the later payload', () => {
  let attempts = 0;
  const delays = [];
  const output = runGhRead(['run', 'list'], {
    execute: () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('Command failed: gh run list'), {
          stderr: Buffer.from('HTTP 403: API rate limit exceeded for installation'),
        });
      }
      return '[{"databaseId":123}]';
    },
    sleep: (delayMs) => delays.push(delayMs),
  });

  assert.equal(output, '[{"databaseId":123}]');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('run-gh-read leaves non-transient permission failures terminal', () => {
  let attempts = 0;
  assert.throws(() => runGhRead(['pr', 'list'], {
    execute: () => {
      attempts += 1;
      throw Object.assign(new Error('Command failed: gh pr list'), {
        stderr: Buffer.from('HTTP 403: Resource not accessible by integration'),
      });
    },
    sleep: () => {},
  }), /gh pr list/);
  assert.equal(attempts, 1);
});
