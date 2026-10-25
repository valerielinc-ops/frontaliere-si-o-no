#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { isInvokedDirectly } from './is-invoked-directly.mjs';
import { createR2Request, normalizeS3MatchEtag } from './r2-section-lock.mjs';

export const IMAGE_NAMESPACES = Object.freeze(['blog', 'places']);
export const IMAGE_LEASE_PROTOCOL_VERSION = 1;
export const IMAGE_LOCK_KEY_PREFIX = 'internal/ci/image-namespace-locks';
export const IMAGE_LOCK_LEASE_MS = 7 * 60 * 60 * 1000;
export const IMAGE_LOCK_ACQUIRE_TIMEOUT_MS = 15 * 60 * 1000;
export const IMAGE_LEASE_RELEASE_TIMEOUT_MS = 30_000;
export const IMAGE_LOCK_RELEASE_RETRY_MS = 1_000;
export const IMAGE_LOCK_POLL_MS = 5_000;
export const IMAGE_LEASE_CONTEXT_ENV = 'FRONTALIERE_R2_IMAGE_LEASE_CONTEXT';
export const DECIMAL_LEASE_TIMESTAMP_RE = /^(?:0|[1-9]\d*)$/u;

const CONTEXT_VERSION = 1;
const IMAGE_LOCK_CLEANUP_ATTEMPTS = 4;
const COMMAND_OPTION_RULES = new Map([
  ['acquire', { allowed: ['--namespace'], required: ['--namespace'] }],
  ['verify', { allowed: ['--namespace', '--context'], required: ['--namespace', '--context'] }],
  ['release', {
    allowed: ['--context', '--fence-missing-candidate', '--ignore-not-owned'],
    required: ['--context'],
  }],
]);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[r2-image-namespace-lock] ${name} is required`);
  }
  return value;
}

function positiveDuration(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[r2-image-namespace-lock] ${name} must be a positive duration`);
  }
  return value;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeTimestamp(value, name) {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`[r2-image-namespace-lock] ${name} must be a non-negative safe integer millisecond timestamp`);
  }
  return value;
}

export function parseLeaseTimestamp(raw) {
  if (typeof raw !== 'string' || !DECIMAL_LEASE_TIMESTAMP_RE.test(raw)) return null;
  const timestamp = Number(raw);
  return Number.isSafeInteger(timestamp) && timestamp >= 1 ? timestamp : null;
}

export function parseImageNamespaces(value) {
  const raw = Array.isArray(value) ? value : requiredString(value, '--namespace').split(',');
  const requested = [...new Set(raw.map((namespace) => String(namespace).trim()).filter(Boolean))];
  if (requested.length === 0) {
    throw new Error('[r2-image-namespace-lock] --namespace must name at least one namespace');
  }
  for (const namespace of requested) {
    if (!IMAGE_NAMESPACES.includes(namespace)) {
      throw new Error(`[r2-image-namespace-lock] unknown namespace "${namespace}"`);
    }
  }
  return IMAGE_NAMESPACES.filter((namespace) => requested.includes(namespace));
}

export function imageNamespaceForKey(key) {
  if (typeof key !== 'string') return null;
  for (const namespace of IMAGE_NAMESPACES) {
    if (key.startsWith(`images/${namespace}/`)) return namespace;
  }
  return null;
}

export function imageNamespaceLockKey(namespace) {
  if (!IMAGE_NAMESPACES.includes(namespace)) {
    throw new Error(`[r2-image-namespace-lock] unknown namespace "${namespace}"`);
  }
  return `${IMAGE_LOCK_KEY_PREFIX}/${namespace}.json`;
}

export function isImageNamespaceLockPayload(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && IMAGE_NAMESPACES.includes(value.namespace)
      && typeof value.owner === 'string'
      && value.owner.length > 0
      && typeof value.leaseId === 'string'
      && value.leaseId.length > 0
      && isNonNegativeSafeInteger(value.acquiredAt)
      && isNonNegativeSafeInteger(value.expiresAt)
      && (value.releasedAt === undefined || isNonNegativeSafeInteger(value.releasedAt))
      && ((value.releasedAt === undefined && value.expiresAt > value.acquiredAt)
        || (value.releasedAt !== undefined
          && value.releasedAt >= value.acquiredAt
          && value.expiresAt === value.releasedAt)),
  );
}

function readHeader(response, name) {
  return normalizeS3MatchEtag(
    response?.headers?.get?.(name)
      ?? response?.headers?.[name]
      ?? response?.headers?.[name.toLowerCase()],
  );
}

async function responseText(response) {
  if (typeof response?.text === 'function') return response.text();
  return '';
}

function r2ResponseError(message, status) {
  const error = new Error(message);
  error.r2Status = status;
  return error;
}

function imageLeaseAbortError() {
  const error = new Error('[r2-image-namespace-lock] image namespace lease acquisition aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw imageLeaseAbortError();
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(imageLeaseAbortError());
    };

    if (signal?.aborted) {
      reject(imageLeaseAbortError());
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function waitForRetry(ms, sleep, signal) {
  throwIfAborted(signal);
  if (!signal) return sleep(ms);

  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(imageLeaseAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return Promise.race([Promise.resolve().then(() => sleep(ms, signal)), aborted])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

function parseLeaseContext(value) {
  let context = value;
  if (typeof value === 'string') {
    try {
      context = JSON.parse(value);
    } catch {
      throw new Error('[r2-image-namespace-lock] lease context is not valid JSON');
    }
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)
      || context.version !== CONTEXT_VERSION || !Array.isArray(context.leases)
      || context.leases.length === 0) {
    throw new Error('[r2-image-namespace-lock] lease context has an invalid shape');
  }

  const leases = context.leases.map((lease) => {
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)
        || !IMAGE_NAMESPACES.includes(lease.namespace)
        || typeof lease.owner !== 'string' || lease.owner.length === 0
        || typeof lease.leaseId !== 'string' || lease.leaseId.length === 0
        || !isNonNegativeSafeInteger(lease.expiresAt)) {
      throw new Error('[r2-image-namespace-lock] lease context contains an invalid lease');
    }
    const etag = lease.etag === undefined ? undefined : normalizeS3MatchEtag(lease.etag);
    if (lease.etag !== undefined && !etag) {
      throw new Error(`[r2-image-namespace-lock] lease context has no strong ETag for ${lease.namespace}`);
    }
    if (lease.acquiredAt !== undefined && !isNonNegativeSafeInteger(lease.acquiredAt)) {
      throw new Error('[r2-image-namespace-lock] lease context has an invalid acquiredAt');
    }
    return {
      namespace: lease.namespace,
      owner: lease.owner,
      leaseId: lease.leaseId,
      ...(isNonNegativeSafeInteger(lease.acquiredAt) ? { acquiredAt: lease.acquiredAt } : {}),
      expiresAt: lease.expiresAt,
      ...(etag ? { etag } : {}),
    };
  });
  const namespaces = leases.map(({ namespace }) => namespace);
  if (new Set(namespaces).size !== namespaces.length) {
    throw new Error('[r2-image-namespace-lock] lease context repeats a namespace');
  }
  return {
    version: CONTEXT_VERSION,
    leases: parseImageNamespaces(namespaces).map(
      (namespace) => leases.find((lease) => lease.namespace === namespace),
    ),
  };
}

export function serializeImageLeaseContext(leases) {
  if (!Array.isArray(leases) || leases.length === 0) {
    throw new Error('[r2-image-namespace-lock] at least one lease is required');
  }
  return JSON.stringify(parseLeaseContext({ version: CONTEXT_VERSION, leases }));
}

async function readCurrentLease(request, namespace) {
  const response = await request({ method: 'GET', key: imageNamespaceLockKey(namespace) });
  if (response.status === 404) return null;
  const body = await responseText(response);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`[r2-image-namespace-lock] read ${namespace} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`[r2-image-namespace-lock] lock ${namespace} is not valid JSON; refusing an unsafe takeover`);
  }
  if (!isImageNamespaceLockPayload(payload) || payload.namespace !== namespace) {
    throw new Error(`[r2-image-namespace-lock] lock ${namespace} has an invalid lease; refusing an unsafe takeover`);
  }
  return { payload, etag: readHeader(response, 'etag') };
}

async function putLease(request, namespace, payload, condition, operation = 'acquire') {
  const response = await request({
    method: 'PUT',
    key: imageNamespaceLockKey(namespace),
    body: JSON.stringify(payload),
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      [condition.name]: condition.value,
    },
  });
  if (response.status >= 200 && response.status < 300) {
    return { etag: readHeader(response, 'etag') };
  }
  if (response.status === 409 || response.status === 412) return null;
  const body = await responseText(response);
  throw r2ResponseError(`[r2-image-namespace-lock] ${operation} ${namespace} failed (${response.status}): ${body.slice(0, 300)}`, response.status);
}

function leaseMatches(current, lease) {
  return Boolean(
    current
      && current.payload.owner === lease.owner
      // Expiry changes when a lease is renewed. The owner/lease ID pair is
      // the stable identity used for reconciliation and safe release.
      && current.payload.leaseId === lease.leaseId,
  );
}

function tombstonePayload(payload, now, { rotateEtag = false } = {}) {
  const releasedAt = safeTimestamp(Math.max(
    now(),
    payload.acquiredAt,
    rotateEtag
      && isNonNegativeSafeInteger(payload.releasedAt)
      && payload.releasedAt < Number.MAX_SAFE_INTEGER
      ? payload.releasedAt + 1
      : 0,
  ), 'releasedAt');
  return { ...payload, releasedAt, expiresAt: releasedAt };
}

function matchingStaleWriteCondition(current, staleWriteConditions, now, { allowMissingEtag = false } = {}) {
  if (!current || (!current.etag && !allowMissingEtag)) return null;
  return staleWriteConditions.find(({ etag, payload }) => (
    (!current.etag || etag === current.etag)
      && payload.owner === current.payload.owner
      && payload.leaseId === current.payload.leaseId
      && current.payload.expiresAt <= now()
  )) ?? null;
}

async function reconcileAmbiguousLeaseWrite(request, namespace, lease, error) {
  let current;
  try {
    current = await readCurrentLease(request, namespace);
  } catch (reconciliationError) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    const reconciliationMessage = reconciliationError instanceof Error
      ? reconciliationError.message
      : String(reconciliationError);
    throw new AggregateError(
      [error, reconciliationError],
      `[r2-image-namespace-lock] acquire ${namespace} failed ambiguously; reconciliation also failed: ${originalMessage}; ${reconciliationMessage}`,
      { cause: error },
    );
  }
  if (leaseMatches(current, lease)) {
    const recoveredLease = { ...lease, etag: current.etag };
    if (!current.etag) {
      throw new Error(`[r2-image-namespace-lock] ${namespace} acquisition could not be confirmed with an ETag`);
    }
    return { current, lease: recoveredLease };
  }
  return { current, lease: null };
}

async function acquisitionFailureAfterCleanup(namespace, lease, request, now, error, staleWriteConditions) {
  const cleanup = await releaseImageNamespaceLeasesWithDeadline([lease], {
    request,
    now,
    fenceMissingCandidate: true,
    staleWriteConditions,
  });
  const cleanupError = cleanup.status === 'released'
    ? null
    : cleanup.error ?? new Error(`[r2-image-namespace-lock] cleanup ${namespace} did not finish`);
  if (!cleanupError) return error;

  const acquisitionMessage = error instanceof Error ? error.message : String(error);
  const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  return new AggregateError(
    [error, cleanupError],
    `[r2-image-namespace-lock] acquire ${namespace} failed; candidate cleanup also failed: ${cleanupMessage}; ${acquisitionMessage}`,
    { cause: error },
  );
}

async function confirmAcquiredLease(request, lease) {
  let current = lease.etag ? null : await readCurrentLease(request, lease.namespace);
  if (lease.etag) return lease;
  if (!current || !current.etag || !leaseMatches(current, lease)) {
    throw new Error(`[r2-image-namespace-lock] ${lease.namespace} acquisition could not be confirmed with an ETag`);
  }
  return { ...lease, etag: current.etag };
}

export async function acquireImageNamespaceLock(
  namespace,
  {
    owner: ownerOverride,
    leaseId: leaseIdOverride,
    request = createR2Request(),
    now = Date.now,
    sleep = delay,
    timeoutMs = IMAGE_LOCK_ACQUIRE_TIMEOUT_MS,
    pollMs = IMAGE_LOCK_POLL_MS,
    leaseMs = IMAGE_LOCK_LEASE_MS,
    acquiredAt: acquiredAtOverride,
    onWait = () => {},
    onLeaseWritten = () => {},
    signal,
  } = {},
) {
  parseImageNamespaces([namespace]);
  positiveDuration(timeoutMs, 'acquire timeout');
  positiveDuration(pollMs, 'poll interval');
  positiveDuration(leaseMs, 'lease duration');
  if (acquiredAtOverride !== undefined && !isNonNegativeSafeInteger(acquiredAtOverride)) {
    throw new Error('[r2-image-namespace-lock] acquiredAt must be a non-negative safe integer millisecond timestamp');
  }

  const owner = ownerOverride === undefined ? randomUUID() : requiredString(ownerOverride, 'owner');
  const leaseId = leaseIdOverride === undefined ? randomUUID() : requiredString(leaseIdOverride, 'lease ID');
  const safeNow = () => safeTimestamp(now(), 'clock');
  const acquisitionStartedAt = safeNow();
  const acquiredAt = acquiredAtOverride ?? acquisitionStartedAt;
  const deadline = safeTimestamp(acquisitionStartedAt + timeoutMs, 'acquisition deadline');
  // Keep the exact payload stable across retries. If an earlier conditional
  // PUT is still in flight, a later 409/404 must still be recognizable as the
  // same acquisition when that write becomes visible.
  const lease = {
    namespace,
    owner,
    leaseId,
    acquiredAt,
    expiresAt: acquiredAt + leaseMs,
  };
  if (!isNonNegativeSafeInteger(lease.expiresAt) || lease.expiresAt <= acquiredAt) {
    throw new Error('[r2-image-namespace-lock] lease expiry must be a non-negative safe integer timestamp');
  }

  let candidateMayExist = false;
  const staleWriteConditions = [];
  try {
    while (safeNow() <= deadline) {
      throwIfAborted(signal);
      let currentAfterWrite;
      let created;
      try {
        created = await putLease(request, namespace, lease, { name: 'if-none-match', value: '*' });
      } catch (error) {
        if (error?.r2Status !== undefined && error.r2Status < 500 && error.r2Status !== 408) throw error;
        candidateMayExist = true;
        const reconciled = await reconcileAmbiguousLeaseWrite(request, namespace, lease, error);
        if (reconciled.lease) {
          onLeaseWritten(reconciled.lease);
          return reconciled.lease;
        }
        currentAfterWrite = reconciled.current;
      }
      if (created) {
        candidateMayExist = true;
        const writtenLease = { ...lease, etag: created.etag };
        // Record ownership before the confirmation read can fail: a successful
        // PUT may have created a live lock even when its response is incomplete.
        onLeaseWritten(writtenLease);
        return await confirmAcquiredLease(request, writtenLease);
      }

      throwIfAborted(signal);
      const current = currentAfterWrite === undefined
        ? await readCurrentLease(request, namespace)
        : currentAfterWrite;
      throwIfAborted(signal);
      if (leaseMatches(current, lease)) {
        candidateMayExist = true;
        if (!current.etag) {
          throw new Error(`[r2-image-namespace-lock] ${namespace} acquisition could not be confirmed with an ETag`);
        }
        const recoveredLease = { ...lease, etag: current.etag };
        onLeaseWritten(recoveredLease);
        return recoveredLease;
      }
      if (!current) {
        await waitForRetry(Math.min(100, Math.max(0, deadline - safeNow())), sleep, signal);
        continue;
      }
      if (current.payload.expiresAt <= safeNow()) {
        if (!current.etag) {
          throw new Error(`[r2-image-namespace-lock] lock ${namespace} has no ETag; refusing an unsafe takeover`);
        }
        let replaced;
        try {
          replaced = await putLease(request, namespace, lease, { name: 'if-match', value: current.etag });
        } catch (error) {
          if (error?.r2Status !== undefined && error.r2Status < 500 && error.r2Status !== 408) throw error;
          candidateMayExist = true;
          staleWriteConditions.push({ etag: current.etag, payload: current.payload });
          const reconciled = await reconcileAmbiguousLeaseWrite(request, namespace, lease, error);
          if (reconciled.lease) {
            onLeaseWritten(reconciled.lease);
            return reconciled.lease;
          }
        }
        if (replaced) {
          candidateMayExist = true;
          const writtenLease = { ...lease, etag: replaced.etag };
          onLeaseWritten(writtenLease);
          return await confirmAcquiredLease(request, writtenLease);
        }
        throwIfAborted(signal);
        continue;
      }

      onWait({ namespace, expiresAt: current.payload.expiresAt });
      const remaining = deadline - safeNow();
      if (remaining <= 0) break;
      await waitForRetry(Math.min(pollMs, remaining), sleep, signal);
    }

    throw new Error(`[r2-image-namespace-lock] timed out waiting for namespace ${namespace}`);
  } catch (error) {
    if (!candidateMayExist) throw error;
    throw await acquisitionFailureAfterCleanup(
      namespace,
      lease,
      request,
      safeNow,
      error,
      staleWriteConditions,
    );
  }
}

export async function acquireImageNamespaceLeases(namespaces, options = {}) {
  const normalized = parseImageNamespaces(namespaces);
  const clock = options.now ?? Date.now;
  const now = () => safeTimestamp(clock(), 'clock');
  const timeoutMs = options.timeoutMs ?? IMAGE_LOCK_ACQUIRE_TIMEOUT_MS;
  const signal = options.signal;
  positiveDuration(timeoutMs, 'acquire timeout');
  const deadline = safeTimestamp(now() + timeoutMs, 'acquisition deadline');
  const acquired = [];
  try {
    for (const namespace of normalized) {
      throwIfAborted(signal);
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new Error(`[r2-image-namespace-lock] timed out waiting for namespace ${namespace}`);
      }
      let recordedIndex = -1;
      const confirmedLease = await acquireImageNamespaceLock(namespace, {
        ...options,
        now,
        timeoutMs: remainingMs,
        onLeaseWritten: (writtenLease) => {
          recordedIndex = acquired.push(writtenLease) - 1;
        },
      });
      if (recordedIndex === -1) acquired.push(confirmedLease);
      else acquired[recordedIndex] = confirmedLease;
      // A signal may have arrived while the final confirmation GET was in
      // flight. Record the confirmed lock first, then abort so catch can CAS
      // release every acquired namespace, including the last one.
      throwIfAborted(signal);
    }
    return acquired;
  } catch (error) {
    const rollbackOptions = { ...options };
    delete rollbackOptions.signal;
    const rollbackTimeoutMs = rollbackOptions.rollbackTimeoutMs ?? IMAGE_LEASE_RELEASE_TIMEOUT_MS;
    delete rollbackOptions.rollbackTimeoutMs;
    const rollback = await releaseImageNamespaceLeasesWithDeadline(acquired, {
      ...rollbackOptions,
      timeoutMs: rollbackTimeoutMs,
      perLease: true,
    });
    if (rollback.status !== 'released') {
      const rollbackError = rollback.error ?? new Error('[r2-image-namespace-lock] rollback did not finish');
      const acquisitionMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new AggregateError(
        [error, rollbackError],
        `${acquisitionMessage}; rollback also failed: ${rollbackMessage}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function verifyImageNamespaceLease(
  contextValue,
  namespace,
  { request = createR2Request(), now = Date.now } = {},
) {
  parseImageNamespaces([namespace]);
  const context = parseLeaseContext(contextValue);
  const safeNow = () => safeTimestamp(now(), 'verification clock');
  const lease = context.leases.find((candidate) => candidate.namespace === namespace);
  if (!lease || lease.expiresAt <= safeNow()) {
    throw new Error(`[r2-image-namespace-lock] no current ${namespace} lease in context`);
  }
  const current = await readCurrentLease(request, namespace);
  if (!current || !current.etag || current.payload.expiresAt <= safeNow() || !leaseMatches(current, lease)) {
    throw new Error(`[r2-image-namespace-lock] ${namespace} lease is no longer owned by this context`);
  }
  return lease;
}

export async function releaseImageNamespaceLock(
  lease,
  {
    request = createR2Request(),
    now = Date.now,
    deadline,
    fenceMissingCandidate = false,
    staleWriteConditions = [],
    sleep = delay,
  } = {},
) {
  const parsedLease = parseLeaseContext({ version: CONTEXT_VERSION, leases: [lease] }).leases[0];
  const safeNow = () => safeTimestamp(now(), 'release clock');
  const normalized = {
    ...parsedLease,
    ...(isNonNegativeSafeInteger(lease.acquiredAt) ? { acquiredAt: lease.acquiredAt } : {}),
  };
  if (fenceMissingCandidate && !isNonNegativeSafeInteger(normalized.acquiredAt)) {
    throw new Error(`[r2-image-namespace-lock] candidate cleanup for ${parsedLease.namespace} requires acquiredAt`);
  }
  const namespace = normalized.namespace;
  const releaseDeadline = deadline === undefined ? undefined : safeTimestamp(deadline, 'release deadline');
  const releaseRequest = releaseDeadline !== undefined
    ? (input) => request({ ...input, deadline: releaseDeadline })
    : request;
  const candidateTombstone = normalized.acquiredAt === undefined
    ? undefined
    : tombstonePayload(normalized, safeNow);
  let lastAttempt = null;
  let lastError = null;
  const deadlineError = () => {
    const error = new Error(`[r2-image-namespace-lock] cleanup ${namespace} exceeded its release deadline`);
    error.code = 'IMAGE_LEASE_RELEASE_TIMEOUT';
    error.deadline = releaseDeadline;
    return error;
  };
  const assertBeforeDeadline = () => {
    if (releaseDeadline !== undefined && safeNow() >= releaseDeadline) throw deadlineError();
  };
  const sleepBeforeDeadline = async (milliseconds) => {
    if (releaseDeadline === undefined) {
      await sleep(milliseconds);
      return;
    }
    const remaining = releaseDeadline - safeNow();
    if (remaining <= 0) throw deadlineError();
    await sleep(Math.min(milliseconds, remaining));
    assertBeforeDeadline();
  };
  const retryLeaseRead = async (readError, attempt) => {
    if (attempt + 1 >= IMAGE_LOCK_CLEANUP_ATTEMPTS) throw readError;
    await sleepBeforeDeadline(IMAGE_LOCK_RELEASE_RETRY_MS);
  };

  for (let attempt = 0; attempt < IMAGE_LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline();
    let current;
    try {
      current = await readCurrentLease(releaseRequest, namespace);
    } catch (readError) {
      let usedFallbackCondition = false;
      if (!lastAttempt) {
        const staleCondition = staleWriteConditions.find(({ payload }) => payload.expiresAt <= safeNow());
        if (staleCondition) {
          lastAttempt = {
            payload: tombstonePayload(staleCondition.payload, safeNow, { rotateEtag: true }),
            condition: { name: 'if-match', value: staleCondition.etag },
            staleWriteCondition: true,
          };
          usedFallbackCondition = true;
        } else if (fenceMissingCandidate) {
          lastAttempt = {
            payload: candidateTombstone,
            condition: { name: 'if-none-match', value: '*' },
          };
          usedFallbackCondition = true;
        } else {
          // A transient GET leaves no safe current ETag to act on. Retry the
          // read before issuing any conditional write; exhaustion stays
          // fail-closed and propagates the original read error.
          await retryLeaseRead(readError, attempt);
          continue;
        }
      }
      if (!usedFallbackCondition && !fenceMissingCandidate) {
        // The previous conditional write may have failed, but a failed read
        // still cannot safely reuse its stale payload without reconciling it.
        await retryLeaseRead(readError, attempt);
        continue;
      }
      lastError = lastError ? new AggregateError(
        [lastError, readError],
        `[r2-image-namespace-lock] cleanup ${namespace} could not reconcile a conditional write`,
        { cause: lastError },
      ) : readError;
    }

    if (current) {
      if (leaseMatches(current, normalized)) {
        if (isNonNegativeSafeInteger(current.payload.releasedAt)) return true;
        const matchEtag = current.etag ?? normalizeS3MatchEtag(normalized.etag);
        if (!matchEtag) {
          throw new Error(`[r2-image-namespace-lock] lock ${namespace} has no ETag; refusing an unsafe release`);
        }
        lastAttempt = {
          payload: tombstonePayload(current.payload, safeNow),
          condition: { name: 'if-match', value: matchEtag },
        };
      } else {
        const staleCondition = matchingStaleWriteCondition(
          current,
          staleWriteConditions,
          safeNow,
          { allowMissingEtag: true },
        );
        if (!staleCondition) return false;
        lastAttempt = {
          payload: tombstonePayload(staleCondition.payload, safeNow, { rotateEtag: true }),
          condition: { name: 'if-match', value: staleCondition.etag },
          staleWriteCondition: true,
        };
      }
    } else if (current === null) {
      if (!fenceMissingCandidate) return false;
      lastAttempt = {
        payload: candidateTombstone,
        condition: { name: 'if-none-match', value: '*' },
      };
    }

    try {
      assertBeforeDeadline();
      const written = await putLease(releaseRequest, namespace, lastAttempt.payload, lastAttempt.condition, 'release');
      if (written) return true;
      lastError = new Error(`[r2-image-namespace-lock] cleanup ${namespace} conflicted with a concurrent write`);
    } catch (writeError) {
      if (writeError?.r2Status !== undefined && writeError.r2Status < 500 && writeError.r2Status !== 408) {
        throw writeError;
      }
      lastError = lastError ? new AggregateError(
        [lastError, writeError],
        `[r2-image-namespace-lock] cleanup ${namespace} encountered repeated ambiguous writes`,
        { cause: lastError },
      ) : writeError;
    }
  }

  let latest;
  try {
    assertBeforeDeadline();
    latest = await readCurrentLease(releaseRequest, namespace);
  } catch (reconciliationError) {
    const errors = lastError ? [lastError, reconciliationError] : [reconciliationError];
    throw new AggregateError(
      errors,
      `[r2-image-namespace-lock] cleanup ${namespace} could not confirm the final lease state`,
      { cause: lastError ?? reconciliationError },
    );
  }
  if (latest && leaseMatches(latest, normalized) && isNonNegativeSafeInteger(latest.payload.releasedAt)) return true;
  if (latest && !leaseMatches(latest, normalized)
      && !matchingStaleWriteCondition(latest, staleWriteConditions, safeNow, { allowMissingEtag: true })) return false;
  if (!latest && !fenceMissingCandidate) return false;

  const detail = latest
    ? `lease ${latest.payload.leaseId} remains active or a takeover may still be pending`
    : 'candidate absence is not fenced against a delayed acquisition write';
  const unresolvedError = new Error(`[r2-image-namespace-lock] cleanup ${namespace} unresolved: ${detail}`);
  throw lastError
    ? new AggregateError(
      [lastError, unresolvedError],
      `[r2-image-namespace-lock] cleanup ${namespace} failed after ${IMAGE_LOCK_CLEANUP_ATTEMPTS} attempts`,
      { cause: lastError },
    )
    : unresolvedError;
}

export async function releaseImageNamespaceLeases(leases, options = {}) {
  if (!Array.isArray(leases)) throw new Error('[r2-image-namespace-lock] leases must be an array');
  const released = [];
  const errors = [];
  for (const lease of [...leases].reverse()) {
    try {
      if (await releaseImageNamespaceLock(lease, options)) released.push(lease.namespace);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    const describe = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const nested = error instanceof AggregateError
        ? [...error.errors].map(describe).filter(Boolean)
        : [];
      return nested.length ? [message, ...nested].join('; ') : message;
    };
    const messages = errors.map(describe);
    throw new AggregateError(errors, messages.join('; '), { cause: errors[0] });
  }
  return released;
}

function containsReleaseTimeout(error, seen = new Set()) {
  if (
    error === null
    || (typeof error !== 'object' && typeof error !== 'function')
    || seen.has(error)
  ) {
    return false;
  }
  seen.add(error);
  if (error.code === 'R2_REQUEST_TIMEOUT' || error.code === 'IMAGE_LEASE_RELEASE_TIMEOUT') {
    return true;
  }
  if (error instanceof AggregateError
    && [...error.errors].some((nested) => containsReleaseTimeout(nested, seen))) {
    return true;
  }
  return containsReleaseTimeout(error.cause, seen);
}

export function classifyReleaseDeadlineRace(outcome, { deadline } = {}) {
  if (outcome?.timedOut === true) return 'timeout';
  if (!outcome || !Array.isArray(outcome.results)) return 'indeterminate';
  if (!Number.isFinite(deadline) || !Number.isFinite(outcome.finishedAt)) return 'indeterminate';
  if (outcome.finishedAt < deadline) return 'completed';
  if (outcome.finishedAt > deadline) return 'timeout';
  return 'indeterminate';
}

/**
 * Release image leases within one absolute budget. `perLease` starts each
 * namespace independently so a slow lease cannot prevent the others starting.
 */
export async function releaseImageNamespaceLeasesWithDeadline(
  leases,
  {
    timeoutMs = IMAGE_LEASE_RELEASE_TIMEOUT_MS,
    perLease = false,
    releaseImpl = releaseImageNamespaceLeases,
    ...options
  } = {},
) {
  if (!Array.isArray(leases)) throw new Error('[r2-image-namespace-lock] leases must be an array');
  positiveDuration(timeoutMs, 'image lease release timeout');
  if (leases.length === 0) return { status: 'released', timedOut: false, released: [] };

  const now = options.now ?? Date.now;
  const deadline = safeTimestamp(now() + timeoutMs, 'release deadline');
  const timeoutError = new Error(`[r2-image-namespace-lock] rilascio lease immagini oltre il limite (${timeoutMs}ms)`);
  timeoutError.code = 'IMAGE_LEASE_RELEASE_TIMEOUT';
  timeoutError.timeoutMs = timeoutMs;
  const groups = perLease ? leases.map((lease) => [lease]) : [leases];
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const work = Promise.allSettled(groups.map((group) => {
    if (now() >= deadline) return Promise.reject(timeoutError);
    return Promise.resolve().then(() => releaseImpl(group, { ...options, deadline, now }));
  })).then((results) => ({ timedOut: false, results, finishedAt: now() }));
  const outcome = await Promise.race([work, timeout]);
  clearTimeout(timeoutId);
  const deadlineRace = classifyReleaseDeadlineRace(outcome, { deadline });
  if (deadlineRace !== 'completed') {
    return { status: 'timeout', timedOut: true, released: null, error: timeoutError, deadlineRace };
  }

  const released = [];
  const errors = [];
  for (const [index, result] of outcome.results.entries()) {
    if (result.status === 'rejected') {
      errors.push(result.reason);
      continue;
    }
    if (Array.isArray(result.value)) released.push(...result.value);
    else if (result.value === true) released.push(groups[index][0]?.namespace);
  }
  if (errors.length > 0) {
    if (errors.some((error) => containsReleaseTimeout(error))) {
      return { status: 'timeout', timedOut: true, released: null, error: timeoutError };
    }
    return {
      status: 'failed',
      timedOut: false,
      released,
      error: new AggregateError(errors, errors.map((error) => error?.message ?? String(error)).join('; '), { cause: errors[0] }),
    };
  }
  return { status: 'released', timedOut: false, released: released.filter(Boolean) };
}

export function releaseNotOwnedIsFatal({ fenceMissingCandidate = false, ignoreNotOwned = false } = {}) {
  return !fenceMissingCandidate && !ignoreNotOwned;
}

function parseCommandOptions(command, args) {
  const commandFlags = COMMAND_OPTION_RULES.get(command);
  if (!commandFlags) {
    throw new Error('usage: r2-image-namespace-lock.mjs <acquire|verify|release> --namespace <blog[,places]> [--context <json>]');
  }

  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!commandFlags.allowed.includes(flag)) {
      throw new Error(`[r2-image-namespace-lock] unexpected argument for ${command}: ${flag}`);
    }
    if (options.has(flag)) {
      throw new Error(`[r2-image-namespace-lock] duplicate argument for ${command}: ${flag}`);
    }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`[r2-image-namespace-lock] ${flag} requires a value`);
    }
    options.set(flag, value);
    index += 1;
  }

  for (const flag of commandFlags.required) {
    if (!options.has(flag)) throw new Error(`[r2-image-namespace-lock] ${flag} is required for ${command}`);
  }
  return options;
}

async function acquireFromCli(namespaces, request, env = process.env) {
  const controller = new AbortController();
  const owner = env.FRONTALIERE_R2_IMAGE_LEASE_OWNER ?? randomUUID();
  const leaseId = env.FRONTALIERE_R2_IMAGE_LEASE_ID ?? randomUUID();
  const requestedAcquiredAt = parseLeaseTimestamp(env.FRONTALIERE_R2_IMAGE_LEASE_ACQUIRED_AT);
  const requestedExpiry = requestedAcquiredAt === null
    ? null
    : requestedAcquiredAt + IMAGE_LOCK_LEASE_MS;
  const pendingAcquiredAt = requestedExpiry !== null
    && Number.isSafeInteger(requestedExpiry)
    && requestedExpiry > requestedAcquiredAt
    ? requestedAcquiredAt
    : safeTimestamp(Date.now(), 'acquiredAt');
  const pendingExpiresAt = safeTimestamp(pendingAcquiredAt + IMAGE_LOCK_LEASE_MS, 'lease expiry');
  const pendingLeases = namespaces.map((namespace) => ({
    namespace,
    owner,
    leaseId,
    // Candidate cleanup needs a valid timestamp even when acquire never returns
    // the lease. A current object supplies its own timestamps during cleanup.
    acquiredAt: pendingAcquiredAt,
    expiresAt: pendingExpiresAt,
  }));
  let signalExitStatus = 0;
  const abortForSignal = (exitStatus) => {
    if (signalExitStatus !== 0) return;
    signalExitStatus = exitStatus;
    controller.abort();
  };
  const onSigint = () => abortForSignal(130);
  const onSigterm = () => abortForSignal(143);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    const leases = await acquireImageNamespaceLeases(namespaces, {
      request,
      signal: controller.signal,
      owner,
      leaseId,
      acquiredAt: pendingAcquiredAt,
    });
    if (signalExitStatus !== 0) {
      // A signal can race with the final promise resolution. In that case the
      // acquisition helper has returned ownership to this function instead
      // of rolling it back, so release it here before leaving the CLI.
      await releaseImageNamespaceLeases(leases, { request });
      process.exitCode = signalExitStatus;
      return;
    }
    process.stdout.write(`${serializeImageLeaseContext(leases)}\n`);
  } catch (error) {
    let cleanupError;
    try {
      // The lock may have reached R2 even when its PUT response and the first
      // read-back were both lost. Reconcile the candidate identity before the
      // CLI exits so the caller's signal cleanup is not the only recovery.
      await releaseImageNamespaceLeases(pendingLeases, {
        request,
        fenceMissingCandidate: true,
      });
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
    }
    if (signalExitStatus !== 0) {
      console.error(`[r2-image-namespace-lock] ${error?.message ?? error}`);
      if (cleanupError) {
        console.error(`[r2-image-namespace-lock] signal cleanup failed: ${cleanupError?.message ?? cleanupError}`);
      }
      process.exitCode = signalExitStatus;
      return;
    }
    if (cleanupError) {
      const acquisitionMessage = error instanceof Error ? error.message : String(error);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError(
        [error, cleanupError],
        `[r2-image-namespace-lock] acquire failed: ${acquisitionMessage}; candidate cleanup failed: ${cleanupMessage}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

async function main(args = process.argv.slice(2), env = process.env) {
  const command = args[0];
  const options = parseCommandOptions(command, args.slice(1));
  const request = createR2Request(env);

  if (command === 'acquire') {
    const namespaces = parseImageNamespaces(options.get('--namespace'));
    await acquireFromCli(namespaces, request, env);
    return;
  }

  if (command === 'verify') {
    const namespaces = parseImageNamespaces(options.get('--namespace'));
    const context = options.get('--context');
    for (const namespace of namespaces) {
      await verifyImageNamespaceLease(context, namespace, { request });
    }
    return;
  }

  if (command === 'release') {
    const context = parseLeaseContext(options.get('--context'));
    const fenceMissingCandidate = options.get('--fence-missing-candidate') === 'true';
    if (options.has('--fence-missing-candidate')
        && !['true', 'false'].includes(options.get('--fence-missing-candidate'))) {
      throw new Error('[r2-image-namespace-lock] --fence-missing-candidate must be true or false');
    }
    const ignoreNotOwned = options.get('--ignore-not-owned') === 'true';
    if (options.has('--ignore-not-owned') && !['true', 'false'].includes(options.get('--ignore-not-owned'))) {
      throw new Error('[r2-image-namespace-lock] --ignore-not-owned must be true or false');
    }
    const released = await releaseImageNamespaceLeases(context.leases, { request, fenceMissingCandidate });
    const notReleased = context.leases.map(({ namespace }) => namespace).filter((namespace) => !released.includes(namespace));
    if (notReleased.length > 0 && releaseNotOwnedIsFatal({ fenceMissingCandidate, ignoreNotOwned })) {
      console.error(`[r2-image-namespace-lock] not released (lease no longer owned or present): ${notReleased.join(', ')}`);
      process.exitCode = 1;
    }
    return;
  }

  throw new Error('usage: r2-image-namespace-lock.mjs <acquire|verify|release> --namespace <blog[,places]> [--context <json>]');
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`[r2-image-namespace-lock] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
