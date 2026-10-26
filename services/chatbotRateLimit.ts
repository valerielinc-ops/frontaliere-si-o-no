export const MAX_CHATBOT_MESSAGES_PER_DAY = 20;

export interface ChatbotRateLimitState {
  date: string;
  count: number;
}

export function normalizeChatbotRateLimitState(raw: unknown, today: string): ChatbotRateLimitState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { date: today, count: 0 };
  }

  const candidate = raw as { date?: unknown; count?: unknown };
  if (candidate.date !== today || !Number.isSafeInteger(candidate.count) || Number(candidate.count) < 0) {
    return { date: today, count: 0 };
  }

  return { date: today, count: Number(candidate.count) };
}

export function canSendChatbotMessage(state: ChatbotRateLimitState): boolean {
  return state.count < MAX_CHATBOT_MESSAGES_PER_DAY;
}

export function incrementChatbotRateLimit(state: ChatbotRateLimitState): ChatbotRateLimitState {
  return {
    date: state.date,
    count: Math.min(MAX_CHATBOT_MESSAGES_PER_DAY, state.count + 1),
  };
}
