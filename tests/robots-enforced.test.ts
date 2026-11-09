/**
 * CRAWLER_RESPECT_ROBOTS (owner decision 2026-11-09): robots.txt is respected
 * by default and when the flag is '1'; '0' reads no robots.txt at all, while
 * each crawler keeps its own pacing per host.
 */
import { describe, expect, it, vi } from 'vitest';
import { robotsEnforced } from '../scripts/lib/robots-policy.mjs';
import { createPoliteClient } from '../scripts/lib/ticino-comuni-polite-client.mjs';

describe('robotsEnforced', () => {
  it('respects robots.txt unless the flag says 0', () => {
    expect(robotsEnforced({})).toBe(true);
    expect(robotsEnforced({ CRAWLER_RESPECT_ROBOTS: '1' })).toBe(true);
    expect(robotsEnforced({ CRAWLER_RESPECT_ROBOTS: ' 0 ' })).toBe(false);
  });
});

describe('ticino comuni polite client', () => {
  const robotsDisallowAll = () => new Response('User-agent: *\nDisallow: /\n', { status: 200 });

  it('refuses a disallowed path by default', async () => {
    const fetchImpl = vi.fn(async () => robotsDisallowAll());
    const client = createPoliteClient({ fetchImpl, sleep: async () => {}, respectRobots: true });
    expect((await client.canFetch('https://comune.test/albo')).allowed).toBe(false);
  });

  it('reads no robots.txt when told not to respect it', async () => {
    const fetchImpl = vi.fn(async () => robotsDisallowAll());
    const client = createPoliteClient({ fetchImpl, sleep: async () => {}, respectRobots: false });
    expect((await client.canFetch('https://comune.test/albo')).allowed).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
