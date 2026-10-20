/**
 * The 2026-10-05 saved-jobs digest backfill activates only never-decided
 * digests that the digest's own delivery gate would accept.
 */
import { describe, expect, it } from 'vitest';
import { backfillDecision } from '../scripts/backfill-saved-jobs-digest-optin.mjs';

const subscriber = { status: 'confirmed' };

describe('backfillDecision', () => {
  it('activates a never-decided digest with a deliverable subscriber record', () => {
    expect(backfillDecision({ email: 'a@example.com' }, subscriber)).toEqual({ activate: true, reason: 'activate' });
    expect(backfillDecision({ email: 'a@example.com', savedJobsDigest: { optedIn: false, optedOut: false } }, subscriber).activate).toBe(true);
  });

  it('never overrides an explicit stop or rewrites an active digest', () => {
    expect(backfillDecision({ email: 'a@example.com', savedJobsDigest: { optedOut: true } }, subscriber).reason).toBe('opted_out');
    expect(backfillDecision({ email: 'a@example.com', savedJobsDigest: { optedIn: true } }, subscriber).reason).toBe('already_on');
  });

  it('skips accounts the digest could not deliver to', () => {
    expect(backfillDecision(null, subscriber).reason).toBe('no_user_doc');
    expect(backfillDecision({ email: '' }, subscriber).reason).toBe('no_email');
    expect(backfillDecision({ email: 'a@example.com' }, null).reason).toBe('no_subscriber_record');
    expect(backfillDecision({ email: 'a@example.com' }, { status: 'unsubscribed' }).reason).toBe('cross_channel_stop');
    expect(backfillDecision({ email: 'a@example.com' }, { status: 'bounced' }).reason).toBe('cross_channel_stop');
  });
});
