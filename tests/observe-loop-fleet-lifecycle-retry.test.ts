import { describe, expect, it, vi } from 'vitest';

import { ghJson } from '../scripts/ci/observe-loop-fleet-lifecycle.mjs';

describe('loop-fleet lifecycle GitHub reads', () => {
  it('retries a transient 502 and returns the recovered JSON', () => {
    const run = vi
      .fn()
      .mockImplementationOnce(() => {
        const error = new Error('gh failed');
        error.stderr = 'failed to get runs: HTTP 502: Server Error';
        throw error;
      })
      .mockReturnValueOnce('[{"number": 42}]');

    const result = ghJson(['run', 'list'], {
      run,
      retryOptions: { baseDelayMs: 0, sleep: vi.fn() },
    });

    expect(result).toEqual([{ number: 42 }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps authentication and malformed-request errors terminal', () => {
    const run = vi.fn(() => {
      const error = new Error('gh failed');
      error.stderr = 'HTTP 403: Forbidden';
      throw error;
    });

    expect(() => ghJson(['run', 'list'], {
      run,
      retryOptions: { baseDelayMs: 0, sleep: vi.fn() },
    })).toThrow('GitHub read failed');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
