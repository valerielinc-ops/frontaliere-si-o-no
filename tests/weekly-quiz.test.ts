// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
 useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/gamificationService', () => ({
 addXp: vi.fn(),
 unlockAchievement: vi.fn(),
}));

import {
 getWeekNumber,
 loadQuizState,
 QUIZ_POOL,
 validateQuizState,
} from '@/components/fisco/WeeklyQuiz';

const STORAGE_KEY = 'frontaliere_weekly_quiz';
const selectedQuestions = QUIZ_POOL.slice(0, 2);

function currentWeekState(overrides: Record<string, unknown> = {}) {
 return {
 week: getWeekNumber(),
 year: new Date().getFullYear(),
 answers: { [selectedQuestions[0].id]: 1 },
 score: 1,
 completed: false,
 ...overrides,
 };
}

describe('WeeklyQuiz persisted state', () => {
 beforeEach(() => {
 localStorage.clear();
 });

 it('retains only answer indexes valid for the selected question pool', () => {
 localStorage.setItem(STORAGE_KEY, JSON.stringify(currentWeekState({
 answers: {
 [selectedQuestions[0].id]: 1,
 [selectedQuestions[1].id]: selectedQuestions[1].options.length,
 [QUIZ_POOL[2].id]: 0,
 unknown_question: 0,
 },
 })));

 expect(loadQuizState(selectedQuestions)).toEqual({
 ...currentWeekState(),
 answers: { [selectedQuestions[0].id]: 1 },
 });
 });

 it('keeps valid answers resumable after loading from storage', () => {
 const saved = currentWeekState({
 answers: { [selectedQuestions[0].id]: 3 },
 score: 0,
 });
 localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

 expect(loadQuizState(selectedQuestions)).toEqual(saved);
 });

 it('resets malformed current-week state without throwing', () => {
 for (const malformed of [
 { score: '1' },
 { score: null },
 { completed: 'false' },
 { answers: [] },
 null,
 ]) {
 localStorage.setItem(STORAGE_KEY, JSON.stringify(
 malformed === null ? null : currentWeekState(malformed),
 ));

 expect(() => loadQuizState(selectedQuestions)).not.toThrow();
 expect(loadQuizState(selectedQuestions)).toBeNull();
 }
 });

 it('rejects non-finite scores before they reach quiz state', () => {
 expect(validateQuizState(currentWeekState({ score: Infinity }), selectedQuestions)).toBeNull();
 });
});
