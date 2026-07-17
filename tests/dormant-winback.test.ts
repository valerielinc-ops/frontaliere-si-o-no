import { describe, it, expect } from 'vitest';
import {
  classifyDormantWinback,
  MIN_SENDS_BEFORE_WINBACK,
  STAGE1_GRACE_DAYS,
  STAGE2_GRACE_DAYS,
} from '../scripts/lib/dormantWinback.mjs';
import { SUNSET_MIN_SENDS, SUNSET_MIN_AGE_DAYS } from '../scripts/lib/subscriberSunset.mjs';

// classifyDormantWinback derives its engagement tier from calculateEngagementScore
// (functions/src/lib/engagementScore.js), which reads the REAL Date.now() for its
// recency component (not an injectable clock) — see the module doc. So fixtures
// must be relative to actual now, never a hardcoded/absolute epoch.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

// A dormant subscriber past the send floor but NOT old/frequent enough to be
// owned by the zombie-sunset track (scripts/lib/subscriberSunset.mjs).
function dormantSub(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    send_count: MIN_SENDS_BEFORE_WINBACK + 2,
    open_count: 0,
    click_count: 0,
    created_at: daysAgo(30),
    ...overrides,
  };
}

describe('classifyDormantWinback', () => {
  it('starts stage 1 for a dormant subscriber past the send floor', () => {
    expect(classifyDormantWinback(dormantSub(), NOW).action).toBe('stage1');
  });

  it('does not touch subscribers below the send floor (too new to judge)', () => {
    const tooNew = dormantSub({ send_count: MIN_SENDS_BEFORE_WINBACK - 1 });
    expect(classifyDormantWinback(tooNew, NOW).action).toBe('none');
  });

  it('does nothing for a subscriber who was never dormant', () => {
    const engaged = dormantSub({ send_count: 10, open_count: 8, last_open_at: daysAgo(2) });
    const verdict = classifyDormantWinback(engaged, NOW);
    expect(verdict.action).toBe('none');
    expect(verdict.reason).toMatch(/not dormant/);
  });

  it('defers to the zombie-sunset track once the subscriber crosses its floor (mutually exclusive)', () => {
    const zombieFloor = dormantSub({
      send_count: SUNSET_MIN_SENDS + 1,
      created_at: daysAgo(SUNSET_MIN_AGE_DAYS + 10),
    });
    expect(classifyDormantWinback(zombieFloor, NOW).action).toBe('none');
  });

  it('defers to the zombie-sunset track once it has already stamped winback_sent_at, even below the sunset floor', () => {
    const alreadyOnSunsetTrack = dormantSub({ winback_sent_at: daysAgo(3) });
    expect(classifyDormantWinback(alreadyOnSunsetTrack, NOW).action).toBe('none');
  });

  it('waits out the stage-1 grace window before moving to stage 2', () => {
    const withinGrace = dormantSub({ dormant_winback_stage1_sent_at: daysAgo(STAGE1_GRACE_DAYS - 1) });
    expect(classifyDormantWinback(withinGrace, NOW).action).toBe('none');

    const graceExpired = dormantSub({ dormant_winback_stage1_sent_at: daysAgo(STAGE1_GRACE_DAYS + 1) });
    expect(classifyDormantWinback(graceExpired, NOW).action).toBe('stage2');
  });

  it('waits out the stage-2 grace window before sunsetting', () => {
    const withinGrace = dormantSub({
      dormant_winback_stage1_sent_at: daysAgo(STAGE1_GRACE_DAYS + 30),
      dormant_winback_stage2_sent_at: daysAgo(STAGE2_GRACE_DAYS - 1),
    });
    expect(classifyDormantWinback(withinGrace, NOW).action).toBe('none');

    const graceExpired = dormantSub({
      dormant_winback_stage1_sent_at: daysAgo(STAGE1_GRACE_DAYS + 30),
      dormant_winback_stage2_sent_at: daysAgo(STAGE2_GRACE_DAYS + 1),
    });
    expect(classifyDormantWinback(graceExpired, NOW).action).toBe('sunset');
  });

  it('reactivates (clears the stage clock) when engagement recovers mid-sequence', () => {
    const recovered = dormantSub({
      dormant_winback_stage1_sent_at: daysAgo(5),
      open_count: 3,
      send_count: 10,
      last_open_at: daysAgo(1), // pushes the fresh tier out of 'dormant'
    });
    expect(classifyDormantWinback(recovered, NOW).action).toBe('reactivate');
  });

  it('never touches unsubscribed / bounced / complained / suppressed, even if dormant', () => {
    for (const status of ['unsubscribed', 'bounced', 'complained', 'suppressed']) {
      expect(classifyDormantWinback(dormantSub({ status }), NOW).action).toBe('none');
    }
  });

  it('leaves an already-inactive subscriber alone (owned by the other track\'s reactivate)', () => {
    expect(classifyDormantWinback(dormantSub({ status: 'inactive' }), NOW).action).toBe('none');
  });

  it('treats a missing status as mailable', () => {
    const noStatus = dormantSub();
    delete (noStatus as Record<string, unknown>).status;
    expect(classifyDormantWinback(noStatus, NOW).action).toBe('stage1');
  });

  it('honors the camelCase field spellings too', () => {
    const camel = {
      status: 'active',
      sendCount: MIN_SENDS_BEFORE_WINBACK + 2,
      openCount: 0,
      clickCount: 0,
      createdAt: daysAgo(30),
    };
    expect(classifyDormantWinback(camel, NOW).action).toBe('stage1');
  });
});
