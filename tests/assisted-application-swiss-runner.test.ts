import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { applyAutomationEvent, runAutomationSweep } from '../functions/src/assistedApplicationAutomation.js';
import { runAutomationEffect } from '../functions/src/assistedApplicationAutomationEffects.js';
import { describeTakeover } from '../functions/src/assistedApplicationAutomationEmails.js';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { TRANSPORT_AUTO_RETRY_DELAYS_MS } from '../functions/src/assistedApplicationPortalRetryPolicy.js';
import {
  LOCAL_DISPATCH_COLLECTION,
  LOCAL_DISPATCH_LEASE_MS,
  LOCAL_DISPATCH_PREP_MAX_ATTEMPTS,
  LOCAL_RUNNERS_COLLECTION,
  SWISS_RUNNER_HEARTBEAT_STALE_MS,
  SWISS_RUNNER_PICKUP_MS,
  completeLocalDispatch,
  enqueueLocalDispatch,
  leaseLocalDispatch,
  localDispatchKey,
  swissRunnerAvailability,
} from '../functions/src/assistedApplicationSwissRunner.js';
import {
  agentEnvironment,
  createLogMasker,
  egressVerdict,
  parseExportLines,
  readEgressCountry,
  runCycle,
  systemChromeFor,
} from '../scripts/assisted-application/local-runner.mjs';

// Opaque ids and synthetic data only: no candidate, no portal answer.
const now = Date.UTC(2026, 10, 11, 9, 0, 0);
const orderId = 'swiss_runner_order';
const orderPath = `assisted_applications/${orderId}`;
const flowPath = `${orderPath}/automation/flow`;
const queuePath = `${LOCAL_DISPATCH_COLLECTION}/${orderId}`;
const mark = { required: 'ch', reason: 'application_region_unsupported', round: 1, at: now - 60_000, source: 'portal_handoff' };

function storeWith(flow: Record<string, unknown>, extra: Record<string, Record<string, unknown>> = {}) {
  return createMemoryFirestore({
    [orderPath]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: flow.state },
    [flowPath]: flow,
    [`${orderPath}/ai_drafts/current`]: { status: 'ready', round: 1 },
    ...extra,
  });
}

function heldForRetry(heldBy: string[], egress: Record<string, unknown> | null) {
  return {
    state: 'owner_takeover', round: 1, heldBy,
    portalAutoRetryAt: now - 1000, transportAutoRetryCount: 0, portalAutoRetryCount: 0,
    dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt: now - 3_600_000 },
    ...(egress ? { egress } : {}),
  };
}

function effectRunner(github: ReturnType<typeof vi.fn>, others: any[] = []) {
  return async (context: any) => {
    if (context.effect.type === 'dispatch') return runAutomationEffect(context, { dispatch: github });
    others.push(context.effect);
    return { ok: true };
  };
}

function okText(text: string) {
  return async () => ({ ok: true, text: async () => text });
}

describe('Swiss egress mark', () => {
  it('a regional notice marks the order with its proof, and the mark survives every later transition', () => {
    const held = transition(
      { state: 'submitting', round: 2, dispatch: { mode: 'submit', round: 2, attempts: 1 } },
      { type: 'submit_handoff', reason: 'application_region_unsupported' } as any,
      { draft: { round: 2 }, nowMs: now },
    );
    expect(held.flow.egress).toEqual({ required: 'ch', reason: 'application_region_unsupported', round: 2, at: now, source: 'portal_handoff' });
    const retried = transition({ ...held.flow, dispatch: { mode: 'submit', round: 2, attempts: 1 } }, { type: 'owner_retry_submit' }, { draft: { round: 2 }, nowMs: now + 1 });
    expect(retried.flow).toMatchObject({ state: 'submitting', egress: held.flow.egress });
  });

  it('another portal stop does not mark the order', () => {
    const held = transition(
      { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1, attempts: 1 } },
      { type: 'submit_handoff', reason: 'portal_needs_candidate' } as any,
      { draft: { round: 1 }, nowMs: now },
    );
    expect(held.flow.egress).toBeUndefined();
  });
});

describe('dispatch of a marked order', () => {
  it('queues the run for the Swiss runner instead of calling GitHub', async () => {
    const store = storeWith(heldForRetry(['portal:application_region_unsupported'], mark));
    const github = vi.fn(async () => ({ ok: true }));
    const result: any = await applyAutomationEvent({ db: store.db, orderId, event: { type: 'portal_auto_retry' }, runEffect: effectRunner(github), nowMs: now });

    expect(result).toMatchObject({ ok: true, effectResults: [{ ok: true, channel: 'swiss_local', queued: true }] });
    expect(github).not.toHaveBeenCalled();
    expect(store.read(queuePath)).toMatchObject({
      orderId, mode: 'submit', round: 1, requestedAt: now, status: 'pending', egress: 'ch',
      key: localDispatchKey({ mode: 'submit', round: 1, requestedAt: now }),
    });
    expect(store.read(flowPath)).toMatchObject({ state: 'submitting', egress: mark, dispatch: { mode: 'submit', requestedAt: now } });
  });

  it('marks and queues a flow held on the regional notice before the mark existed', async () => {
    const store = storeWith(heldForRetry(['portal:application_region_unsupported'], null));
    const github = vi.fn(async () => ({ ok: true }));
    await applyAutomationEvent({ db: store.db, orderId, event: { type: 'portal_auto_retry' }, runEffect: effectRunner(github), nowMs: now });

    expect(github).not.toHaveBeenCalled();
    expect(store.read(flowPath)?.egress).toMatchObject({ required: 'ch', source: 'region_hold', round: 1, at: now });
    expect(store.read(queuePath)).toMatchObject({ status: 'pending', mode: 'submit' });
  });

  it('an unmarked order calls GitHub as before and queues nothing', async () => {
    const store = storeWith(heldForRetry(['portal:portal_needs_candidate'], null));
    const github = vi.fn(async () => ({ ok: true }));
    await applyAutomationEvent({ db: store.db, orderId, event: { type: 'portal_auto_retry' }, runEffect: effectRunner(github), nowMs: now });

    expect(github).toHaveBeenCalledWith({ orderId, mode: 'submit', round: 1 });
    expect(store.read(queuePath)).toBeUndefined();
    expect(store.read(flowPath)?.egress).toBeUndefined();
  });

  it('the watchdog of a marked order queues a new request (new key), never GitHub', async () => {
    const requestedAt = now - 151 * 60 * 1000;
    const store = storeWith({ state: 'submitting', round: 1, egress: mark, dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt } }, {
      [queuePath]: { orderId, key: localDispatchKey({ mode: 'submit', round: 1, requestedAt }), mode: 'submit', round: 1, requestedAt, status: 'failed' },
    });
    store.docs.set(orderPath, { ...store.read(orderPath), automationDueAt: requestedAt + 150 * 60 * 1000 });
    const github = vi.fn(async () => ({ ok: true }));
    expect(await runAutomationSweep({ db: store.db, runEffect: effectRunner(github), nowMs: now } as any)).toMatchObject({ redispatched: 1 });
    expect(github).not.toHaveBeenCalled();
    expect(store.read(queuePath)).toMatchObject({ status: 'pending', requestedAt: now, key: localDispatchKey({ mode: 'submit', round: 1, requestedAt: now }) });
  });
});

describe('local dispatch lease', () => {
  const submitting = { state: 'submitting', round: 1, egress: mark, dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt: now } };

  it('the same request queued twice is one request', async () => {
    const store = storeWith(submitting);
    expect(await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now })).toMatchObject({ queued: true });
    expect(await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now + 5 })).toMatchObject({ queued: false, duplicate: true });
    expect(store.read(queuePath)?.queuedAt).toBe(now);
  });

  it('is exclusive: a second runner gets nothing, and only the holder releases it', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    const first = await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-a', nowMs: now + 1 });
    expect(first.leased).toMatchObject({ orderId, mode: 'submit', round: 1, lease: { runnerId: 'swiss-a', until: now + 1 + LOCAL_DISPATCH_LEASE_MS } });
    expect((await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-b', nowMs: now + 2 })).leased).toBeNull();
    expect((await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-a', nowMs: now + 3 })).leased).toBeNull();

    // Queued again while it runs (same key): still one run, still leased.
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now + 4 });
    expect(store.read(queuePath)).toMatchObject({ status: 'leased', lease: { runnerId: 'swiss-a' } });

    const key = first.leased!.key;
    expect(await completeLocalDispatch({ db: store.db, orderId, key, runnerId: 'swiss-b', outcome: { status: 'done', exitCode: 0 }, nowMs: now + 5 }))
      .toEqual({ released: false, reason: 'lease_lost' });
    expect(await completeLocalDispatch({ db: store.db, orderId, key, runnerId: 'swiss-a', outcome: { status: 'done', exitCode: 0 }, nowMs: now + 6 }))
      .toMatchObject({ released: true, status: 'done' });
    expect(store.read(queuePath)).toMatchObject({ status: 'done', lease: null, lastRun: { runnerId: 'swiss-a', status: 'done', exitCode: 0 } });
    expect((await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-b', nowMs: now + 7 })).leased).toBeNull();
  });

  it('a newer request queued during a run waits for the lease, then runs', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    const { leased } = await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-a', nowMs: now + 1 });
    const newer = { ...submitting, dispatch: { ...submitting.dispatch, attempts: 2, requestedAt: now + 10 } };
    store.docs.set(flowPath, newer);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: newer, mode: 'submit', nowMs: now + 10 });
    expect((await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-b', nowMs: now + 11 })).leased).toBeNull();
    expect(await completeLocalDispatch({ db: store.db, orderId, key: leased!.key, runnerId: 'swiss-a', outcome: { status: 'failed', exitCode: 1 }, nowMs: now + 12 }))
      .toMatchObject({ released: true, status: 'pending' });
    expect((await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-b', nowMs: now + 13 })).leased)
      .toMatchObject({ key: localDispatchKey({ mode: 'submit', round: 1, requestedAt: now + 10 }) });
  });

  it('closes, never runs, a request whose flow moved on', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    store.docs.set(flowPath, { ...submitting, state: 'owner_takeover', heldBy: ['owner'] });
    expect(await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-a', nowMs: now + 1 }))
      .toEqual({ leased: null, stale: [{ orderId, code: 'flow_not_running' }] });
    expect(store.read(queuePath)).toMatchObject({ status: 'stale', result: { code: 'flow_not_running' } });
  });

  it('a run that could not start goes back to the queue a bounded number of times', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    const statuses = [];
    for (let attempt = 0; attempt < LOCAL_DISPATCH_PREP_MAX_ATTEMPTS; attempt += 1) {
      const { leased } = await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-a', nowMs: now + attempt });
      statuses.push((await completeLocalDispatch({ db: store.db, orderId, key: leased!.key, runnerId: 'swiss-a', outcome: { status: 'retry', code: 'remote_config_unavailable' }, nowMs: now + attempt })).status);
    }
    expect(statuses).toEqual([...Array(LOCAL_DISPATCH_PREP_MAX_ATTEMPTS - 1).fill('pending'), 'failed']);
    expect((await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-a', nowMs: now + 10 })).leased).toBeNull();
  });
});

describe('Swiss runner offline', () => {
  const requestedAt = now - SWISS_RUNNER_PICKUP_MS - 1000;
  const submitting = { state: 'submitting', round: 1, egress: mark, dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt } };
  const pending = {
    orderId, key: localDispatchKey({ mode: 'submit', round: 1, requestedAt }), mode: 'submit', round: 1,
    requestedAt, queuedAt: requestedAt, status: 'pending', egress: 'ch',
  };

  it('a stale heartbeat holds the order for the owner with an explicit reason, and nothing goes to GitHub', async () => {
    const store = storeWith(submitting, {
      [queuePath]: pending,
      [`${LOCAL_RUNNERS_COLLECTION}/swiss-a`]: { runnerId: 'swiss-a', at: now - SWISS_RUNNER_HEARTBEAT_STALE_MS - 1, eligible: true, egressCountry: 'CH' },
    });
    const github = vi.fn(async () => ({ ok: true }));
    const others: any[] = [];
    expect(await runAutomationSweep({ db: store.db, runEffect: effectRunner(github, others), nowMs: now } as any)).toMatchObject({ swissRunnerHolds: 1 });

    expect(github).not.toHaveBeenCalled();
    expect(store.read(queuePath)).toMatchObject({ status: 'expired', result: { code: 'swiss_runner_offline', reason: 'heartbeat_stale' } });
    expect(store.read(flowPath)).toMatchObject({
      state: 'owner_takeover', heldBy: ['portal:swiss_runner_offline'], egress: mark,
      swissRunnerOffline: { reason: 'heartbeat_stale', mode: 'submit', round: 1, at: now },
      portalAutoRetryAt: now + TRANSPORT_AUTO_RETRY_DELAYS_MS[0],
    });
    expect(others).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'swiss_runner_offline', stage: 'submit', attempts: 1 }]);
    const notice = describeTakeover({ reason: 'swiss_runner_offline', stage: 'submit', portalAutoRetryAt: now + 1 });
    expect(notice.reason).toContain('nessun runner svizzero attivo');
    expect(notice.hint).toContain('senza passare da GitHub');

    // Its retry queues the run for the Swiss runner again.
    const retry: any = await applyAutomationEvent({ db: store.db, orderId, event: { type: 'portal_auto_retry' }, runEffect: effectRunner(github), nowMs: now + TRANSPORT_AUTO_RETRY_DELAYS_MS[0] });
    expect(retry.effectResults).toEqual([expect.objectContaining({ channel: 'swiss_local', queued: true })]);
    expect(github).not.toHaveBeenCalled();
  });

  it('no heartbeat at all, or one from a non-Swiss exit, holds as well', async () => {
    for (const [runner, reason] of [[null, 'heartbeat_missing'], [{ at: now - 1000, eligible: false, egressCountry: 'IT' }, 'egress_not_swiss']] as const) {
      const store = storeWith(submitting, { [queuePath]: pending, ...(runner ? { [`${LOCAL_RUNNERS_COLLECTION}/swiss-a`]: runner } : {}) });
      await runAutomationSweep({ db: store.db, runEffect: effectRunner(vi.fn()), nowMs: now } as any);
      expect(store.read(flowPath)).toMatchObject({ heldBy: ['portal:swiss_runner_offline'], swissRunnerOffline: { reason } });
    }
  });

  it('a live Swiss runner that is busy is waited for, and a request younger than the pickup time is left alone', async () => {
    const live = storeWith(submitting, {
      [queuePath]: pending,
      [`${LOCAL_RUNNERS_COLLECTION}/swiss-a`]: { at: now - 30_000, eligible: true, egressCountry: 'CH' },
    });
    await runAutomationSweep({ db: live.db, runEffect: effectRunner(vi.fn()), nowMs: now } as any);
    expect(live.read(flowPath)?.state).toBe('submitting');
    expect(live.read(queuePath)?.status).toBe('pending');

    const young = storeWith(submitting, { [queuePath]: { ...pending, queuedAt: now - 60_000 } });
    await runAutomationSweep({ db: young.db, runEffect: effectRunner(vi.fn()), nowMs: now } as any);
    expect(young.read(flowPath)?.state).toBe('submitting');
  });

  it('reads availability from the heartbeats', () => {
    expect(swissRunnerAvailability([], now)).toMatchObject({ online: false, reason: 'heartbeat_missing' });
    expect(swissRunnerAvailability([{ at: now - SWISS_RUNNER_HEARTBEAT_STALE_MS - 1, eligible: true, egressCountry: 'CH' }], now)).toMatchObject({ reason: 'heartbeat_stale' });
    expect(swissRunnerAvailability([{ at: now, eligible: false, egressCountry: 'DE' }], now)).toMatchObject({ reason: 'egress_not_swiss' });
    expect(swissRunnerAvailability([{ at: now, eligible: true, egressCountry: 'CH' }], now)).toMatchObject({ online: true });
  });
});

describe('local runner', () => {
  const submitting = { state: 'submitting', round: 1, egress: mark, dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt: now } };

  it('a non-Swiss exit takes no work and says why in its heartbeat', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    const runAgent = vi.fn();
    const result = await runCycle({ db: store.db, runnerId: 'swiss-a', now: () => now, fetchImpl: okText('IT\n') as any, runAgent, log: () => {} });

    expect(result).toMatchObject({ eligible: false, reason: 'egress_not_swiss', leased: null });
    expect(runAgent).not.toHaveBeenCalled();
    expect(store.read(queuePath)?.status).toBe('pending');
    expect(store.read(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`)).toMatchObject({ eligible: false, egressCountry: 'IT', reason: 'egress_not_swiss', at: now });
  });

  it('an unknown exit takes no work either', async () => {
    const failing = async () => { throw new Error('offline'); };
    expect(await readEgressCountry({ fetchImpl: failing as any })).toEqual({ country: null, source: null });
    expect(egressVerdict({ country: null })).toEqual({ eligible: false, reason: 'egress_unknown' });
  });

  it('a Swiss exit leases one request, runs it once and records the outcome', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    const runAgent = vi.fn(async (_args: any) => ({ status: 'done', exitCode: 0, code: null }));
    const result = await runCycle({ db: store.db, runnerId: 'swiss-a', now: () => now, fetchImpl: okText('CH') as any, runAgent, log: () => {} });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0]).toMatchObject({ leased: { orderId, mode: 'submit', round: 1 } });
    expect(result.release).toMatchObject({ released: true, status: 'done' });
    expect(store.read(queuePath)).toMatchObject({ status: 'done', lease: null });
    expect(store.read(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`)).toMatchObject({ eligible: true, egressCountry: 'CH', busy: null });
    // Nothing left to run.
    await runCycle({ db: store.db, runnerId: 'swiss-a', now: () => now + 1, fetchImpl: okText('CH') as any, runAgent, log: () => {} });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('strikes masked values and loaded secrets out of the log, and never prints the mask lines', () => {
    const out: string[] = [];
    const masker = createLogMasker((text: string) => out.push(text));
    masker.addSecret('rc-secret-value-123');
    masker.push('::add-mask::Synthetic Person\nstep for Synthetic Person with rc-secret-value-123');
    masker.push(' done\npartial');
    masker.flush();
    expect(out.join('')).toBe('step for *** with *** done\npartial\n');
  });

  it('builds the workflow environment: headless by default, the system Chrome only when Playwright has none', () => {
    const leased = { orderId, mode: 'submit', round: 2, key: 'k', requestedAt: now };
    const env = agentEnvironment({
      baseEnv: { PATH: '/bin', ASSISTED_APPLICATION_HEADED: '1', GITHUB_RUN_ID: '1' }, rcEnv: { ASSISTED_APPLICATION_RUN_KEY: 'x' },
      leased, brokerSocket: '/private/sock', runDir: '/private/run', chromePath: '/chrome', headed: false,
    });
    expect(env).toMatchObject({ ORDER_ID: orderId, MODE: 'submit', ROUND: '2', CODEX_AUTH_BROKER_SOCKET: '/private/sock', ASSISTED_APPLICATION_CHROME_PATH: '/chrome' });
    expect(env.ASSISTED_APPLICATION_HEADED).toBeUndefined();
    expect(env.GITHUB_RUN_ID).toBeUndefined();
    expect(env.NODE_OPTIONS).toMatch(/--trace-warnings -r .*local-runner-chrome-preload\.cjs$/);
    expect(agentEnvironment({ baseEnv: {}, rcEnv: {}, leased, brokerSocket: 's', runDir: '/r', chromePath: null, headed: true }))
      .toMatchObject({ ASSISTED_APPLICATION_HEADED: '1', NODE_OPTIONS: '--trace-warnings' });

    const exists = (file: string) => file === '/Applications/Chrome';
    expect(systemChromeFor({ playwrightExecutable: '/missing/chromium', exists, systemChrome: '/Applications/Chrome' })).toBe('/Applications/Chrome');
    expect(systemChromeFor({ playwrightExecutable: '/Applications/Chrome', exists, systemChrome: '/Applications/Chrome' })).toBeNull();
  });

  it('reads the Remote Config loader output without a shell', () => {
    expect(parseExportLines("export A='one'\nexport B='it'\\''s\nmulti'\nnoise\n")).toEqual({ A: 'one', B: "it's\nmulti" });
  });
});
