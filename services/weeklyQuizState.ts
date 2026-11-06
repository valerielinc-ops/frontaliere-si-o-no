export interface WeeklyQuizQuestionForState {
  id: string;
  options: readonly unknown[];
  correctIndex: number;
}

export interface WeeklyQuizState {
  week: number;
  year: number;
  answers: Record<string, number>;
  score: number;
  completed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a weekly quiz snapshot against the questions active for the week. */
export function parseWeeklyQuizState(
  raw: string | null,
  questions: readonly WeeklyQuizQuestionForState[],
  currentWeek: number,
  currentYear: number,
): WeeklyQuizState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.week !== currentWeek || parsed.year !== currentYear) return null;
    const score = parsed.score;
    const completed = parsed.completed;
    if (typeof score !== 'number' || !Number.isSafeInteger(score) || score < 0 || score > questions.length) return null;
    if (typeof completed !== 'boolean' || !isPlainObject(parsed.answers)) return null;

    const questionById = new Map(questions.map((question) => [question.id, question]));
    const answers: Record<string, number> = {};
    for (const [id, answer] of Object.entries(parsed.answers)) {
      const question = questionById.get(id);
      if (!question || typeof answer !== 'number' || !Number.isSafeInteger(answer) || answer < 0 || answer >= question.options.length) continue;
      answers[id] = answer;
    }
    return { week: currentWeek, year: currentYear, answers, score, completed };
  } catch {
    return null;
  }
}
