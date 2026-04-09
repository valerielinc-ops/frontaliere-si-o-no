import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { unlockAchievement, addXp } from '@/services/gamificationService';
import { Brain, CheckCircle2, XCircle, Trophy, ArrowRight, RotateCcw, Sparkles, Clock, Award } from 'lucide-react';

// ─── Quiz Data ───────────────────────────────────────────────

export interface QuizQuestion {
  id: string;
  questionKey: string;
  options: string[]; // i18n keys for each option
  correctIndex: number;
  explanationKey: string;
  category: 'tax' | 'pension' | 'insurance' | 'permits' | 'general';
  difficulty: 'easy' | 'medium' | 'hard';
}

/**
 * Weekly quiz questions pool.
 * Each week, 5 questions are selected based on the current week number.
 * Questions rotate automatically — no manual update needed.
 * 
 * LAST REVIEWED: 2025-01-20
 * To add new questions, append to this array.
 */
export const QUIZ_POOL: QuizQuestion[] = [
  // ── Tax ──
  {
    id: 'tax_01',
    questionKey: 'quiz.q.tax_01',
    options: ['quiz.q.tax_01.a', 'quiz.q.tax_01.b', 'quiz.q.tax_01.c', 'quiz.q.tax_01.d'],
    correctIndex: 1,
    explanationKey: 'quiz.q.tax_01.explanation',
    category: 'tax',
    difficulty: 'easy',
  },
  {
    id: 'tax_02',
    questionKey: 'quiz.q.tax_02',
    options: ['quiz.q.tax_02.a', 'quiz.q.tax_02.b', 'quiz.q.tax_02.c', 'quiz.q.tax_02.d'],
    correctIndex: 0,
    explanationKey: 'quiz.q.tax_02.explanation',
    category: 'tax',
    difficulty: 'medium',
  },
  {
    id: 'tax_03',
    questionKey: 'quiz.q.tax_03',
    options: ['quiz.q.tax_03.a', 'quiz.q.tax_03.b', 'quiz.q.tax_03.c', 'quiz.q.tax_03.d'],
    correctIndex: 2,
    explanationKey: 'quiz.q.tax_03.explanation',
    category: 'tax',
    difficulty: 'hard',
  },
  {
    id: 'tax_04',
    questionKey: 'quiz.q.tax_04',
    options: ['quiz.q.tax_04.a', 'quiz.q.tax_04.b', 'quiz.q.tax_04.c', 'quiz.q.tax_04.d'],
    correctIndex: 1,
    explanationKey: 'quiz.q.tax_04.explanation',
    category: 'tax',
    difficulty: 'medium',
  },
  // ── Pension ──
  {
    id: 'pension_01',
    questionKey: 'quiz.q.pension_01',
    options: ['quiz.q.pension_01.a', 'quiz.q.pension_01.b', 'quiz.q.pension_01.c', 'quiz.q.pension_01.d'],
    correctIndex: 2,
    explanationKey: 'quiz.q.pension_01.explanation',
    category: 'pension',
    difficulty: 'easy',
  },
  {
    id: 'pension_02',
    questionKey: 'quiz.q.pension_02',
    options: ['quiz.q.pension_02.a', 'quiz.q.pension_02.b', 'quiz.q.pension_02.c', 'quiz.q.pension_02.d'],
    correctIndex: 0,
    explanationKey: 'quiz.q.pension_02.explanation',
    category: 'pension',
    difficulty: 'medium',
  },
  // ── Insurance ──
  {
    id: 'insurance_01',
    questionKey: 'quiz.q.insurance_01',
    options: ['quiz.q.insurance_01.a', 'quiz.q.insurance_01.b', 'quiz.q.insurance_01.c', 'quiz.q.insurance_01.d'],
    correctIndex: 1,
    explanationKey: 'quiz.q.insurance_01.explanation',
    category: 'insurance',
    difficulty: 'easy',
  },
  {
    id: 'insurance_02',
    questionKey: 'quiz.q.insurance_02',
    options: ['quiz.q.insurance_02.a', 'quiz.q.insurance_02.b', 'quiz.q.insurance_02.c', 'quiz.q.insurance_02.d'],
    correctIndex: 3,
    explanationKey: 'quiz.q.insurance_02.explanation',
    category: 'insurance',
    difficulty: 'medium',
  },
  // ── Permits ──
  {
    id: 'permits_01',
    questionKey: 'quiz.q.permits_01',
    options: ['quiz.q.permits_01.a', 'quiz.q.permits_01.b', 'quiz.q.permits_01.c', 'quiz.q.permits_01.d'],
    correctIndex: 0,
    explanationKey: 'quiz.q.permits_01.explanation',
    category: 'permits',
    difficulty: 'easy',
  },
  {
    id: 'permits_02',
    questionKey: 'quiz.q.permits_02',
    options: ['quiz.q.permits_02.a', 'quiz.q.permits_02.b', 'quiz.q.permits_02.c', 'quiz.q.permits_02.d'],
    correctIndex: 2,
    explanationKey: 'quiz.q.permits_02.explanation',
    category: 'permits',
    difficulty: 'medium',
  },
  // ── General ──
  {
    id: 'general_01',
    questionKey: 'quiz.q.general_01',
    options: ['quiz.q.general_01.a', 'quiz.q.general_01.b', 'quiz.q.general_01.c', 'quiz.q.general_01.d'],
    correctIndex: 1,
    explanationKey: 'quiz.q.general_01.explanation',
    category: 'general',
    difficulty: 'easy',
  },
  {
    id: 'general_02',
    questionKey: 'quiz.q.general_02',
    options: ['quiz.q.general_02.a', 'quiz.q.general_02.b', 'quiz.q.general_02.c', 'quiz.q.general_02.d'],
    correctIndex: 3,
    explanationKey: 'quiz.q.general_02.explanation',
    category: 'general',
    difficulty: 'medium',
  },
];

// ─── Week-based question selection ───────────────────────────

function getWeekNumber(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now.getTime() - start.getTime();
  return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
}

/** Deterministic shuffle based on week number — same 5 questions all week */
function getWeeklyQuestions(pool: QuizQuestion[], count = 5): QuizQuestion[] {
  const week = getWeekNumber();
  const year = new Date().getFullYear();
  const seed = year * 100 + week;
  
  // Simple seeded PRNG (mulberry32)
  let state = seed;
  const rand = () => {
    state |= 0; state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  
  const shuffled = [...pool].sort(() => rand() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// ─── localStorage state ──────────────────────────────────────

const QUIZ_STORAGE_KEY = 'frontaliere_weekly_quiz';

interface QuizState {
  week: number;
  year: number;
  answers: Record<string, number>; // questionId → selected index
  score: number;
  completed: boolean;
}

function loadQuizState(): QuizState | null {
  try {
    const raw = localStorage.getItem(QUIZ_STORAGE_KEY);
    if (!raw) return null;
    const state: QuizState = JSON.parse(raw);
    // Invalidate if different week
    const currentWeek = getWeekNumber();
    const currentYear = new Date().getFullYear();
    if (state.week !== currentWeek || state.year !== currentYear) return null;
    return state;
  } catch {
    return null;
  }
}

function saveQuizState(state: QuizState): void {
  try {
    localStorage.setItem(QUIZ_STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

// ─── Category icons & colors ─────────────────────────────────

const CATEGORY_STYLES: Record<string, { emoji: string; color: string }> = {
  tax: { emoji: '📊', color: 'text-blue-600 dark:text-blue-400' },
  pension: { emoji: '🏦', color: 'text-emerald-700 dark:text-emerald-400' },
  insurance: { emoji: '🏥', color: 'text-rose-600 dark:text-rose-400' },
  permits: { emoji: '🪪', color: 'text-amber-600 dark:text-amber-400' },
  general: { emoji: '📋', color: 'text-teal-600 dark:text-teal-400' },
};

const DIFFICULTY_LABELS: Record<string, { key: string; color: string }> = {
  easy: { key: 'quiz.difficulty.facile', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  medium: { key: 'quiz.difficulty.medio', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  hard: { key: 'quiz.difficulty.difficile', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
};

// ─── Component ───────────────────────────────────────────────

const WeeklyQuiz: React.FC = () => {
  const { t } = useTranslation();
  const questions = useMemo(() => getWeeklyQuestions(QUIZ_POOL), []);
  
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [score, setScore] = useState(0);
  const [completed, setCompleted] = useState(false);

  // Load saved state
  useEffect(() => {
    const saved = loadQuizState();
    if (saved) {
      setAnswers(saved.answers);
      setScore(saved.score);
      setCompleted(saved.completed);
      if (saved.completed) {
        setCurrentIndex(questions.length);
      }
    }
  }, [questions.length]);

  const currentQuestion = questions[currentIndex];
  const isLastQuestion = currentIndex === questions.length - 1;
  const weekNumber = getWeekNumber();

  const handleAnswer = (optionIndex: number) => {
    if (selectedAnswer !== null) return; // Already answered
    setSelectedAnswer(optionIndex);
    setShowExplanation(true);

    const isCorrect = optionIndex === currentQuestion.correctIndex;
    const newAnswers = { ...answers, [currentQuestion.id]: optionIndex };
    const newScore = isCorrect ? score + 1 : score;

    setAnswers(newAnswers);
    setScore(newScore);

    if (isCorrect) {
      addXp(20);
    }
  };

  const handleNext = () => {
    if (isLastQuestion) {
      // Quiz completed
      setCompleted(true);
      saveQuizState({
        week: weekNumber,
        year: new Date().getFullYear(),
        answers,
        score,
        completed: true,
      });

      // Gamification
      if (score === questions.length) {
        unlockAchievement('quiz_perfect');
        addXp(100);
      } else {
        addXp(50);
      }
      unlockAchievement('quiz_completed');
    } else {
      setCurrentIndex(currentIndex + 1);
      setSelectedAnswer(null);
      setShowExplanation(false);
    }
  };

  const handleRestart = () => {
    setCurrentIndex(0);
    setSelectedAnswer(null);
    setShowExplanation(false);
    setAnswers({});
    setScore(0);
    setCompleted(false);
    localStorage.removeItem(QUIZ_STORAGE_KEY);
  };

  // ── Completed state ──
  if (completed) {
    const percentage = Math.round((score / questions.length) * 100);
    const emoji = percentage === 100 ? '🏆' : percentage >= 60 ? '👏' : '📚';

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl p-4 sm:p-6 border border-emerald-200 dark:border-emerald-800">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-emerald-100 dark:bg-emerald-900/50 rounded-xl">
              <Brain className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-emerald-900 dark:text-emerald-100">{t('quiz.title')}</h2>
          </div>
          <p className="text-emerald-700 dark:text-emerald-300 text-sm flex items-center gap-2">
            <Clock className="w-4 h-4" />
            {t('quiz.weekLabel', { week: String(weekNumber) })}
          </p>
        </div>

        {/* Results Card */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 sm:p-8 border border-slate-200 dark:border-slate-700 text-center">
          <div className="text-6xl mb-4">{emoji}</div>
          <h3 className="text-2xl font-bold text-slate-900 dark:text-slate-100 mb-2">
            {t('quiz.completed')}
          </h3>
          <p className="text-lg text-slate-600 dark:text-slate-400 mb-6">
            {t('quiz.score', { score: String(score), total: String(questions.length) })}
          </p>

          {/* Score bar */}
          <div className="w-full max-w-xs mx-auto h-4 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden mb-6">
            <div
              className={`h-full rounded-full transition-transform duration-1000 origin-left ${
                percentage === 100 ? 'bg-gradient-to-r from-amber-400 to-yellow-500' :
                percentage >= 60 ? 'bg-gradient-to-r from-emerald-400 to-green-500' :
                'bg-gradient-to-r from-red-400 to-orange-500'
              }`}
              style={{ transform: `scaleX(${percentage / 100})` }}
            />
          </div>

          {/* Review answers */}
          <div className="space-y-3 text-left max-w-lg mx-auto mb-6">
            {questions.map((q, i) => {
              const userAnswer = answers[q.id];
              const isCorrect = userAnswer === q.correctIndex;
              return (
                <div key={q.id} className={`flex items-center gap-3 p-3 rounded-xl ${
                  isCorrect
                    ? 'bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800'
                    : 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800'
                }`}>
                  {isCorrect
                    ? <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                    : <XCircle className="w-5 h-5 text-red-500 shrink-0" />
                  }
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    {i + 1}. {t(q.questionKey)}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="text-sm text-slate-500 mb-4">
            {t('quiz.nextWeek')}
          </p>

          <button
            onClick={handleRestart}
            className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            {t('quiz.retry')}
          </button>
        </div>
      </div>
    );
  }

  // ── Active quiz ──
  if (!currentQuestion) return null;

  const catStyle = CATEGORY_STYLES[currentQuestion.category] || CATEGORY_STYLES.general;
  const diffStyle = DIFFICULTY_LABELS[currentQuestion.difficulty] || DIFFICULTY_LABELS.easy;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl p-4 sm:p-6 border border-emerald-200 dark:border-emerald-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-emerald-100 dark:bg-emerald-900/50 rounded-xl">
            <Brain className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="text-2xl font-bold text-emerald-900 dark:text-emerald-100">{t('quiz.title')}</h2>
        </div>
        <p className="text-emerald-700 dark:text-emerald-300 text-sm flex items-center gap-2">
          <Clock className="w-4 h-4" />
          {t('quiz.weekLabel', { week: String(weekNumber) })}
        </p>
      </div>

      {/* Progress */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between mb-3">
          <span className="font-bold text-slate-800 dark:text-slate-200">
            {t('quiz.questionOf', { current: String(currentIndex + 1), total: String(questions.length) })}
          </span>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${diffStyle.color}`}>
              {t(diffStyle.key)}
            </span>
            <span className="text-sm">
              {catStyle.emoji}
            </span>
          </div>
        </div>
        <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-transform duration-300 origin-left"
            style={{ transform: `scaleX(${(currentIndex + 1) / questions.length})` }}
          />
        </div>
      </div>

      {/* Question Card */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 sm:p-6 border border-slate-200 dark:border-slate-700">
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-6">
          {t(currentQuestion.questionKey)}
        </h3>

        {/* Options */}
        <div className="space-y-3">
          {currentQuestion.options.map((optKey, i) => {
            const isSelected = selectedAnswer === i;
            const isCorrect = i === currentQuestion.correctIndex;
            const showResult = selectedAnswer !== null;

            let optionClass = 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer';
            if (showResult && isCorrect) {
              optionClass = 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-700 ring-2 ring-emerald-400';
            } else if (showResult && isSelected && !isCorrect) {
              optionClass = 'bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-700 ring-2 ring-red-400';
            } else if (showResult) {
              optionClass = 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 opacity-60';
            }

            return (
              <button
                key={i}
                onClick={() => handleAnswer(i)}
                disabled={selectedAnswer !== null}
                className={`w-full text-left p-4 rounded-xl border-2 transition-colors ${optionClass}`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                    showResult && isCorrect ? 'bg-emerald-500 text-white' :
                    showResult && isSelected ? 'bg-red-500 text-white' :
                    'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400'
                  }`}>
                    {showResult && isCorrect ? '✓' :
                     showResult && isSelected ? '✗' :
                     String.fromCharCode(65 + i)}
                  </div>
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {t(optKey)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Explanation */}
        {showExplanation && (
          <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950/20 rounded-xl border border-blue-200 dark:border-blue-800">
            <div className="flex items-start gap-2">
              <Sparkles className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
              <p className="text-sm text-blue-700 dark:text-blue-300">
                {t(currentQuestion.explanationKey)}
              </p>
            </div>
          </div>
        )}

        {/* Next button */}
        {selectedAnswer !== null && (
          <div className="mt-6 flex justify-end">
            <button
              onClick={handleNext}
              className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-colors"
            >
              {isLastQuestion ? t('quiz.seeResults') : t('quiz.next')}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default WeeklyQuiz;
