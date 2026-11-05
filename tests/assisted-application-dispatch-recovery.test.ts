import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import {
  RUN_WATCHDOG_MS,
  applyAutomationEvent,
  runAutomationSweep,
  scheduleDispatchRecovery,
} from '../functions/src/assistedApplicationAutomation.js';
import { DISPATCH_RECOVERY_DELAY_MS, dispatchRecoveryDueAt, preDispatchFailureCode } from '../functions/src/assistedApplicationDispatchRetryPolicy.js';

const now = Date.UTC(2026, 10, 5, 21, 0, 0);
const orderId = 'dispatch_recovery_test';
const orderPath = `assisted_applications/${orderId}`;

function storeFor(flow: Record<string, unknown>) {
  return createMemoryFirestore({
    [orderPath]: {
      paymentStatus: 'paid', submissionStatus: 'awaiting_upload', automationState: flow.state,
      ...(flow.dispatchRecoveryAt ? { automationDueAt: flow.dispatchRecoveryAt } : {}),
    },
    [`${orderPath}/automation/flow`]: flow,
    [`${orderPath}/ai_drafts/current`]: { status: 'ready', round: 1 },
  });
}

describe('safe recovery after a pre-dispatch failure', () => {
  it('normalizes a transport code when the timeout message proves pre-dispatch failure', () => {
    expect(preDispatchFailureCode({
      code: 'ERR_NETWORK',
      message: 'Remote Config template fetch timed out after 8000ms and no cached template is available',
    })).toBe('REMOTE_CONFIG_FETCH_TIMEOUT');
  });

  it('schedules exactly one delayed retry for a Remote Config timeout', async () => {
    const store = storeFor({
      state: 'regenerating', round: 2,
      dispatch: { mode: 'draft', round: 2, attempts: 1, requestedAt: now },
    });

    expect(await scheduleDispatchRecovery({
      db: store.db, orderId, nowMs: now, failureCode: 'REMOTE_CONFIG_FETCH_TIMEOUT',
    })).toMatchObject({ scheduled: true, dueAt: now + DISPATCH_RECOVERY_DELAY_MS });
    expect(store.read(`${orderPath}/automation/flow`)).toMatchObject({
      dispatchRecoveryCount: 1,
      dispatchRecoveryAt: now + DISPATCH_RECOVERY_DELAY_MS,
    });
    expect(dispatchRecoveryDueAt(store.read(`${orderPath}/automation/flow`))).toBe(now + DISPATCH_RECOVERY_DELAY_MS);
    expect(store.read(orderPath).automationDueAt).toBe(now + DISPATCH_RECOVERY_DELAY_MS);
    expect(await scheduleDispatchRecovery({
      db: store.db, orderId, nowMs: now, failureCode: 'REMOTE_CONFIG_FETCH_TIMEOUT',
    })).toMatchObject({ scheduled: false, ignored: 'dispatch_recovery_limit' });
  });

  it('does not schedule an ambiguous post-dispatch failure', async () => {
    const store = storeFor({
      state: 'regenerating', round: 2,
      dispatch: { mode: 'draft', round: 2, attempts: 1, requestedAt: now },
    });
    expect(await scheduleDispatchRecovery({
      db: store.db, orderId, nowMs: now, failureCode: 'FETCH_FAILED_AFTER_POST',
    })).toMatchObject({ scheduled: false, ignored: 'failure_not_pre_dispatch' });
    expect(store.read(orderPath).automationDueAt).toBeUndefined();
  });

  it('consumes the short clock once and returns to the normal watchdog', async () => {
    const store = storeFor({
      state: 'regenerating', round: 2, dispatchRecoveryCount: 1, dispatchRecoveryAt: now,
      dispatch: { mode: 'draft', round: 2, attempts: 1, requestedAt: now - DISPATCH_RECOVERY_DELAY_MS },
    });
    const effects: any[] = [];
    const runEffect = async (context: any) => { effects.push(context.effect); return { ok: true }; };

    expect(await runAutomationSweep({ db: store.db, runEffect, nowMs: now })).toMatchObject({ redispatched: 1 });
    expect(effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'watchdog' }]);
    expect(store.read(`${orderPath}/automation/flow`)).toMatchObject({
      dispatchRecoveryAt: null,
      dispatch: { attempts: 2 },
    });
    expect(store.read(orderPath).automationDueAt).toBe(now + RUN_WATCHDOG_MS);
  });

  it('schedules recovery when a normal transition effect hits the timeout', async () => {
    const store = storeFor({
      state: 'owner_takeover', round: 2, heldBy: ['draft_failed'], draftAutoRetryCount: 0,
      draftAutoRetryAt: now, dispatch: { mode: 'draft', round: 2, attempts: 1 },
    });
    const runEffect = async () => {
      const error: any = new Error('Remote Config template fetch timed out after 8000ms and no cached template is available');
      error.code = 'REMOTE_CONFIG_FETCH_TIMEOUT';
      throw error;
    };

    const result: any = await applyAutomationEvent({
      db: store.db, orderId, event: { type: 'draft_auto_retry' }, runEffect, nowMs: now,
    });
    expect(result).toMatchObject({ ok: true, effectResults: [{ ok: false, errorCode: 'REMOTE_CONFIG_FETCH_TIMEOUT', recovery: { scheduled: true } }] });
    expect(store.read(`${orderPath}/automation/flow`)).toMatchObject({
      state: 'regenerating', dispatchRecoveryCount: 1, dispatchRecoveryAt: now + DISPATCH_RECOVERY_DELAY_MS,
    });
  });
});
