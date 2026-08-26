import { describe, it, expect, vi } from 'vitest';
import {
  STAGNANT_THRESHOLD_DAYS,
  parseHistory,
  evaluateStagnation,
  runMemberCountMonitor,
} from '../scripts/monitor-telegram-member-count.mjs';

// Stagnation is measured against real elapsed time, so fixtures are relative
// to actual now — never hardcoded absolute dates (AGENTS.md: date fixture
// relativa a now, mai literal).
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const isoDaysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);

describe('parseHistory', () => {
  it('parses valid jsonl lines and drops malformed/empty ones', () => {
    const raw = [
      JSON.stringify({ date: '2026-01-01', count: 3 }),
      '',
      'not json',
      JSON.stringify({ date: '2026-01-02', count: 4 }),
    ].join('\n');
    expect(parseHistory(raw)).toEqual([
      { date: '2026-01-01', count: 3 },
      { date: '2026-01-02', count: 4 },
    ]);
  });

  it('returns an empty array for empty/undefined input', () => {
    expect(parseHistory('')).toEqual([]);
  });
});

describe('evaluateStagnation', () => {
  it('is not stagnant with no history yet (first run, insufficient data)', () => {
    const result = evaluateStagnation([], 3, NOW);
    expect(result.stagnant).toBe(false);
  });

  it('is not stagnant when the count changed within the threshold window', () => {
    const history = [
      { date: isoDaysAgo(40), count: 2 },
      { date: isoDaysAgo(20), count: 3 }, // changed 20 days ago, below threshold
    ];
    const result = evaluateStagnation(history, 3, NOW);
    expect(result.stagnant).toBe(false);
    expect(result.daysUnchanged).toBeLessThan(STAGNANT_THRESHOLD_DAYS);
  });

  it('is stagnant when the count has been unchanged for >= 30 days', () => {
    const history = [
      { date: isoDaysAgo(60), count: 2 },
      { date: isoDaysAgo(35), count: 3 }, // last change 35 days ago
      { date: isoDaysAgo(10), count: 3 },
    ];
    const result = evaluateStagnation(history, 3, NOW);
    expect(result.stagnant).toBe(true);
    expect(result.daysUnchanged).toBeGreaterThanOrEqual(STAGNANT_THRESHOLD_DAYS);
  });

  it('is stagnant when the count never changed across a >= 30-day recorded history', () => {
    const history = [
      { date: isoDaysAgo(31), count: 3 },
      { date: isoDaysAgo(1), count: 3 },
    ];
    const result = evaluateStagnation(history, 3, NOW);
    expect(result.stagnant).toBe(true);
  });

  it('is not stagnant when the recorded history itself is shorter than the threshold', () => {
    const history = [
      { date: isoDaysAgo(5), count: 3 },
      { date: isoDaysAgo(1), count: 3 },
    ];
    const result = evaluateStagnation(history, 3, NOW);
    expect(result.stagnant).toBe(false);
  });
});

describe('runMemberCountMonitor', () => {
  const credentials = { token: 'bot-token', chatId: '@channel' };

  it('skips cleanly when credentials are missing (fail-soft)', async () => {
    const createIssueImpl = vi.fn();
    const result = await runMemberCountMonitor({
      credentials: { token: '', chatId: '' },
      createIssueImpl,
    });
    expect(result.skipped).toBe(true);
    expect(createIssueImpl).not.toHaveBeenCalled();
  });

  it('skips cleanly when the API call fails (fail-soft, never throws/blocks)', async () => {
    const createIssueImpl = vi.fn();
    const result = await runMemberCountMonitor({
      credentials,
      getChatMemberCountImpl: async () => ({ ok: false, count: null, error: 'HTTP 401' }),
      createIssueImpl,
    });
    expect(result.skipped).toBe(true);
    expect(createIssueImpl).not.toHaveBeenCalled();
  });

  it('opens an issue when the count has been unchanged for >= 30 days', async () => {
    const history = [
      { date: isoDaysAgo(45), count: 3 },
      { date: isoDaysAgo(2), count: 3 },
    ];
    const createIssueImpl = vi.fn();
    const saveHistoryImpl = vi.fn();
    const result = await runMemberCountMonitor({
      now: NOW,
      credentials,
      getChatMemberCountImpl: async () => ({ ok: true, count: 3, error: null }),
      loadHistoryImpl: () => history,
      saveHistoryImpl,
      createIssueImpl,
    });
    expect(result.stagnation.stagnant).toBe(true);
    expect(createIssueImpl).toHaveBeenCalledTimes(1);
    expect(createIssueImpl.mock.calls[0][0].title).toContain('stagnant');
    // History is still persisted even when stagnant, so the trend keeps growing.
    expect(saveHistoryImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT open an issue when the count changed recently', async () => {
    const history = [
      { date: isoDaysAgo(45), count: 2 },
      { date: isoDaysAgo(2), count: 3 }, // changed 2 days ago
    ];
    const createIssueImpl = vi.fn();
    const result = await runMemberCountMonitor({
      now: NOW,
      credentials,
      getChatMemberCountImpl: async () => ({ ok: true, count: 3, error: null }),
      loadHistoryImpl: () => history,
      saveHistoryImpl: vi.fn(),
      createIssueImpl,
    });
    expect(result.stagnation.stagnant).toBe(false);
    expect(createIssueImpl).not.toHaveBeenCalled();
  });

  it('does NOT open an issue when the 30-day window has not matured yet', async () => {
    const history = [{ date: isoDaysAgo(5), count: 3 }];
    const createIssueImpl = vi.fn();
    const result = await runMemberCountMonitor({
      now: NOW,
      credentials,
      getChatMemberCountImpl: async () => ({ ok: true, count: 3, error: null }),
      loadHistoryImpl: () => history,
      saveHistoryImpl: vi.fn(),
      createIssueImpl,
    });
    expect(result.stagnation.stagnant).toBe(false);
    expect(createIssueImpl).not.toHaveBeenCalled();
  });

  it('--dry-run style (dryRun:true) never writes history or opens an issue', async () => {
    const createIssueImpl = vi.fn();
    const saveHistoryImpl = vi.fn();
    const history = [
      { date: isoDaysAgo(45), count: 3 },
      { date: isoDaysAgo(2), count: 3 },
    ];
    const result = await runMemberCountMonitor({
      now: NOW,
      credentials,
      dryRun: true,
      getChatMemberCountImpl: async () => ({ ok: true, count: 3, error: null }),
      loadHistoryImpl: () => history,
      saveHistoryImpl,
      createIssueImpl,
    });
    expect(result.stagnation.stagnant).toBe(true);
    expect(createIssueImpl).not.toHaveBeenCalled();
    expect(saveHistoryImpl).not.toHaveBeenCalled();
  });
});
