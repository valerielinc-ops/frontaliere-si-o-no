import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveAdBlockAbBucket } from '@/services/adBlockAbTest';
import { isLikelyBot } from '@/services/botPatterns';

vi.mock('@/services/botPatterns', () => ({
  isLikelyBot: vi.fn(() => false),
}));

const isLikelyBotMock = vi.mocked(isLikelyBot);

describe('resolveAdBlockAbBucket', () => {
  beforeEach(() => {
    isLikelyBotMock.mockReturnValue(false);
    localStorage.clear();
  });

  it('always resolves bots to control, without touching storage', () => {
    isLikelyBotMock.mockReturnValue(true);
    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    expect(resolveAdBlockAbBucket()).toBe('control');
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('is stable across repeated calls for the same persisted anon id', () => {
    const first = resolveAdBlockAbBucket();
    const second = resolveAdBlockAbBucket();
    const third = resolveAdBlockAbBucket();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('persists the anon id in localStorage under a stable key', () => {
    resolveAdBlockAbBucket();
    expect(localStorage.getItem('ft_adblock_anon_id')).toEqual(expect.any(String));
  });

  it('resolves to control when localStorage is unavailable', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(resolveAdBlockAbBucket()).toBe('control');
  });

  it('splits roughly 30/70 across a population of distinct anonymous ids', () => {
    let testCount = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      localStorage.clear();
      if (resolveAdBlockAbBucket() === 'test') testCount++;
    }
    const ratio = testCount / N;
    // Wide tolerance for statistical stability around the true 30% target.
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.45);
  });
});
