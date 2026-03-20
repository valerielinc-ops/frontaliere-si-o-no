import { describe, expect, it } from 'vitest';
import { STATS_CACHE_DURATION_MS } from '../services/statsService';

describe('statsService cache TTL', () => {
  it('uses a 1-hour cache window for BFS/UST stats', () => {
    expect(STATS_CACHE_DURATION_MS).toBe(60 * 60 * 1000);
  });
});
