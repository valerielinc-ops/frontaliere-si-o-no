import { describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();

vi.mock('node:child_process', () => ({ execFileSync }));

const { isTransientGhFailure, readRunJobs } = await import('../scripts/ci/scan-unreported-failures.mjs');

describe('scan-unreported-failures — lettura jobs resiliente ai gateway transienti', () => {
  it('classifica i gateway transienti ma non gli errori permanenti', () => {
    expect(isTransientGhFailure({ stderr: 'gh: Server Error (HTTP 502)' })).toBe(true);
    expect(isTransientGhFailure({ stderr: 'gh: HTTP 503 Service Unavailable' })).toBe(true);
    expect(isTransientGhFailure({ stderr: 'gh: HTTP 403 Forbidden' })).toBe(false);
    expect(isTransientGhFailure({ stderr: 'gh: HTTP 404 Not Found' })).toBe(false);
  });

  it('ritenta una lettura jobs dopo un 502 e conserva il payload valido', () => {
    let attempts = 0;
    execFileSync.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'gh: Server Error (HTTP 502)',
        });
      }
      return JSON.stringify({
        total_count: 1,
        jobs: [{ name: 'scan', conclusion: 'failure', steps: [] }],
      });
    });

    const result = readRunJobs(`retry-${Date.now()}`);

    expect(attempts).toBe(2);
    expect(result).toEqual({
      readable: true,
      jobs: {
        total_count: 1,
        jobs: [{ name: 'scan', conclusion: 'failure', steps: [] }],
      },
    });
  });
});
