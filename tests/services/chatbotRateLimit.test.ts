import { describe, expect, it } from 'vitest';
import {
  canSendChatbotMessage,
  incrementChatbotRateLimit,
  normalizeChatbotRateLimitState,
} from '@/services/chatbotRateLimit';

describe('chatbot rate-limit state', () => {
  it('resets malformed, negative and unsafe counters', () => {
    expect(normalizeChatbotRateLimitState({ date: '2026-10-26', count: '2' }, '2026-10-26')).toEqual({ date: '2026-10-26', count: 0 });
    expect(normalizeChatbotRateLimitState({ date: '2026-10-26', count: -1 }, '2026-10-26')).toEqual({ date: '2026-10-26', count: 0 });
    expect(normalizeChatbotRateLimitState({ date: '2026-10-26', count: Number.MAX_SAFE_INTEGER + 1 }, '2026-10-26')).toEqual({ date: '2026-10-26', count: 0 });
  });

  it('resets yesterday and caps increments at the daily limit', () => {
    const state = normalizeChatbotRateLimitState({ date: '2026-10-25', count: 20 }, '2026-10-26');
    expect(state).toEqual({ date: '2026-10-26', count: 0 });
    expect(incrementChatbotRateLimit({ date: '2026-10-26', count: 19 })).toEqual({ date: '2026-10-26', count: 20 });
    expect(canSendChatbotMessage({ date: '2026-10-26', count: 20 })).toBe(false);
  });
});
