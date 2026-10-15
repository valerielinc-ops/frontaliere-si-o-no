import { describe, expect, it } from 'vitest';
import { EVENT_SOURCES } from '../scripts/lib/events-utils.mjs';

describe('event source homepages', () => {
  it('uses an explicit MySwitzerland locale path for the crawler-facing link', () => {
    expect(EVENT_SOURCES.myswitzerland.homepage).toBe('https://www.myswitzerland.com/en/');
  });
});
