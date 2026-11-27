import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import {
  RUN_WATCHDOG_MS,
  runAutomationSweep,
  startAutomation,
} from '../functions/src/assistedApplicationAutomation.js';
import { DISPATCH_CONFIRM_WINDOW_MS } from '../functions/src/assistedApplicationDispatchRetryPolicy.js';

const T0 = Date.UTC(2026, 10, 27, 20, 55, 0);
const ORDER = 'order_CONFIRM1';
const ORDER_PATH = `assisted_applications/${ORDER}`;
const FLOW_PATH = `${ORDER_PATH}/automation/flow`;
const CV_KEY = `assisted-application-uploads/${ORDER}/1-cv.pdf`;

function newStore(extra: Record<string, unknown> = {}) {
  return createMemoryFirestore({
    [ORDER_PATH]: {
      orderId: ORDER, paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission',
      jobTitle: 'Infermiere', companyName: 'Ospedale', locale: 'it', applicantEmail: 'candidate@example.test',
      cvStorageKey: CV_KEY, cvFileCheck: { key: CV_KEY, verdict: 'ok', detectedType: 'pdf' },
      ...extra,
    },
  });
}

function recorder(result: Record<string, unknown> = { ok: true }) {
  const effects: any[] = [];
  const runEffect = async (context: any) => { effects.push(context.effect); return result; };
  return { effects, runEffect };
}

describe('a recorded dispatch the process never carried out', () => {
  it('is re-dispatched once by the sweep after the confirm window, not after the 150 minute watchdog', async () => {
    const store = newStore();
    // No runEffect: the transition is committed and the process "dies" before the effect, as in the OOM of 27/11.
    await startAutomation({ db: store.db, orderId: ORDER, nowMs: T0 });
    const flow = store.read(FLOW_PATH);
    expect(flow.dispatch).toMatchObject({ requestedAt: T0, attempts: 1, confirmedAt: null, confirmBy: T0 + DISPATCH_CONFIRM_WINDOW_MS });
    expect(store.read(ORDER_PATH).automationDueAt).toBe(T0 + DISPATCH_CONFIRM_WINDOW_MS);
    expect(DISPATCH_CONFIRM_WINDOW_MS).toBeLessThan(RUN_WATCHDOG_MS);

    const early = recorder();
    await runAutomationSweep({ db: store.db, runEffect: early.runEffect, nowMs: T0 + DISPATCH_CONFIRM_WINDOW_MS - 1 });
    expect(early.effects).toEqual([]);

    const due = recorder();
    const at = T0 + DISPATCH_CONFIRM_WINDOW_MS;
    expect(await runAutomationSweep({ db: store.db, runEffect: due.runEffect, nowMs: at })).toMatchObject({ redispatched: 1 });
    expect(due.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'watchdog' }]);
    expect(store.read(FLOW_PATH).dispatch).toMatchObject({ attempts: 2, requestedAt: at, confirmBy: null });
    expect(store.read(ORDER_PATH).automationDueAt).toBe(at + RUN_WATCHDOG_MS);

    // Bounded: a second silence is the watchdog's, never another short retry.
    const again = recorder();
    await runAutomationSweep({ db: store.db, runEffect: again.runEffect, nowMs: at + DISPATCH_CONFIRM_WINDOW_MS });
    expect(again.effects).toEqual([]);
  });

  it('is never re-dispatched when its effect reported success', async () => {
    const store = newStore();
    const { effects, runEffect } = recorder();
    await startAutomation({ db: store.db, orderId: ORDER, runEffect, nowMs: T0 });
    expect(effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'owner_request' }]);
    expect(store.read(FLOW_PATH).dispatch).toMatchObject({ confirmedAt: T0, confirmBy: null });
    expect(store.read(ORDER_PATH).automationDueAt).toBe(T0 + RUN_WATCHDOG_MS);

    const sweep = recorder();
    await runAutomationSweep({ db: store.db, runEffect: sweep.runEffect, nowMs: T0 + DISPATCH_CONFIRM_WINDOW_MS + 1 });
    expect(sweep.effects).toEqual([]);
  });

  it('is left to the run watchdog when the effect failed in an ambiguous way', async () => {
    const store = newStore();
    const runEffect = async () => { throw new Error('agent_dispatch_failed:502:bad gateway'); };
    await startAutomation({ db: store.db, orderId: ORDER, runEffect, nowMs: T0 });
    expect(store.read(FLOW_PATH).dispatch).toMatchObject({ confirmBy: null, confirmedAt: null });
    expect(store.read(ORDER_PATH).automationDueAt).toBe(T0 + RUN_WATCHDOG_MS);
  });

  it('is not re-dispatched when the run already recorded its send attempt for the round', async () => {
    const store = newStore();
    await startAutomation({ db: store.db, orderId: ORDER, nowMs: T0 });
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('submission').set({ r1: { state: 'attempting', channel: 'portal' } });
    const sweep = recorder();
    await runAutomationSweep({ db: store.db, runEffect: sweep.runEffect, nowMs: T0 + DISPATCH_CONFIRM_WINDOW_MS });
    expect(sweep.effects).toEqual([]);
    expect(store.read(FLOW_PATH).dispatch).toMatchObject({ confirmBy: null, confirmedAt: T0 + DISPATCH_CONFIRM_WINDOW_MS });
    expect(store.read(ORDER_PATH).automationDueAt).toBe(T0 + RUN_WATCHDOG_MS);
  });
});
