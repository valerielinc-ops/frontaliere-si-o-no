import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryFirestore } from './helpers/memoryFirestore';
// This suite exercises runner routing, not the separately tested PDF packet renderer.
vi.mock('../functions/src/assistedApplicationPostalPacket.js', () => ({ postalPacketReadiness: vi.fn(() => ({ ready: true })) }));
import { applyAutomationEvent, handleRunnerEvent, runAutomationSweep } from '../functions/src/assistedApplicationAutomation.js';
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
  holdUnservedLocalDispatches,
  leaseLocalDispatch,
  localDispatchKey,
  swissRunnerAvailability,
} from '../functions/src/assistedApplicationSwissRunner.js';
import {
  agentEnvironment,
  createLogMasker,
  egressVerdict,
  initializeSwissRunnerRuntime,
  parseExportLines,
  resolveSwissRunnerServiceAccountPath,
  readEgressCountry,
  runCycle,
  systemChromeFor,
  verifyAgentEntryPoint,
  writeSwissRunnerBootstrapHeartbeat,
} from '../scripts/assisted-application/local-runner.mjs';
import {
  ensureSwissRunnerDependencies,
  needsSwissRunnerDependencyInstall,
  probeSwissRunnerStorageUpload,
  resolveSwissRunnerCvCheckModulePath,
  resolveSwissRunnerStorageModules,
  SWISS_RUNNER_STORAGE_PROBE_EXHAUSTED_RETRY_DELAY_MS,
  SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS,
  SWISS_RUNNER_STORAGE_PROBE_RETRY_DELAYS_MS,
} from '../scripts/assisted-application/lib/swiss-runner-deps.mjs';

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

const dependencyTreesReady = async () => ({ rootHash: 'a'.repeat(64), functionsHash: 'b'.repeat(64), versionKey: `${'a'.repeat(64)}:${'b'.repeat(64)}` });
const entryPointReady = async () => ({ eligible: true, reason: null });
const storageReady = async () => ({ eligible: true, cached: true });
const safeRunnerPreflight = {
  ensureDependencies: dependencyTreesReady,
  checkEntryPoint: entryPointReady,
  checkStorageUpload: storageReady,
};

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

  it('routes the exhausted navigation retry locally after repeated verified network failures', async () => {
    const host = 'forms.example.test';
    const requestedAt = now - 1_000;
    const priorAt = now - 10_000;
    const flow = {
      state: 'submitting', round: 1, heldBy: [], portalAutoRetryCount: 0,
      transportAutoRetryCount: TRANSPORT_AUTO_RETRY_DELAYS_MS.length,
      dispatch: { mode: 'submit', round: 1, attempts: 3, requestedAt },
      swissEgressNetworkFailures: [{ host, round: 1, requestedAt: priorAt, kind: 'connection_failure', at: priorAt }],
    };
    const draftPath = `${orderPath}/ai_drafts/current`;
    const store = storeWith(flow, {
      [draftPath]: {
        status: 'ready', round: 1,
        portalContract: { postingMatch: 'match', currentUrl: { origin: `https://${host}`, path: '/apply/' } },
      },
    });
    const events = store.db.collection('assisted_applications').doc(orderId).collection('automation_events');
    const eventRef = await events.add({
      type: 'submit_handoff', round: 1, reason: 'navigation_unavailable',
      portalNetworkFailure: { host, kind: 'navigation_unavailable' },
    });
    const github = vi.fn(async () => ({ ok: true }));

    const failure = await handleRunnerEvent({
      db: store.db, orderId, eventRef, data: store.read(eventRef.path),
      runEffect: effectRunner(github), nowMs: now,
    });
    expect(failure).toMatchObject({ ok: true });
    expect(store.read(flowPath)).toMatchObject({
      state: 'owner_takeover', heldBy: ['portal:navigation_unavailable'],
      egress: { required: 'ch', reason: 'repeated_network_failure', source: 'repeated_network_failure' },
      portalAutoRetryCount: 0, portalAutoRetryAt: now,
    });
    expect(github).not.toHaveBeenCalled();

    const retry: any = await applyAutomationEvent({
      db: store.db, orderId, event: { type: 'portal_auto_retry' },
      runEffect: effectRunner(github), nowMs: now,
    });
    expect(retry.effectResults).toEqual([expect.objectContaining({ channel: 'swiss_local', queued: true })]);
    expect(github).not.toHaveBeenCalled();
    expect(store.read(queuePath)).toMatchObject({
      orderId, mode: 'submit', round: 1, requestedAt: now, status: 'pending', egress: 'ch',
    });
    expect(store.read(flowPath)).toMatchObject({
      state: 'submitting', transportAutoRetryCount: TRANSPORT_AUTO_RETRY_DELAYS_MS.length + 1,
      portalExhaustedRecoveryVersion: expect.any(String),
      egress: { required: 'ch', source: 'repeated_network_failure' },
    });
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
  const repeatedNetworkMark = {
    required: 'ch', reason: 'repeated_network_failure', round: 1,
    at: now - 60_000, source: 'repeated_network_failure',
  };
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

  it('keeps a newly marked repeated-network order on the explicit offline hold', async () => {
    const store = storeWith({ ...submitting, egress: repeatedNetworkMark }, {
      [queuePath]: pending,
      [`${LOCAL_RUNNERS_COLLECTION}/swiss-a`]: {
        runnerId: 'swiss-a', at: now - SWISS_RUNNER_HEARTBEAT_STALE_MS - 1,
        eligible: true, egressCountry: 'CH',
      },
    });
    const github = vi.fn(async () => ({ ok: true }));

    await runAutomationSweep({ db: store.db, runEffect: effectRunner(github), nowMs: now } as any);

    expect(github).not.toHaveBeenCalled();
    expect(store.read(flowPath)).toMatchObject({
      state: 'owner_takeover', heldBy: ['portal:swiss_runner_offline'],
      egress: repeatedNetworkMark,
    });
  });

  it('no heartbeat, a non-Swiss exit, or an unavailable Swiss preflight holds the request with its reason', async () => {
    for (const [runner, reason] of [
      [null, 'heartbeat_missing'],
      [{ at: now - 1000, eligible: false, egressCountry: 'IT' }, 'egress_not_swiss'],
      [{ at: now - 1000, eligible: false, egressCountry: 'CH', reason: 'entry_point_unavailable:pdf-lib' }, 'entry_point_unavailable'],
      [{ at: now - 1000, eligible: false, egressCountry: 'CH', reason: 'deps_install_failed:root' }, 'deps_install_failed'],
      [{ at: now - 1000, eligible: false, egressCountry: 'CH', reason: 'storage_upload_unavailable' }, 'storage_upload_unavailable'],
    ] as const) {
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
    expect(swissRunnerAvailability([{ at: now, eligible: false, egressCountry: 'CH', reason: 'entry_point_unavailable:pdf-lib' }], now))
      .toMatchObject({ online: false, reason: 'entry_point_unavailable' });
    expect(swissRunnerAvailability([{ at: now, eligible: false, egressCountry: 'CH', reason: 'deps_install_failed:functions' }], now))
      .toMatchObject({ online: false, reason: 'deps_install_failed' });
    expect(swissRunnerAvailability([{ at: now, eligible: false, egressCountry: 'CH', reason: 'storage_upload_unavailable' }], now))
      .toMatchObject({ online: false, reason: 'storage_upload_unavailable' });
    expect(swissRunnerAvailability([{ at: now, eligible: true, egressCountry: 'CH' }], now)).toMatchObject({ online: true });
  });
});

describe('local runner', () => {
  const submitting = { state: 'submitting', round: 1, egress: mark, dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt: now } };

  it('activates private dependencies before loading Firestore Admin', async () => {
    const order: string[] = [];
    const db = { fixture: true };
    const env: Record<string, string> = { SWISS_RUNNER_SA: '/fixture/swiss-service-account.json' };
    const result = await initializeSwissRunnerRuntime({
      repoRoot: '/fixture/site',
      env,
      runnerId: 'fixture-runner',
      getEgressCountry: async () => {
        order.push('egress');
        return 'CH';
      },
      writeBootstrapHeartbeat: async ({ reason, egressCountry }: any) => {
        order.push(`heartbeat:${reason}:${egressCountry}`);
        return true;
      },
      prepareDependencies: async ({ repoRoot, onInstalling }: any) => {
        order.push(`dependencies:${repoRoot}`);
        await onInstalling();
        return { versionKey: 'fixture-locks' };
      },
      loadDatabase: async () => {
        order.push(`firestore:${env.GOOGLE_APPLICATION_CREDENTIALS}`);
        return db;
      },
    });

    expect(order).toEqual([
      'dependencies:/fixture/site', 'egress', 'heartbeat:deps_installing:CH',
      'firestore:/fixture/swiss-service-account.json',
    ]);
    expect(result).toEqual({ db, dependencies: { versionKey: 'fixture-locks' } });
  });

  it('resolves the Swiss runner service account override before the generic ADC path', () => {
    expect(resolveSwissRunnerServiceAccountPath({ SWISS_RUNNER_SA: '/fixture/swiss.json' }))
      .toBe('/fixture/swiss.json');
    expect(resolveSwissRunnerServiceAccountPath({ GOOGLE_APPLICATION_CREDENTIALS: '/fixture/google.json' }))
      .toBe('/fixture/google.json');
    expect(resolveSwissRunnerServiceAccountPath({}, '/fixture/home'))
      .toBe('/fixture/home/.config/frontaliere/sa-frontaliere-ticino.json');
  });

  it('refreshes the ineligible bootstrap heartbeat until dependency installation finishes', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => true);
    let finishInstallation!: () => void;
    let startedInstallation!: () => void;
    const started = new Promise<void>((resolve) => { startedInstallation = resolve; });
    const initialize = initializeSwissRunnerRuntime({
      runnerId: 'fixture-runner', heartbeatIntervalMs: 5_000,
      getEgressCountry: async () => 'CH',
      writeBootstrapHeartbeat: heartbeat,
      prepareDependencies: async ({ onInstalling }: any) => {
        await onInstalling();
        startedInstallation();
        await new Promise<void>((resolve) => { finishInstallation = resolve; });
        return { versionKey: 'fixture-locks' };
      },
      loadDatabase: async () => ({ fixture: true }),
    });

    try {
      await started;
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ eligible: false, reason: 'deps_installing' }));
      finishInstallation();
      await initialize;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

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
    const result = await runCycle({ ...safeRunnerPreflight, db: store.db, runnerId: 'swiss-a', now: () => now, fetchImpl: okText('CH') as any, runAgent, log: () => {} });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0]).toMatchObject({ leased: { orderId, mode: 'submit', round: 1 } });
    expect(result.release).toMatchObject({ released: true, status: 'done' });
    expect(store.read(queuePath)).toMatchObject({ status: 'done', lease: null });
    expect(store.read(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`)).toMatchObject({ eligible: true, egressCountry: 'CH', busy: null });
    // Nothing left to run.
    await runCycle({ ...safeRunnerPreflight, db: store.db, runnerId: 'swiss-a', now: () => now + 1, fetchImpl: okText('CH') as any, runAgent, log: () => {} });
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

  it('keeps queued work pending when dependency installation fails', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    const runAgent = vi.fn();
    const checkEntryPoint = vi.fn(entryPointReady);
    const checkStorageUpload = vi.fn(storageReady);
    const ensureDependencies = vi.fn(async ({ onInstalling }: any) => {
      await onInstalling();
      throw Object.assign(new Error('synthetic install error'), { code: 'deps_install_failed:root' });
    });

    const result = await runCycle({
      db: store.db, runnerId: 'swiss-a', now: () => now, fetchImpl: okText('CH') as any,
      runAgent, ensureDependencies, checkEntryPoint, checkStorageUpload, log: () => {},
    });

    expect(result).toMatchObject({ eligible: false, reason: 'deps_install_failed:root', leased: null });
    expect(ensureDependencies).toHaveBeenCalledTimes(1);
    expect(checkEntryPoint).not.toHaveBeenCalled();
    expect(checkStorageUpload).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(store.read(queuePath)).toMatchObject({ status: 'pending' });
    expect(store.read(queuePath)).not.toHaveProperty('lease');
    expect(store.read(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`)).toMatchObject({
      eligible: false, egressCountry: 'CH', reason: 'deps_install_failed:root', busy: null,
    });
  });

  it('keeps queued work pending when the agent entry point cannot import', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    const runAgent = vi.fn();
    const checkEntryPoint = vi.fn(async () => ({ eligible: false, reason: 'entry_point_unavailable:pdf-lib' }));
    const checkStorageUpload = vi.fn(storageReady);
    const logs: string[] = [];

    const result = await runCycle({
      ...safeRunnerPreflight,
      db: store.db, runnerId: 'swiss-a', now: () => now, fetchImpl: okText('CH') as any,
      runAgent, checkEntryPoint, checkStorageUpload, version: 'entry-point-preflight-fixture', log: line => logs.push(line),
    });

    expect(checkEntryPoint).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ eligible: false, reason: 'entry_point_unavailable:pdf-lib', leased: null });
    expect(checkStorageUpload).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(store.read(queuePath)).toMatchObject({ status: 'pending' });
    expect(store.read(queuePath)).not.toHaveProperty('lease');
    expect(store.read(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`)).toMatchObject({
      eligible: false, egressCountry: 'CH', reason: 'entry_point_unavailable:pdf-lib', busy: null,
    });
    expect(logs).toEqual(['swiss-runner entry point unavailable version=entry-point-preflight-fixture reason=entry_point_unavailable:pdf-lib']);
  });

  it('keeps queued work pending when the Storage upload probe fails', async () => {
    const store = storeWith(submitting);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: submitting, mode: 'submit', nowMs: now });
    const runAgent = vi.fn();
    const checkStorageUpload = vi.fn(async ({ onProbing }: any) => {
      await onProbing();
      return { eligible: false, reason: 'storage_upload_unavailable' };
    });

    const result = await runCycle({
      ...safeRunnerPreflight,
      db: store.db, runnerId: 'swiss-a', now: () => now, fetchImpl: okText('CH') as any,
      runAgent, checkStorageUpload, version: 'swiss-runner/3@fixture-commit', log: () => {},
    });

    expect(result).toMatchObject({ eligible: false, reason: 'storage_upload_unavailable', leased: null });
    expect(checkStorageUpload).toHaveBeenCalledTimes(1);
    expect(checkStorageUpload).toHaveBeenCalledWith(expect.objectContaining({
      runnerVersion: 'swiss-runner/3@fixture-commit', log: expect.any(Function),
    }));
    expect(runAgent).not.toHaveBeenCalled();
    expect(store.read(queuePath)).toMatchObject({ status: 'pending' });
    expect(store.read(queuePath)).not.toHaveProperty('lease');
    expect(store.read(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`)).toMatchObject({
      eligible: false, egressCountry: 'CH', reason: 'storage_upload_unavailable', busy: null,
    });
  });

  it('checks the workflow entry point without exposing its local path', () => {
    const spawnSyncImpl = vi.fn(() => ({
      error: null, status: 1, stdout: '',
      stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pdf-lib' imported from /private/checkout/scripts/assisted-application/lib/docx-inplace.mjs",
    }));

    const result = verifyAgentEntryPoint({ repoRoot: '/private/checkout', spawnSyncImpl: spawnSyncImpl as any });

    expect(result).toEqual({ eligible: false, reason: 'entry_point_unavailable:pdf-lib' });
    expect(result.reason).not.toContain('/private/checkout');
    expect(spawnSyncImpl).toHaveBeenCalledWith(process.execPath,
      ['--input-type=module', '-e', expect.stringContaining("import('./scripts/assisted-application/agent.mjs')")],
      expect.objectContaining({ cwd: '/private/checkout', timeout: 15_000 }));
  });
});

// Review PRR_kwDORN5k2M8AAAABXRWXRQ (PR #18109): the three acceptance cases.
describe('review: crashed leases, a failing offline transition, an exit lost mid-run', () => {
  const requestedAt = now - 150 * 60 * 1000 + 5 * 60 * 1000;
  const submitting = { state: 'submitting', round: 1, egress: mark, dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt } };
  const key = localDispatchKey({ mode: 'submit', round: 1, requestedAt });
  const crashed = {
    orderId, key, mode: 'submit', round: 1, requestedAt, queuedAt: requestedAt, status: 'leased', egress: 'ch',
    lease: { runnerId: 'swiss-crashed', key, at: requestedAt, until: now - 1 },
  };

  it('a lease that ended unreleased is taken again by the next lease', async () => {
    const store = storeWith(submitting, { [queuePath]: crashed });
    const { leased } = await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-b', nowMs: now });
    expect(leased).toMatchObject({ orderId, key, lease: { runnerId: 'swiss-b' } });
    expect(store.read(queuePath)).toMatchObject({
      status: 'leased', leaseExpiries: 1, lastRun: { runnerId: 'swiss-crashed', status: 'lease_expired' },
    });
  });

  it('with no runner, the next sweep holds the order of a lease that ended unreleased', async () => {
    const store = storeWith(submitting, { [queuePath]: crashed });
    const summary = await runAutomationSweep({ db: store.db, runEffect: effectRunner(vi.fn()), nowMs: now } as any);
    expect(summary).toMatchObject({ swissLeasesRequeued: 1, swissRunnerHolds: 1 });
    expect(store.read(queuePath)).toMatchObject({ status: 'expired', lease: null, result: { reason: 'heartbeat_missing' } });
    expect(store.read(flowPath)).toMatchObject({ state: 'owner_takeover', heldBy: ['portal:swiss_runner_offline'] });
  });

  it('an offline transition that fails once is applied by the next sweep', async () => {
    const store = storeWith(submitting, {
      [queuePath]: { ...crashed, status: 'pending', lease: null, queuedAt: now - SWISS_RUNNER_PICKUP_MS - 1 },
    });
    const runEffect = effectRunner(vi.fn());
    let calls = 0;
    const flaky = async (args: any) => {
      calls += 1;
      if (calls === 1) throw new Error('DEADLINE_EXCEEDED');
      return applyAutomationEvent(args);
    };
    const first = await holdUnservedLocalDispatches({ db: store.db, nowMs: now, runEffect, applyEvent: flaky });
    expect(first).toMatchObject({ failed: 1, held: 0 });
    expect(store.read(queuePath)?.status).toBe('expiring');
    expect(store.read(flowPath)?.state).toBe('submitting');
    // A runner never leases a request being expired.
    expect((await leaseLocalDispatch({ db: store.db, runnerId: 'swiss-b', nowMs: now + 1 })).leased).toBeNull();

    const second = await holdUnservedLocalDispatches({ db: store.db, nowMs: now + 60_000, runEffect, applyEvent: flaky });
    expect(second).toMatchObject({ failed: 0, held: 1 });
    expect(store.read(queuePath)).toMatchObject({ status: 'expired', result: { code: 'swiss_runner_offline' } });
    expect(store.read(flowPath)).toMatchObject({
      state: 'owner_takeover', heldBy: ['portal:swiss_runner_offline'], swissRunnerOffline: { reason: 'heartbeat_missing' },
    });
  });

  it('a request still expiring goes back to the runner when it is online again', async () => {
    const store = storeWith(submitting, {
      [queuePath]: { ...crashed, status: 'expiring', lease: null },
      [`${LOCAL_RUNNERS_COLLECTION}/swiss-a`]: { at: now - 1000, eligible: true, egressCountry: 'CH' },
    });
    await holdUnservedLocalDispatches({ db: store.db, nowMs: now, runEffect: effectRunner(vi.fn()), applyEvent: applyAutomationEvent as any });
    expect(store.read(queuePath)?.status).toBe('pending');
    expect(store.read(flowPath)?.state).toBe('submitting');
  });

  function countries(...answers: Array<string | null>) {
    let index = 0;
    return (async () => {
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer === null) throw new Error('offline');
      return { ok: true, text: async () => answer };
    }) as any;
  }

  function agentUntilStopped(fallbackMs: number) {
    return vi.fn(({ signal }: any) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'done', exitCode: 0, code: null }), fallbackMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve({ status: 'failed', exitCode: null, code: String(signal.reason) }); });
    }));
  }

  it('an exit that turns non-Swiss during the run stops the agent, marks the heartbeat and releases the lease', async () => {
    const fresh = { ...submitting, dispatch: { ...submitting.dispatch, requestedAt: now } };
    const store = storeWith(fresh);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: fresh, mode: 'submit', nowMs: now });
    const runAgent = agentUntilStopped(5000);
    const started = Date.now();
    const result = await runCycle({
      ...safeRunnerPreflight,
      db: store.db, runnerId: 'swiss-a', now: () => now, fetchImpl: countries('CH', 'US'), runAgent, log: () => {}, checkEveryMs: 20,
    });

    expect(Date.now() - started).toBeLessThan(4000);
    expect(result).toMatchObject({ eligible: false, reason: 'egress_not_swiss', outcome: { status: 'failed', code: 'egress_lost' }, release: { released: true, status: 'failed' } });
    expect(store.read(queuePath)).toMatchObject({ status: 'failed', lease: null, lastRun: { code: 'egress_lost' } });
    expect(store.read(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`)).toMatchObject({ eligible: false, egressCountry: 'US', reason: 'egress_not_swiss', busy: null });
  });

  it('an exit probe that merely fails does not stop the run', async () => {
    const fresh = { ...submitting, dispatch: { ...submitting.dispatch, requestedAt: now } };
    const store = storeWith(fresh);
    await enqueueLocalDispatch({ db: store.db, orderId, flow: fresh, mode: 'submit', nowMs: now });
    const result = await runCycle({
      ...safeRunnerPreflight,
      db: store.db, runnerId: 'swiss-a', now: () => now, fetchImpl: countries('CH', null), runAgent: agentUntilStopped(150), log: () => {}, checkEveryMs: 20,
    });
    expect(result).toMatchObject({ eligible: true, outcome: { status: 'done' }, release: { status: 'done' } });
    expect(store.read(`${LOCAL_RUNNERS_COLLECTION}/swiss-a`)).toMatchObject({ eligible: true, egressCountry: 'CH' });
  });
});

describe('Swiss runner private dependency trees', () => {
  it.each([
    ['same lock and installed tree', 'lock-a', 'lock-a', true, false],
    ['different lock hash', 'lock-b', 'lock-a', true, true],
    ['missing installed tree', 'lock-a', 'lock-a', false, true],
  ])('decides whether to reinstall for %s', (_name, expectedHash, installedHash, treeExists, expected) => {
    expect(needsSwissRunnerDependencyInstall({ expectedHash, installedHash, treeExists })).toBe(expected);
  });

  it('leaves both live links unchanged when either new tree fails to install', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-deps-test-'));
    const repoRoot = path.join(tempRoot, 'site');
    const stateRoot = path.join(tempRoot, 'runner-state');
    const functionsRoot = path.join(repoRoot, 'functions');
    fs.mkdirSync(functionsRoot, { recursive: true });
    const writeSource = (dir: string, name: string) => {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true }));
      fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name, lockfileVersion: 3, packages: {} }));
    };
    writeSource(repoRoot, 'fixture-root');
    writeSource(functionsRoot, 'fixture-functions');

    const rootPrevious = path.join(stateRoot, 'root-deps', 'deps-previous');
    const functionsPrevious = path.join(stateRoot, 'functions-deps', 'deps-previous');
    for (const [previous, name] of [[rootPrevious, 'previous-root'], [functionsPrevious, 'previous-functions']]) {
      fs.mkdirSync(path.join(previous, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name, private: true }));
      fs.writeFileSync(path.join(previous, 'package-lock.json'), JSON.stringify({ name, lockfileVersion: 3, packages: {} }));
    }
    fs.symlinkSync(path.join(rootPrevious, 'node_modules'), path.join(repoRoot, 'node_modules'), 'dir');
    fs.symlinkSync(path.join(functionsPrevious, 'node_modules'), path.join(functionsRoot, 'node_modules'), 'dir');
    const rootLinkBefore = fs.readlinkSync(path.join(repoRoot, 'node_modules'));
    const functionsLinkBefore = fs.readlinkSync(path.join(functionsRoot, 'node_modules'));

    const executeNpmCi = vi.fn(async ({ cwd, args }: any) => {
      expect(args).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
      if (cwd.includes(`${path.sep}root-deps${path.sep}`)) {
        const modules = path.join(cwd, 'node_modules');
        for (const name of ['@google-cloud/storage', '@pdf-lib/fontkit', 'firebase-admin', 'pdf-lib', 'playwright']) {
          fs.mkdirSync(path.join(modules, ...name.split('/')), { recursive: true });
        }
        return { code: 0 };
      }
      return { code: 1 };
    });

    try {
      await expect(ensureSwissRunnerDependencies({
        repoRoot, env: { SWISS_RUNNER_DEPS_DIR: stateRoot }, executeNpmCi,
      })).rejects.toMatchObject({ code: 'deps_install_failed:functions' });

      expect(executeNpmCi).toHaveBeenCalledTimes(2);
      expect(fs.readlinkSync(path.join(repoRoot, 'node_modules'))).toBe(rootLinkBefore);
      expect(fs.readlinkSync(path.join(functionsRoot, 'node_modules'))).toBe(functionsLinkBefore);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('recognizes the existing private root tree and links functions to its verified node_modules directory', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-deps-legacy-test-'));
    const repoRoot = path.join(tempRoot, 'site');
    const stateRoot = path.join(tempRoot, 'runner-state');
    const functionsRoot = path.join(repoRoot, 'functions');
    const rootDeps = path.join(stateRoot, 'root-deps');
    fs.mkdirSync(functionsRoot, { recursive: true });
    const writeSource = (dir: string, name: string) => {
      const manifest = JSON.stringify({ name, private: true });
      const lock = JSON.stringify({ name, lockfileVersion: 3, packages: {} });
      fs.writeFileSync(path.join(dir, 'package.json'), manifest);
      fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
      return { manifest, lock };
    };
    const rootSource = writeSource(repoRoot, 'fixture-root');
    writeSource(functionsRoot, 'fixture-functions');
    fs.mkdirSync(path.join(rootDeps, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(rootDeps, 'package.json'), rootSource.manifest);
    fs.writeFileSync(path.join(rootDeps, 'package-lock.json'), rootSource.lock);
    for (const name of ['@google-cloud/storage', '@pdf-lib/fontkit', 'firebase-admin', 'pdf-lib', 'playwright']) {
      fs.mkdirSync(path.join(rootDeps, 'node_modules', ...name.split('/')), { recursive: true });
    }
    fs.symlinkSync(path.join(rootDeps, 'node_modules'), path.join(repoRoot, 'node_modules'), 'dir');

    const executeNpmCi = vi.fn(async ({ cwd }: any) => {
      const modules = path.join(cwd, 'node_modules');
      for (const name of ['@google-cloud/storage', '@pdf-lib/fontkit', 'firebase-admin', 'firebase-functions', 'pdf-lib']) {
        fs.mkdirSync(path.join(modules, ...name.split('/')), { recursive: true });
      }
      return { code: 0 };
    });
    try {
      const result = await ensureSwissRunnerDependencies({
        repoRoot, env: { SWISS_RUNNER_DEPS_DIR: stateRoot }, executeNpmCi,
      });

      expect(executeNpmCi).toHaveBeenCalledTimes(1);
      expect(executeNpmCi.mock.calls[0][0].cwd).toContain(`${path.sep}functions-deps${path.sep}.install-`);
      expect(result.rootModules).toBe(path.join(rootDeps, 'node_modules'));
      expect(fs.readlinkSync(path.join(repoRoot, 'node_modules'))).toBe(path.join(rootDeps, 'node_modules'));
      expect(fs.readlinkSync(path.join(functionsRoot, 'node_modules'))).toBe(result.functionsModules);
      expect(path.basename(path.dirname(result.functionsModules))).toBe(`deps-${result.functionsHash}`);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('imports the canonical CV bucket module and probes Storage without a bucket factory', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-storage-module-test-'));
    const file = { save: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const bucket = { file: vi.fn(() => file) };
    const getStorage = vi.fn(() => ({ bucket: vi.fn(() => bucket) }));
    const resolveStorageModules = () => resolveSwissRunnerStorageModules({
      importModule: async (specifier: string) => {
        if (specifier === 'firebase-admin/app') {
          return { getApps: () => [{}], initializeApp: vi.fn(), applicationDefault: vi.fn() };
        }
        if (specifier === 'firebase-admin/storage') return { getStorage };
        return import(specifier);
      },
    });
    try {
      const cvCheckPath = resolveSwissRunnerCvCheckModulePath();
      expect(fs.existsSync(cvCheckPath)).toBe(true);
      expect(path.relative(process.cwd(), cvCheckPath)).toBe(path.join('functions', 'src', 'assistedApplicationCvCheck.js'));

      const modules = await resolveStorageModules();
      expect(modules.cvCheck.ASSISTED_APPLICATION_STORAGE_BUCKET).toBeTruthy();
      const result = await probeSwissRunnerStorageUpload({
        versionKey: 'fixture-root-lock:fixture-functions-lock',
        runnerVersion: 'swiss-runner/3@fixture-commit',
        stateRoot,
        resolveStorageModules,
        randomBytesImpl: () => Buffer.from('fixture!'),
        uuidImpl: () => 'fixture-probe-id',
      });

      expect(result).toEqual({ eligible: true, cached: false });
      expect(getStorage).toHaveBeenCalledTimes(1);
      expect(getStorage.mock.results[0].value.bucket).toHaveBeenCalledWith(modules.cvCheck.ASSISTED_APPLICATION_STORAGE_BUCKET);
      expect(file.save).toHaveBeenCalledTimes(1);
      expect(file.delete).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('uses the tree hash to cache a successful Storage probe and removes the diagnostic object', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-storage-test-'));
    const file = { save: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const bucketFactory = vi.fn(async () => ({ file: vi.fn((name: string) => {
      expect(name).toMatch(/^diagnostics\/swiss-runner-[a-f0-9-]+\.bin$/);
      return file;
    }) }));
    try {
      const first = await probeSwissRunnerStorageUpload({
        versionKey: 'root-lock:functions-lock', stateRoot, bucketFactory,
        randomBytesImpl: () => Buffer.from('fixture!'), uuidImpl: () => 'abc12345-def6',
      });
      const second = await probeSwissRunnerStorageUpload({ versionKey: 'root-lock:functions-lock', stateRoot, bucketFactory });

      expect(first).toMatchObject({ eligible: true, cached: false });
      expect(second).toMatchObject({ eligible: true, cached: true });
      expect(bucketFactory).toHaveBeenCalledTimes(1);
      expect(file.save).toHaveBeenCalledTimes(1);
      expect(file.delete).toHaveBeenCalledTimes(1);
      expect(file.save.mock.calls[0][0]).toEqual(Buffer.from('fixture!'));
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('returns ineligible when a diagnostic upload fails and attempts cleanup', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-storage-failure-test-'));
    const file = { save: vi.fn(async () => { throw new Error('synthetic upload failure'); }), delete: vi.fn(async () => {}) };
    try {
      const result = await probeSwissRunnerStorageUpload({
        versionKey: 'fixture-locks', stateRoot,
        bucketFactory: async () => ({ file: () => file }),
        randomBytesImpl: () => Buffer.from('fixture!'), uuidImpl: () => 'abc12345-def6',
      });

      expect(result).toEqual({ eligible: false, reason: 'storage_upload_unavailable' });
      expect(file.save).toHaveBeenCalledTimes(1);
      expect(file.delete).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('stores only a safe error code and logs the storage failure once per runner version', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-storage-error-test-'));
    const logs: string[] = [];
    const bucketFactory = vi.fn(async () => {
      throw Object.assign(new Error('synthetic failure /private/fake/path'), { code: 'ERR_MODULE_NOT_FOUND' });
    });
    let currentTime = now;
    const probe = () => probeSwissRunnerStorageUpload({
      versionKey: 'fixture-locks', runnerVersion: 'swiss-runner/3@error-fixture', stateRoot, bucketFactory,
      now: () => currentTime, log: line => logs.push(line),
    });
    try {
      await probe();
      const retryPath = path.join(stateRoot, 'storage-probes', fs.readdirSync(path.join(stateRoot, 'storage-probes'))
        .find(name => name.endsWith('.retry.json'))!);
      expect(JSON.parse(fs.readFileSync(retryPath, 'utf8'))).toMatchObject({ errorCode: 'ERR_MODULE_NOT_FOUND', attempts: 1 });
      expect(fs.readFileSync(retryPath, 'utf8')).not.toContain('/private/fake/path');
      expect(logs).toEqual(['swiss-runner storage probe failed version=swiss-runner/3@error-fixture error=ERR_MODULE_NOT_FOUND']);

      currentTime += SWISS_RUNNER_STORAGE_PROBE_RETRY_DELAYS_MS[0];
      await probe();
      expect(logs).toHaveLength(1);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('starts a fresh bounded retry sequence when the runner checkout version changes', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-storage-version-test-'));
    const file = { save: vi.fn(async () => { throw new Error('synthetic upload failure'); }), delete: vi.fn(async () => {}) };
    const bucketFactory = vi.fn(async () => ({ file: () => file }));
    let currentTime = now;
    const probe = (runnerVersion: string) => probeSwissRunnerStorageUpload({
      versionKey: 'fixture-locks', runnerVersion, stateRoot, bucketFactory,
      now: () => currentTime,
    });
    try {
      await probe('swiss-runner/3@checkout-one');
      currentTime += SWISS_RUNNER_STORAGE_PROBE_RETRY_DELAYS_MS[0];
      await probe('swiss-runner/3@checkout-one');
      currentTime += SWISS_RUNNER_STORAGE_PROBE_RETRY_DELAYS_MS[1];
      await probe('swiss-runner/3@checkout-one');
      expect(bucketFactory).toHaveBeenCalledTimes(SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS);

      await probe('swiss-runner/3@checkout-two');
      expect(bucketFactory).toHaveBeenCalledTimes(SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS + 1);
      expect(fs.readdirSync(path.join(stateRoot, 'storage-probes')).filter(name => name.endsWith('.retry.json'))).toHaveLength(2);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('backs off after three Storage probe failures and retries after a long cooldown', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-storage-retry-test-'));
    const file = { save: vi.fn(async () => { throw new Error('synthetic upload failure'); }), delete: vi.fn(async () => {}) };
    const bucketFactory = vi.fn(async () => ({ file: () => file }));
    let currentTime = now;
    const probe = () => probeSwissRunnerStorageUpload({
      versionKey: 'fixture-locks', runnerVersion: 'swiss-runner/3@retry-fixture', stateRoot, bucketFactory,
      randomBytesImpl: () => Buffer.from('fixture!'), uuidImpl: () => 'abc12345-def6',
      now: () => currentTime,
    });
    try {
      expect(await probe()).toMatchObject({ eligible: false, reason: 'storage_upload_unavailable' });
      currentTime += 59_999;
      expect(await probe()).toMatchObject({ eligible: false, reason: 'storage_upload_unavailable' });
      expect(bucketFactory).toHaveBeenCalledTimes(1);

      currentTime += 1;
      await probe();
      expect(bucketFactory).toHaveBeenCalledTimes(2);
      currentTime += 5 * 60_000;
      await probe();
      expect(bucketFactory).toHaveBeenCalledTimes(SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS);

      currentTime += SWISS_RUNNER_STORAGE_PROBE_EXHAUSTED_RETRY_DELAY_MS - 1;
      expect(await probe()).toMatchObject({ eligible: false, reason: 'storage_upload_unavailable' });
      expect(bucketFactory).toHaveBeenCalledTimes(SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS);

      currentTime += 1;
      await probe();
      expect(bucketFactory).toHaveBeenCalledTimes(SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS + 1);

      currentTime += SWISS_RUNNER_STORAGE_PROBE_RETRY_DELAYS_MS[0] - 1;
      expect(await probe()).toMatchObject({ eligible: false, reason: 'storage_upload_unavailable' });
      expect(bucketFactory).toHaveBeenCalledTimes(SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS + 1);
      currentTime += 1;
      await probe();
      expect(bucketFactory).toHaveBeenCalledTimes(SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS + 2);
      expect(file.save).toHaveBeenCalledTimes(SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS + 2);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe('Swiss runner bootstrap heartbeat', () => {
  it('writes an ineligible heartbeat through Firestore REST without importing checkout packages', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyText = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const requests: Array<{ url: string; init: any }> = [];
    const fetchImpl = vi.fn(async (input: any, init: any) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return { ok: true, json: async () => ({ access_token: 'fixture-access-token' }) };
      return { ok: true };
    });

    const result = await writeSwissRunnerBootstrapHeartbeat({
      runnerId: 'fixture-runner', nowMs: now, egressCountry: 'CH', reason: 'deps_installing',
      version: 'swiss-runner/fixture', env: { SWISS_RUNNER_SA: '/fixture/service-account.json' },
      readFileImpl: () => JSON.stringify({
        client_email: 'fixture-service-account@example.invalid',
        private_key: keyText,
        project_id: 'fixture-project',
      }),
      fetchImpl: fetchImpl as any,
    });

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const patch = requests[1];
    const body = JSON.parse(patch.init.body);
    expect(new URL(patch.url).pathname).toBe('/v1/projects/fixture-project/databases/(default)/documents/assisted_application_local_runners/fixture-runner');
    expect(patch.init.method).toBe('PATCH');
    expect(patch.init.headers.authorization).toBe('Bearer fixture-access-token');
    expect(body.fields).toMatchObject({
      runnerId: { stringValue: 'fixture-runner' },
      at: { integerValue: String(now) },
      egressCountry: { stringValue: 'CH' },
      eligible: { booleanValue: false },
      reason: { stringValue: 'deps_installing' },
    });
    expect(new URL(patch.url).searchParams.getAll('updateMask.fieldPaths'))
      .toEqual(['runnerId', 'at', 'egressCountry', 'eligible', 'reason', 'busy', 'version']);
  });
});
