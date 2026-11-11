/**
 * Swiss egress for the assisted-application runner.
 *
 * Some portals refuse the application from GitHub's network: Yellowshark
 * (order 1EpmkrDu, 2026-11-11) answers `application_region_unsupported` to the
 * runner's IP, while the same posting serves its form to a Swiss connection.
 * Owner decision 2026-11-11 («lancialo da questo mac che è in svizzera»): such
 * an order runs from a local runner with a verified Swiss exit
 * (scripts/assisted-application/local-runner.mjs), never again from Actions.
 *
 *   - The flow carries the mark (`flow.egress`, with its proof): set by the
 *     state machine when the portal stops on the regional notice, or when a
 *     flow already held for it moves on (assistedApplicationFlow.js).
 *   - A marked order's dispatch is a request in LOCAL_DISPATCH_COLLECTION,
 *     one document per order (its id), keyed by mode, round and the moment the
 *     flow asked for the run; the same key twice is the same request.
 *   - The local runner leases a request in a transaction, writes its heartbeat
 *     in LOCAL_RUNNERS_COLLECTION, and releases the lease with the outcome.
 *   - A request nobody took within SWISS_RUNNER_PICKUP_MS, while no runner
 *     reports a fresh heartbeat from a Swiss exit, holds the order for the
 *     owner (`portal:swiss_runner_offline`). There is no fallback to GitHub:
 *     the portal would refuse it again.
 *
 * Neither collection is matched by firestore.rules: clients are denied. Only
 * opaque order ids, modes, rounds and times are stored; nothing personal.
 */

import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

export const SWISS_EGRESS = 'ch';
export const SWISS_EGRESS_COUNTRY = 'CH';
export const REGION_UNSUPPORTED_REASON = 'application_region_unsupported';
export const REGION_UNSUPPORTED_HOLD = `portal:${REGION_UNSUPPORTED_REASON}`;
export const SWISS_RUNNER_OFFLINE_REASON = 'swiss_runner_offline';
export const SWISS_RUNNER_OFFLINE_HOLD = `portal:${SWISS_RUNNER_OFFLINE_REASON}`;
export const LOCAL_DISPATCH_COLLECTION = 'assisted_application_local_dispatch';
export const LOCAL_RUNNERS_COLLECTION = 'assisted_application_local_runners';
/** A request nobody leased for this long, with no Swiss runner alive, holds the order. */
export const SWISS_RUNNER_PICKUP_MS = 20 * 60 * 1000;
/** The runner writes its heartbeat every loop (30 s by default); older than this, it is not alive. */
export const SWISS_RUNNER_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
/**
 * A lease outlives the agent's own timeout (local-runner.mjs kills the run at
 * 120 minutes, as the workflow's timeout-minutes) and stays shorter than the
 * Functions watchdog (RUN_WATCHDOG_MS, 150 minutes): a crashed runner's lease
 * has expired before the watchdog asks for a new run.
 */
export const LOCAL_DISPATCH_LEASE_MS = 140 * 60 * 1000;
/** A run that could not even start (Remote Config, Codex broker) goes back to the queue this many times at most. */
export const LOCAL_DISPATCH_PREP_MAX_ATTEMPTS = 3;
export const SWISS_RUNNER_OFFLINE_REASONS = Object.freeze(['heartbeat_missing', 'heartbeat_stale', 'egress_not_swiss']);
const RUNNING_STATES = new Set(['drafting', 'regenerating', 'submitting']);
const LOCAL_MODES = new Set(['draft', 'submit']);
const PENDING_SCAN_LIMIT = 50;
const RUNNER_SCAN_LIMIT = 20;

/** The order must leave from a Swiss connection. */
export function requiresSwissEgress(flow) {
  return flow?.egress?.required === SWISS_EGRESS;
}

/** The persistent mark, with its proof: which portal answer, in which round, when, and how it was learnt. */
export function swissEgressMark({ round, nowMs, source }) {
  return {
    required: SWISS_EGRESS,
    reason: REGION_UNSUPPORTED_REASON,
    round: Number(round) || 1,
    at: Number(nowMs) || Date.now(),
    source: String(source || 'portal_handoff').slice(0, 40),
  };
}

/** One request per run the flow asked for: the watchdog's new request has a new key. */
export function localDispatchKey({ mode, round, requestedAt }) {
  return `${String(mode)}:r${Number(round) || 1}:${Number(requestedAt) || 0}`;
}

export function localDispatchRefFor(db, orderId) {
  return db.collection(LOCAL_DISPATCH_COLLECTION).doc(String(orderId));
}

export function localRunnerRefFor(db, runnerId) {
  return db.collection(LOCAL_RUNNERS_COLLECTION).doc(String(runnerId));
}

function orderRef(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
}

/**
 * Whether a Swiss runner is alive and may take work, from the heartbeats.
 * @returns {{online:boolean, reason:string|null, runners:number}}
 */
export function swissRunnerAvailability(heartbeats, nowMs = Date.now()) {
  const list = (Array.isArray(heartbeats) ? heartbeats : []).filter(beat => beat && typeof beat === 'object');
  if (!list.length) return { online: false, reason: 'heartbeat_missing', runners: 0 };
  const fresh = list.filter(beat => Number(beat.at) > 0 && nowMs - Number(beat.at) <= SWISS_RUNNER_HEARTBEAT_STALE_MS);
  if (!fresh.length) return { online: false, reason: 'heartbeat_stale', runners: 0 };
  const eligible = fresh.filter(beat => beat.eligible === true && beat.egressCountry === SWISS_EGRESS_COUNTRY);
  if (!eligible.length) return { online: false, reason: 'egress_not_swiss', runners: 0 };
  return { online: true, reason: null, runners: eligible.length };
}

/**
 * Why a queued request must not run any more, or null. The flow is the
 * authority: the request runs only while the flow still waits for that very
 * run (same state, round and dispatch time) and the order is still live.
 */
export function localDispatchStaleReason(item, flow, order) {
  if (!item || !LOCAL_MODES.has(item.mode)) return 'request_invalid';
  if (!order || order.paymentStatus !== 'paid') return 'order_not_paid';
  if (order.withdrawnAt || order.purgingAt || order.purgedAt) return 'order_closed';
  if (['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)) return 'order_closed';
  if (['pending', 'succeeded', 'refunded'].includes(order.refundStatus)) return 'refund';
  if (!flow || !RUNNING_STATES.has(flow.state)) return 'flow_not_running';
  if ((item.mode === 'submit') !== (flow.state === 'submitting')) return 'flow_mode_changed';
  if (Number(flow.round || 1) !== Number(item.round)) return 'stale_round';
  if (Number(flow.dispatch?.requestedAt || 0) !== Number(item.requestedAt)) return 'superseded';
  if (!requiresSwissEgress(flow)) return 'egress_not_required';
  return null;
}

/**
 * The dispatch effect of a marked order: queue the run for the Swiss runner.
 * Idempotent by key; a newer request replaces an older pending one, and a
 * lease in progress stays where it is (the runner finds the newer key when it
 * releases, and the next lease takes it).
 */
export async function enqueueLocalDispatch({ db, orderId, flow, mode, reason = null, nowMs = Date.now() }) {
  if (!LOCAL_MODES.has(mode)) throw new Error(`local_dispatch_mode_unsupported:${mode}`);
  const round = Number(flow?.round) || 1;
  const requestedAt = Number(flow?.dispatch?.requestedAt) || nowMs;
  const key = localDispatchKey({ mode, round, requestedAt });
  const ref = localDispatchRefFor(db, orderId);
  return db.runTransaction(async (transaction) => {
    const existing = (await transaction.get(ref)).data() || null;
    if (existing?.key === key) return { ok: true, channel: 'swiss_local', queued: false, duplicate: true, key };
    transaction.set(ref, {
      orderId: String(orderId),
      key,
      mode,
      round,
      requestedAt,
      attempts: Number(flow?.dispatch?.attempts) || 1,
      reason: reason ? String(reason).slice(0, 60) : null,
      egress: SWISS_EGRESS,
      status: 'pending',
      queuedAt: nowMs,
      prepFailures: 0,
      finishedAt: null,
      result: null,
    }, { merge: true });
    return { ok: true, channel: 'swiss_local', queued: true, key };
  });
}

/**
 * Put back in the queue, in a transaction each, the requests whose lease ended
 * without a release: the runner holding them crashed, slept or lost its exit
 * (review PRR_kwDORN5k2M8AAAABXRWXRQ). The request keeps its `queuedAt`, so a
 * request nobody can take any more is held by the sweep at once; a live runner
 * leases it again, after the flow check (a superseded request closes as stale).
 * @returns {Promise<number>} how many requests went back to the queue
 */
export async function requeueExpiredLeases({ db, nowMs = Date.now() }) {
  const snapshot = await db.collection(LOCAL_DISPATCH_COLLECTION).where('status', '==', 'leased').limit(PENDING_SCAN_LIMIT).get();
  let requeued = 0;
  for (const doc of snapshot.docs || []) {
    if (!(Number(doc.data()?.lease?.until) <= nowMs)) continue;
    const done = await db.runTransaction(async (transaction) => {
      const item = (await transaction.get(doc.ref)).data() || null;
      if (!item || item.status !== 'leased' || !(Number(item.lease?.until) <= nowMs)) return false;
      transaction.set(doc.ref, {
        status: 'pending',
        lease: null,
        requeuedAt: nowMs,
        leaseExpiries: (Number(item.leaseExpiries) || 0) + 1,
        lastRun: {
          key: item.lease.key || item.key, runnerId: item.lease.runnerId || null, startedAt: Number(item.lease.at) || null,
          finishedAt: nowMs, status: 'lease_expired', exitCode: null, code: 'lease_expired',
        },
      }, { merge: true });
      return true;
    });
    if (done) requeued += 1;
  }
  return requeued;
}

/**
 * Lease the oldest runnable request, at most one, in a transaction: a request
 * already leased (by this or another runner, on the same order) is never
 * leased again before its lease ends; one whose lease ended unreleased goes
 * back to the queue first (requeueExpiredLeases). A request whose flow moved
 * on is closed as `stale` and never runs.
 * @returns {Promise<{leased:object|null, stale:Array<{orderId:string, code:string}>}>}
 */
export async function leaseLocalDispatch({ db, runnerId, nowMs = Date.now(), leaseMs = LOCAL_DISPATCH_LEASE_MS }) {
  const id = String(runnerId || '').trim();
  if (!id) throw new Error('runner_id_missing');
  await requeueExpiredLeases({ db, nowMs });
  const snapshot = await db.collection(LOCAL_DISPATCH_COLLECTION).where('status', '==', 'pending').limit(PENDING_SCAN_LIMIT).get();
  const candidates = (snapshot.docs || [])
    .map(doc => ({ ref: doc.ref, data: doc.data() || {} }))
    .sort((a, b) => (Number(a.data.requestedAt) || 0) - (Number(b.data.requestedAt) || 0));
  const stale = [];
  for (const candidate of candidates) {
    const orderId = String(candidate.data.orderId || candidate.ref.id);
    const outcome = await db.runTransaction(async (transaction) => {
      const [itemSnapshot, orderSnapshot, flowSnapshot] = await Promise.all([
        transaction.get(candidate.ref),
        transaction.get(orderRef(db, orderId)),
        transaction.get(orderRef(db, orderId).collection('automation').doc('flow')),
      ]);
      const item = itemSnapshot.data() || null;
      if (!item || item.status !== 'pending') return null;
      if (item.lease && Number(item.lease.until) > nowMs) return null;
      const code = localDispatchStaleReason(item, flowSnapshot.data() || null, orderSnapshot.data() || null);
      if (code) {
        transaction.set(candidate.ref, { status: 'stale', finishedAt: nowMs, result: { code, at: nowMs }, lease: null }, { merge: true });
        return { stale: code };
      }
      const lease = { runnerId: id, key: item.key, at: nowMs, until: nowMs + leaseMs };
      transaction.set(candidate.ref, { status: 'leased', lease }, { merge: true });
      return { leased: { orderId, key: item.key, mode: item.mode, round: Number(item.round) || 1, requestedAt: Number(item.requestedAt), lease } };
    });
    if (outcome?.stale) stale.push({ orderId, code: outcome.stale });
    if (outcome?.leased) return { leased: outcome.leased, stale };
  }
  return { leased: null, stale };
}

/**
 * Release a lease with the run's outcome. Only the runner that holds the lease
 * for that key may release it. When a newer request arrived meanwhile, the
 * document stays pending for it. `retry`: the agent never started (its
 * environment could not be prepared); the request goes back to the queue,
 * at most LOCAL_DISPATCH_PREP_MAX_ATTEMPTS times, then fails.
 */
export async function completeLocalDispatch({ db, orderId, key, runnerId, outcome = {}, nowMs = Date.now() }) {
  const ref = localDispatchRefFor(db, orderId);
  return db.runTransaction(async (transaction) => {
    const item = (await transaction.get(ref)).data() || null;
    if (!item?.lease || item.lease.runnerId !== String(runnerId) || item.lease.key !== key) {
      return { released: false, reason: 'lease_lost' };
    }
    const prepFailures = (Number(item.prepFailures) || 0) + (outcome.status === 'retry' ? 1 : 0);
    const status = outcome.status === 'done' ? 'done'
      : outcome.status === 'retry' && prepFailures < LOCAL_DISPATCH_PREP_MAX_ATTEMPTS ? 'pending' : 'failed';
    const lastRun = {
      key,
      runnerId: String(runnerId),
      startedAt: Number(item.lease.at) || null,
      finishedAt: nowMs,
      status,
      exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
      code: outcome.code ? String(outcome.code).slice(0, 80) : null,
    };
    const patch = { lease: null, lastRun };
    if (item.key === key) {
      Object.assign(patch, { status, prepFailures, result: { code: lastRun.code, exitCode: lastRun.exitCode, at: nowMs } });
      if (status !== 'pending') patch.finishedAt = nowMs;
    }
    transaction.set(ref, patch, { merge: true });
    return { released: true, status: item.key === key ? status : 'pending', prepFailures };
  });
}

/** The runner's heartbeat: what it saw of its exit, whether it takes work, what it runs now. */
export async function writeRunnerHeartbeat({ db, runnerId, nowMs = Date.now(), egressCountry = null, eligible = false, reason = null, busy = null, version = null }) {
  const id = String(runnerId || '').trim();
  if (!id) throw new Error('runner_id_missing');
  await localRunnerRefFor(db, id).set({
    runnerId: id,
    at: nowMs,
    egressCountry: egressCountry ? String(egressCountry).toUpperCase().slice(0, 4) : null,
    eligible: eligible === true,
    reason: reason ? String(reason).slice(0, 80) : null,
    busy: busy && busy.orderId ? { orderId: String(busy.orderId), key: String(busy.key || ''), since: Number(busy.since) || nowMs } : null,
    version: version ? String(version).slice(0, 64) : null,
  }, { merge: true });
  return { ok: true };
}

/**
 * Sweep step: a request still pending past SWISS_RUNNER_PICKUP_MS while no
 * Swiss runner is alive holds its order for the owner with the reason. A
 * runner that is alive but busy is waited for: the watchdog decides.
 *
 * Durable in two steps (review PRR_kwDORN5k2M8AAAABXRWXRQ): the request first
 * becomes `expiring` (atomically, only if nobody leased it meanwhile: a runner
 * leases only `pending`), then the flow's `swiss_runner_offline` transition is
 * applied, and only then is the request `expired`. When that transition
 * throws, the request stays `expiring` and every later sweep applies it again;
 * a runner back online by then gets it back as `pending` instead. A lease that
 * ended unreleased goes back to the queue first (requeueExpiredLeases).
 * @param {{db, nowMs?:number, applyEvent:(args:object)=>Promise<object>, runEffect:Function}} args
 */
export async function holdUnservedLocalDispatches({ db, nowMs = Date.now(), applyEvent, runEffect }) {
  const summary = { due: 0, held: 0, waiting: 0, requeued: 0, failed: 0 };
  summary.requeued = await requeueExpiredLeases({ db, nowMs });
  const [pending, expiring] = await Promise.all([
    db.collection(LOCAL_DISPATCH_COLLECTION).where('status', '==', 'pending').limit(PENDING_SCAN_LIMIT).get(),
    db.collection(LOCAL_DISPATCH_COLLECTION).where('status', '==', 'expiring').limit(PENDING_SCAN_LIMIT).get(),
  ]);
  const due = (pending.docs || []).filter((doc) => {
    const item = doc.data() || {};
    return Number(item.queuedAt || item.requestedAt) + SWISS_RUNNER_PICKUP_MS <= nowMs;
  });
  const unfinished = expiring.docs || [];
  summary.due = due.length + unfinished.length;
  if (!summary.due) return summary;
  const runners = await db.collection(LOCAL_RUNNERS_COLLECTION).limit(RUNNER_SCAN_LIMIT).get();
  const availability = swissRunnerAvailability((runners.docs || []).map(doc => doc.data()), nowMs);
  if (availability.online) {
    // The runner came back before the flow was held: the request is its work again.
    for (const doc of unfinished) {
      const key = doc.data()?.key;
      await db.runTransaction(async (transaction) => {
        const item = (await transaction.get(doc.ref)).data() || null;
        if (item?.status === 'expiring' && item.key === key) transaction.set(doc.ref, { status: 'pending', result: null }, { merge: true });
      });
    }
    summary.waiting = summary.due;
    return summary;
  }
  const toApply = [];
  for (const doc of due) {
    const seen = doc.data() || {};
    const claimed = await db.runTransaction(async (transaction) => {
      const item = (await transaction.get(doc.ref)).data() || null;
      if (!item || item.status !== 'pending' || item.key !== seen.key) return null;
      if (item.lease && Number(item.lease.until) > nowMs) return null;
      transaction.set(doc.ref, {
        status: 'expiring',
        result: { code: SWISS_RUNNER_OFFLINE_REASON, reason: availability.reason, at: nowMs },
      }, { merge: true });
      return item;
    });
    if (claimed) toApply.push({ ref: doc.ref, item: claimed });
  }
  for (const doc of unfinished) toApply.push({ ref: doc.ref, item: doc.data() || {} });
  for (const { ref, item } of toApply) {
    let result;
    try {
      result = await applyEvent({
        db,
        orderId: String(item.orderId || ref.id),
        event: { type: SWISS_RUNNER_OFFLINE_REASON, reason: availability.reason, round: Number(item.round) || 1, requestedAt: Number(item.requestedAt) || 0 },
        actor: 'swiss-runner-watch',
        runEffect,
        nowMs,
        expectedRound: Number(item.round) || 1,
      });
    } catch (error) {
      // Left `expiring`: the next sweep applies the transition again.
      summary.failed += 1;
      console.error('[assistedApplicationSwissRunner] offline hold not applied', String(item.orderId || ref.id),
        error instanceof Error ? error.message : String(error));
      continue;
    }
    // Applied, or refused for good (the flow moved on): the request is closed.
    await db.runTransaction(async (transaction) => {
      const current = (await transaction.get(ref)).data() || null;
      if (current?.status !== 'expiring' || current.key !== item.key) return;
      transaction.set(ref, {
        status: 'expired',
        finishedAt: nowMs,
        result: {
          code: SWISS_RUNNER_OFFLINE_REASON, reason: availability.reason, at: nowMs,
          ...(result?.ok ? {} : { ignored: String(result?.ignored || 'unknown').slice(0, 60) }),
        },
      }, { merge: true });
    });
    if (result?.ok) summary.held += 1;
  }
  return summary;
}
