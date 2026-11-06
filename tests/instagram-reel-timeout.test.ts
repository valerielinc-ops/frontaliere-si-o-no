import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TIMEOUTS, RobotError, waitForInstagramReelPreview } from '../scripts/social-robot/lib/flows.mjs';

afterEach(() => vi.restoreAllMocks());

describe('Instagram Reel preview wait', () => {
  it('uses the bounded upload timeout when the caller passes undefined', async () => {
    let guardCalls = 0;
    const guard = vi.fn(async () => {
      guardCalls += 1;
      if (guardCalls > 2) throw new Error('preview wait exceeded its bounded poll');
    });
    const absentLocator = {
      first() { return this; },
      filter() { return this; },
      count: vi.fn().mockResolvedValue(0),
      isVisible: vi.fn().mockResolvedValue(false),
    };
    const page = { getByRole: () => absentLocator, locator: () => ({ count: vi.fn().mockResolvedValue(0) }) };
    const step = { set: vi.fn(), get: () => 'reel-next-preview' };
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(DEFAULT_TIMEOUTS.upload + 1);

    await expect(waitForInstagramReelPreview({
      page,
      step,
      snap: async () => {},
      guard,
      timeout: undefined,
    })).rejects.toMatchObject({ errorClass: 'selector-missing', step: 'reel-next-preview' });
    expect(guard).toHaveBeenCalledTimes(2);
  });
});
