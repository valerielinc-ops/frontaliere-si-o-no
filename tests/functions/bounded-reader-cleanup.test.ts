import { describe, expect, it, vi } from 'vitest';
import { cancelReaderWithDeadline } from '../../functions/src/lib/boundedReaderCleanup.js';

describe('functions reader cleanup', () => {
  it('does not wait forever for a stalled stream cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    await expect(cancelReaderWithDeadline({ cancel })).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  }, 5_000);
});
