import { describe, expect, it } from 'vitest';

import {
  strictExitCode,
  strictFailureResults,
} from '@/scripts/ci/identical-twin-transport-dryrun.mjs';

describe('identical twin transport strict gate', () => {
  it('treats check-failed as a strict failure alongside blocked transport', () => {
    const results = [
      { transport: 'check-failed' },
      { transport: 'blocked-import-hazard' },
      { transport: 'no-op' },
    ];
    expect(strictFailureResults(results)).toHaveLength(2);
    expect(strictExitCode(results, true)).toBe(1);
    expect(strictExitCode(results, false)).toBe(0);
  });
});
