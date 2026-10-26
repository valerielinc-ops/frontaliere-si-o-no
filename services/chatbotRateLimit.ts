const RATE_LIMIT_KEY = 'chatbot_msgs';

export const MAX_CHATBOT_MESSAGES_PER_DAY = 20;

interface ChatbotRateLimitState {
  date: string;
  count: number;
}

function todayUtc(): string {
  return new Date().toISOString().split('T')[0];
}

function emptyState(date: string): ChatbotRateLimitState {
  return { date, count: 0 };
}

function isValidState(value: unknown, today: string): value is ChatbotRateLimitState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const state = value as Record<string, unknown>;
  return state.date === today
    && typeof state.count === 'number'
    && Number.isSafeInteger(state.count)
    && state.count >= 0;
}

function readState(today: string): ChatbotRateLimitState {
  const fallback = emptyState(today);

  try {
    const raw = localStorage.getItem(RATE_LIMIT_KEY);
    if (!raw) return fallback;

    const parsed: unknown = JSON.parse(raw);
    if (isValidState(parsed, today)) return parsed;

    // Repair malformed or stale state immediately so the next send starts at zero.
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(fallback));
  } catch {
    // Invalid JSON is also repaired when storage is available.
    try {
      localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(fallback));
    } catch {
      // Storage can be unavailable in privacy mode; fail open as before.
    }
  }

  return fallback;
}

export function checkChatbotRateLimit(): boolean {
  const state = readState(todayUtc());
  return state.count < MAX_CHATBOT_MESSAGES_PER_DAY;
}

export function incrementChatbotRateLimit(): void {
  const today = todayUtc();
  const state = readState(today);
  if (state.count >= MAX_CHATBOT_MESSAGES_PER_DAY) return;

  try {
    localStorage.setItem(
      RATE_LIMIT_KEY,
      JSON.stringify({ date: today, count: state.count + 1 }),
    );
  } catch {
    // Storage can be unavailable in privacy mode; the request still proceeds.
  }
}
