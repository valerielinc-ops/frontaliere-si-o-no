// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkChatbotRateLimit,
  incrementChatbotRateLimit,
  MAX_CHATBOT_MESSAGES_PER_DAY,
} from '@/services/chatbotRateLimit';

const RATE_LIMIT_KEY = 'chatbot_msgs';

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function storedState(): { date: string; count: number } {
  return JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || '{}');
}

describe('chatbot daily rate limit state', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each([
    '3',
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    {},
    [],
  ])('resets malformed count %p before allowing a message', (count) => {
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify({ date: today(), count }));

    expect(checkChatbotRateLimit()).toBe(true);
    expect(storedState()).toEqual({ date: today(), count: 0 });

    incrementChatbotRateLimit();
    expect(storedState()).toEqual({ date: today(), count: 1 });
  });

  it('resets invalid JSON instead of blocking the user', () => {
    localStorage.setItem(RATE_LIMIT_KEY, '{not-json');

    expect(checkChatbotRateLimit()).toBe(true);
    expect(storedState()).toEqual({ date: today(), count: 0 });
  });

  it('resets a previous-day state', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify({ date: yesterday, count: 19 }));

    expect(checkChatbotRateLimit()).toBe(true);
    expect(storedState()).toEqual({ date: today(), count: 0 });
  });

  it('enforces the daily cap after repairing a negative counter', () => {
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify({ date: today(), count: -100 }));

    for (let i = 0; i < MAX_CHATBOT_MESSAGES_PER_DAY; i += 1) {
      expect(checkChatbotRateLimit()).toBe(true);
      incrementChatbotRateLimit();
    }

    expect(checkChatbotRateLimit()).toBe(false);
    expect(storedState()).toEqual({ date: today(), count: MAX_CHATBOT_MESSAGES_PER_DAY });
  });
});
