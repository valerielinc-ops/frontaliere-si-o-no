import { describe, expect, it } from 'vitest';
import { parseWeeklyQuizState } from '@/services/weeklyQuizState';

const questions = [
  { id: 'q1', options: ['a', 'b'], correctIndex: 0 },
  { id: 'q2', options: ['a', 'b', 'c'], correctIndex: 2 },
];

describe('parseWeeklyQuizState', () => {
  it('keeps valid answers and drops unknown or out-of-range entries', () => {
    const result = parseWeeklyQuizState(JSON.stringify({
      week: 42, year: 2026, answers: { q1: 1, q2: 99, unknown: 0 }, score: 1, completed: false,
    }), questions, 42, 2026);
    expect(result).toEqual({ week: 42, year: 2026, answers: { q1: 1 }, score: 1, completed: false });
  });

  it('rejects malformed current-week state', () => {
    expect(parseWeeklyQuizState(JSON.stringify({ week: 42, year: 2026, answers: [], score: 1, completed: false }), questions, 42, 2026)).toBeNull();
    expect(parseWeeklyQuizState(JSON.stringify({ week: 42, year: 2026, answers: {}, score: 9, completed: true }), questions, 42, 2026)).toBeNull();
    expect(parseWeeklyQuizState(JSON.stringify({ week: 41, year: 2026, answers: {}, score: 0, completed: false }), questions, 42, 2026)).toBeNull();
  });
});
