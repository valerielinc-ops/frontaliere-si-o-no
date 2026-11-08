import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEngagementScoreUpdate } from '../functions/src/lib/engagementScore.js';

describe('newsletter send subscriber write cost', () => {
  it('projects the send increment before deriving the engagement score', () => {
    const nowMs = Date.now();
    const scoreUpdate = buildEngagementScoreUpdate({
      send_count: 5,
      open_count: 1,
      last_open_at: new Date(nowMs - 60 * 60 * 1000),
      engagement_score: 46,
      engagement_level: 'cool',
    }, {
      serverTimestamp: () => 'server-time',
    }, {
      subscriberUpdate: { send_count: { kind: 'increment', amount: 1 } },
      nowMs,
    });

    expect(scoreUpdate).toMatchObject({
      engagement_score: 43,
      engagement_level: 'cool',
      engagement_updated_at: 'server-time',
    });
  });

  it('writes the send counter and its derived score through one subscriber transaction', () => {
    const source = readFileSync('scripts/send-newsletter.mjs', 'utf8');
    const start = source.indexOf('async function persistDelivery');
    const end = source.indexOf('async function persistAmbiguousDelivery', start);
    const persistDelivery = source.slice(start, end);

    expect(persistDelivery).toContain('db.runTransaction');
    expect(persistDelivery).toContain('buildEngagementScoreUpdate');
    expect(persistDelivery).toContain('transaction.set(subRef, { ...subUpdate, ...scoreUpdate }');
    expect(persistDelivery).not.toContain('refreshEngagementScore');
  });
});
