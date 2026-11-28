import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
vi.mock('../functions/src/assistedApplicationPostalPacket.js', () => ({ postalPacketReadiness: vi.fn(() => ({ ready: true })) }));
import { applyAutomationEvent } from '../functions/src/assistedApplicationAutomation.js';
import { runAutomationEffect } from '../functions/src/assistedApplicationAutomationEffects.js';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import {
  FALLBACK_CLAIM_TTL_MS, LOCAL_DISPATCH_COLLECTION, LOCAL_RUNNERS_COLLECTION, SWISS_RUNNER_PICKUP_MS,
  enqueueLocalDispatch, holdUnservedLocalDispatches, leaseLocalDispatch, localDispatchKey, localDispatchStaleReason,
} from '../functions/src/assistedApplicationSwissRunner.js';

// A portal that answered HTTP 429 to GitHub's exit three times in a row (STA, 2026-11-28: every one of those runs
// had a GitHub run id; none had run from the Swiss runner): the retry of the `rate_limit` lane prefers the Swiss
// runner when one is alive, and stays on GitHub when none is. Opaque ids and synthetic data only.
const now = Date.UTC(2026, 10, 28, 12, 0, 0);
const orderId = 'rate_limited_order';
const orderPath = `assisted_applications/${orderId}`;
const flowPath = `${orderPath}/automation/flow`;
const queuePath = `${LOCAL_DISPATCH_COLLECTION}/${orderId}`;
const draft = { verdict: 'good', job: { source: 'job_detail' }, channel: { type: 'portal' }, factCheck: { ok: true, unsupported: [] }, questions: [], status: 'ready', round: 1 };
const dispatch = { mode: 'submit', round: 1, attempts: 1, requestedAt: now - 3_600_000 };
const heldRateLimited = { state: 'owner_takeover', round: 1, heldBy: ['portal:portal_rate_limited'], portalAutoRetryAt: now - 1000, portalRateLimitRetryCount: 0, dispatch };
const aliveSwiss = { at: now - 1000, eligible: true, egressCountry: 'CH', codeAt: now - 3_600_000 };

describe('the retry of a rate-limited portal prefers the Swiss runner', () => {
  it('asks for the Swiss exit on the rate-limit retry, and on no other retry', () => {
    const retry = transition(heldRateLimited, { type: 'portal_auto_retry' }, { draft, nowMs: now });
    expect(retry.flow).toMatchObject({ state: 'submitting', portalRateLimitRetryCount: 1 });
    expect(retry.flow.egress).toBeUndefined();
    expect(retry.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry', preferEgress: 'ch' }]);
    const transport = transition({ ...heldRateLimited, heldBy: ['portal:navigation_unavailable'], transportAutoRetryCount: 0 }, { type: 'portal_auto_retry' }, { draft, nowMs: now });
    expect(transport.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' }]);
    const mismatch = transition({ ...heldRateLimited, heldBy: ['portal:portal_needs_candidate'], portalAutoRetryCount: 0 }, { type: 'portal_auto_retry' }, { draft, nowMs: now });
    expect(mismatch.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' }]);
  });
});

describe('the owner retry of a rate-limited portal', () => {
  it('prefers the Swiss exit on a rate-limit hold, and on no other hold', () => {
    const retry = transition({ ...heldRateLimited, portalAutoRetryAt: now + 3_600_000, portalRateLimitRetryCount: 2 }, { type: 'owner_retry_submit' }, { draft, nowMs: now });
    expect(retry.flow).toMatchObject({ state: 'submitting', portalRateLimitRetryCount: 0, portalAutoRetryAt: null });
    expect(retry.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'owner_retry', preferEgress: 'ch' }]);
    const other = transition({ ...heldRateLimited, heldBy: ['portal:navigation_unavailable'] }, { type: 'owner_retry_submit' }, { draft, nowMs: now });
    expect(other.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'owner_retry' }]);
  });
});

describe('the dispatch effect', () => {
  const submitting = { state: 'submitting', round: 1, dispatch };
  const effect = { type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry', preferEgress: 'ch' };
  const run = async (overrides: Record<string, any> = {}, flow: any = submitting, e: any = effect) => {
    const github = vi.fn(async () => ({ ok: true }));
    const enqueueLocal = vi.fn(async () => ({ ok: true, channel: 'swiss_local' }));
    const result = await runAutomationEffect({ db: {}, orderId, effect: e, flow, nowMs: now }, { dispatch: github, enqueueLocal, ...overrides } as any);
    return { github, enqueueLocal, result };
  };

  it('queues the run for the Swiss runner, as a preference, while one is alive and fresh', async () => {
    const { github, enqueueLocal } = await run({ swissOnline: async () => ({ online: true, reason: null, runners: 1 }) });
    expect(enqueueLocal).toHaveBeenCalledTimes(1);
    expect((enqueueLocal.mock.calls[0] as any[])[0]).toMatchObject({ orderId, mode: 'submit', preferred: true, reason: 'portal_auto_retry' });
    expect(github).not.toHaveBeenCalled();
  });

  it('stays on GitHub when no Swiss runner is eligible, when its heartbeat cannot be read, or when GitHub is forced', async () => {
    for (const overrides of [
      { swissOnline: async () => ({ online: false, reason: 'heartbeat_stale', runners: 0 }) },
      { swissOnline: async () => { throw new Error('unavailable'); } },
    ]) {
      const { github, enqueueLocal } = await run(overrides);
      expect(github).toHaveBeenCalledTimes(1);
      expect(enqueueLocal).not.toHaveBeenCalled();
    }
    const forced = await run({ swissOnline: async () => ({ online: true }) }, submitting, { ...effect, forceGithub: true });
    expect(forced.github).toHaveBeenCalledTimes(1);
    expect(forced.enqueueLocal).not.toHaveBeenCalled();
    const plain = await run({ swissOnline: async () => ({ online: true }) }, submitting, { type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' });
    expect(plain.github).toHaveBeenCalledTimes(1);
    expect(plain.enqueueLocal).not.toHaveBeenCalled();
  });

  it('keeps an order that requires the Swiss exit on the Swiss queue, unconditionally and not as a preference', async () => {
    const { github, enqueueLocal } = await run({ swissOnline: async () => ({ online: false }) },
      { ...submitting, egress: { required: 'ch', reason: 'application_region_unsupported', round: 1, at: now, source: 'portal_handoff' } });
    expect(enqueueLocal).toHaveBeenCalledTimes(1);
    expect((enqueueLocal.mock.calls[0] as any[])[0].preferred).toBeUndefined();
    expect(github).not.toHaveBeenCalled();
  });
});

describe('a preferred request in the Swiss queue', () => {
  const requestedAt = now - 60_000;
  const submitting = { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt } };
  const key = localDispatchKey({ mode: 'submit', round: 1, requestedAt });
  const pending = (extra: Record<string, unknown> = {}) => ({
    orderId, key, mode: 'submit', round: 1, requestedAt, queuedAt: requestedAt, status: 'pending', egress: 'ch', preferred: true, lease: null, ...extra,
  });
  const store = (flow: any, queue: any, extra: Record<string, any> = {}) => createMemoryFirestore({
    [orderPath]: { paymentStatus: 'paid', submissionStatus: 'in_progress' },
    [flowPath]: flow,
    [`${orderPath}/ai_drafts/current`]: { status: 'ready', round: 1 },
    ...(queue ? { [queuePath]: queue } : {}),
    ...extra,
  });

  it('is written with its preference and is leased although the flow carries no Swiss mark', async () => {
    const s = store(submitting, null);
    await enqueueLocalDispatch({ db: s.db, orderId, flow: submitting, mode: 'submit', reason: 'portal_auto_retry', preferred: true, nowMs: now });
    expect(s.read(queuePath)).toMatchObject({ preferred: true, status: 'pending', egress: 'ch' });
    const { leased, stale } = await leaseLocalDispatch({ db: s.db, runnerId: 'swiss-a', nowMs: now });
    expect(stale).toEqual([]);
    expect(leased).toMatchObject({ orderId, key, lease: { runnerId: 'swiss-a' } });
  });

  it('is only stale when the flow moved on, while a required request without the mark stays stale', () => {
    const item = pending();
    const order = { paymentStatus: 'paid' };
    expect(localDispatchStaleReason(item, submitting, order)).toBeNull();
    expect(localDispatchStaleReason(item, { ...submitting, round: 2 }, order)).toBe('stale_round');
    expect(localDispatchStaleReason(item, { ...submitting, dispatch: { ...submitting.dispatch, requestedAt: requestedAt + 1 } }, order)).toBe('superseded');
    expect(localDispatchStaleReason({ ...item, preferred: false }, submitting, order)).toBe('egress_not_required');
  });

  it('falls back to GitHub, never holds the order, when nobody took it and no Swiss runner is alive', async () => {
    const s = store(submitting, pending({ queuedAt: now - SWISS_RUNNER_PICKUP_MS - 1 }));
    const events: any[] = [];
    const runEffect = vi.fn(async (context: any) => { events.push(context.effect); return { ok: true }; });
    const applyEvent = vi.fn(applyAutomationEvent as any);
    const summary = await holdUnservedLocalDispatches({ db: s.db, nowMs: now, runEffect, applyEvent } as any);
    expect(summary).toMatchObject({ held: 0, fellBack: 1 });
    expect(applyEvent).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'swiss_preferred_fallback', preferEgress: null, forceGithub: true, dispatchKey: `${key}:github` }]);
    expect(s.read(queuePath)).toMatchObject({ status: 'fallback_dispatched', result: { code: 'swiss_preferred_fallback' }, fallback: { dispatchKey: `${key}:github` } });
    expect(events[0].dispatchKey).toBe(`${key}:github`);
    expect(s.read(flowPath)?.state).toBe('submitting');
    // The same sweep again dispatches nothing more: the request is closed.
    const again = await holdUnservedLocalDispatches({ db: s.db, nowMs: now + 1000, runEffect, applyEvent } as any);
    expect(again.due).toBe(0);
    expect(runEffect).toHaveBeenCalledTimes(1);
  });

  describe('the fallback dispatches once per request key', () => {
    const due = pending({ queuedAt: now - SWISS_RUNNER_PICKUP_MS - 1 });
    // The second transaction of the first sweep (the final write after GitHub accepted the run) fails.
    const flakyFinalWrite = (db: any) => {
      let calls = 0;
      return { collection: db.collection.bind(db), runTransaction: (fn: any) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('DEADLINE_EXCEEDED'));
        return db.runTransaction(fn);
      } };
    };

    it('GitHub accepts it, the final write fails, a live Swiss runner shows up: one dispatch, no Swiss lease, never pending', async () => {
      const s = store(submitting, due);
      const runEffect = vi.fn(async () => ({ ok: true }));
      const first = await holdUnservedLocalDispatches({ db: flakyFinalWrite(s.db), nowMs: now, runEffect, applyEvent: applyAutomationEvent as any } as any);
      expect(first.fellBack).toBe(1);
      expect(runEffect).toHaveBeenCalledTimes(1);
      expect(s.read(queuePath)).toMatchObject({ status: 'fallback_claimed', fallback: { dispatchKey: `${key}:github` } });

      // A Swiss runner is alive on the next sweep: it must not get the request, and nothing is dispatched again.
      s.docs.set(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`, { ...aliveSwiss, at: now + 59_000 });
      const second = await holdUnservedLocalDispatches({ db: s.db, nowMs: now + 60_000, runEffect, applyEvent: applyAutomationEvent as any } as any);
      expect(second.fellBack).toBeUndefined();
      expect(runEffect).toHaveBeenCalledTimes(1);
      expect(s.read(queuePath)?.status).toBe('fallback_claimed');
      expect((await leaseLocalDispatch({ db: s.db, runnerId: 'swiss-a', nowMs: now + 61_000 })).leased).toBeNull();
      expect(s.read(queuePath)?.status).toBe('fallback_claimed');

      // The claim has no outcome: it is closed as unconfirmed, never re-dispatched, never leased.
      const third = await holdUnservedLocalDispatches({ db: s.db, nowMs: now + FALLBACK_CLAIM_TTL_MS + 1, runEffect, applyEvent: applyAutomationEvent as any } as any);
      expect(third.fallbackUnconfirmed).toBe(1);
      expect(s.read(queuePath)).toMatchObject({ status: 'fallback_unconfirmed' });
      expect((await leaseLocalDispatch({ db: s.db, runnerId: 'swiss-a', nowMs: now + FALLBACK_CLAIM_TTL_MS + 2 })).leased).toBeNull();
      expect(runEffect).toHaveBeenCalledTimes(1);
    });

    it('a repeated sweep never claims the same request twice, and a failed dispatch is not retried under the same key', async () => {
      const s = store(submitting, due);
      const runEffect = vi.fn(async () => { throw new Error('github_unavailable'); });
      const first = await holdUnservedLocalDispatches({ db: s.db, nowMs: now, runEffect, applyEvent: applyAutomationEvent as any } as any);
      expect(first.fellBack).toBeUndefined();
      expect(s.read(queuePath)).toMatchObject({ status: 'fallback_failed', result: { code: 'fallback_dispatch_failed' } });
      for (let i = 1; i <= 3; i += 1) {
        await holdUnservedLocalDispatches({ db: s.db, nowMs: now + i * 60_000, runEffect, applyEvent: applyAutomationEvent as any } as any);
      }
      expect(runEffect).toHaveBeenCalledTimes(1);
      // A refused dispatch (no exception) is the same.
      const refused = store(submitting, due);
      const refuse = vi.fn(async () => ({ ok: false }));
      await holdUnservedLocalDispatches({ db: refused.db, nowMs: now, runEffect: refuse, applyEvent: applyAutomationEvent as any } as any);
      await holdUnservedLocalDispatches({ db: refused.db, nowMs: now + 60_000, runEffect: refuse, applyEvent: applyAutomationEvent as any } as any);
      expect(refuse).toHaveBeenCalledTimes(1);
      expect(refused.read(queuePath)?.status).toBe('fallback_failed');
    });
  });
});
