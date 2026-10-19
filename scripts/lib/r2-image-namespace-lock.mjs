#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { isInvokedDirectly } from './is-invoked-directly.mjs';
import { createR2Request } from './r2-section-lock.mjs';

export const IMAGE_NAMESPACES = Object.freeze(['blog', 'places']);
export const IMAGE_LEASE_PROTOCOL_VERSION = 1;
export const IMAGE_LOCK_KEY_PREFIX = 'internal/ci/image-namespace-locks';
export const IMAGE_LOCK_LEASE_MS = 7 * 60 * 60 * 1000;
export const IMAGE_LOCK_ACQUIRE_TIMEOUT_MS = 15 * 60 * 1000;
export const IMAGE_LOCK_POLL_MS = 5_000;
export const IMAGE_LEASE_CONTEXT_ENV = 'FRONTALIERE_R2_IMAGE_LEASE_CONTEXT';

const CONTEXT_VERSION = 1;

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
      && Number.isFinite(value.acquiredAt)
      && Number.isFinite(value.expiresAt)
      && (value.expiresAt > value.acquiredAt
        || (Number.isFinite(value.releasedAt)
          && value.releasedAt >= value.acquiredAt
          && value.expiresAt === value.releasedAt)),
  );
}

function readHeader(response, name) {
  return response?.headers?.get?.(name)
    ?? response?.headers?.[name]
    ?? response?.headers?.[name.toLowerCase()];
}

async function responseText(response) {
  if (typeof response?.text === 'function') return response.text();
  return '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        || !Number.isFinite(lease.expiresAt)) {
      throw new Error('[r2-image-namespace-lock] lease context contains an invalid lease');
    }
    return {
      namespace: lease.namespace,
      owner: lease.owner,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
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

async function putLease(request, namespace, payload, condition) {
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
  if (response.status === 412) return null;
  const body = await responseText(response);
  throw new Error(`[r2-image-namespace-lock] acquire ${namespace} failed (${response.status}): ${body.slice(0, 300)}`);
}

function leaseMatches(current, lease) {
  return Boolean(
    current
      && current.payload.owner === lease.owner
      && current.payload.leaseId === lease.leaseId
      && current.payload.expiresAt === lease.expiresAt,
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
    request = createR2Request(),
    now = Date.now,
    sleep = delay,
    timeoutMs = IMAGE_LOCK_ACQUIRE_TIMEOUT_MS,
    pollMs = IMAGE_LOCK_POLL_MS,
    leaseMs = IMAGE_LOCK_LEASE_MS,
    onWait = () => {},
  } = {},
) {
  parseImageNamespaces([namespace]);
  positiveDuration(timeoutMs, 'acquire timeout');
  positiveDuration(pollMs, 'poll interval');
  positiveDuration(leaseMs, 'lease duration');

  const owner = randomUUID();
  const leaseId = randomUUID();
  const deadline = now() + timeoutMs;

  while (now() <= deadline) {
    const acquiredAt = now();
    const lease = {
      namespace,
      owner,
      leaseId,
      acquiredAt,
      expiresAt: acquiredAt + leaseMs,
    };
    const created = await putLease(request, namespace, lease, { name: 'if-none-match', value: '*' });
    if (created) {
      return confirmAcquiredLease(request, { ...lease, etag: created.etag });
    }

    const current = await readCurrentLease(request, namespace);
    if (!current) {
      await sleep(Math.min(100, Math.max(0, deadline - now())));
      continue;
    }
    if (current.payload.expiresAt <= now()) {
      if (!current.etag) {
        throw new Error(`[r2-image-namespace-lock] lock ${namespace} has no ETag; refusing an unsafe takeover`);
      }
      const replaced = await putLease(request, namespace, lease, { name: 'if-match', value: current.etag });
      if (replaced) return confirmAcquiredLease(request, { ...lease, etag: replaced.etag });
      continue;
    }

    onWait({ namespace, expiresAt: current.payload.expiresAt });
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  throw new Error(`[r2-image-namespace-lock] timed out waiting for namespace ${namespace}`);
}

export async function acquireImageNamespaceLeases(namespaces, options = {}) {
  const normalized = parseImageNamespaces(namespaces);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? IMAGE_LOCK_ACQUIRE_TIMEOUT_MS;
  positiveDuration(timeoutMs, 'acquire timeout');
  const deadline = now() + timeoutMs;
  const acquired = [];
  try {
    for (const namespace of normalized) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new Error(`[r2-image-namespace-lock] timed out waiting for namespace ${namespace}`);
      }
      acquired.push(await acquireImageNamespaceLock(namespace, {
        ...options,
        now,
        timeoutMs: remainingMs,
      }));
    }
    return acquired;
  } catch (error) {
    await releaseImageNamespaceLeases(acquired, options).catch(() => {});
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
  const lease = context.leases.find((candidate) => candidate.namespace === namespace);
  if (!lease || lease.expiresAt <= now()) {
    throw new Error(`[r2-image-namespace-lock] no current ${namespace} lease in context`);
  }
  const current = await readCurrentLease(request, namespace);
  if (!current || !current.etag || current.payload.expiresAt <= now() || !leaseMatches(current, lease)) {
    throw new Error(`[r2-image-namespace-lock] ${namespace} lease is no longer owned by this context`);
  }
  return lease;
}

export async function releaseImageNamespaceLock(
  lease,
  { request = createR2Request(), now = Date.now } = {},
) {
  const normalized = parseLeaseContext({ version: CONTEXT_VERSION, leases: [lease] }).leases[0];
  const current = await readCurrentLease(request, normalized.namespace);
  if (!current || !leaseMatches(current, normalized)) return false;
  if (!current.etag) {
    throw new Error(`[r2-image-namespace-lock] lock ${normalized.namespace} has no ETag; refusing an unsafe release`);
  }
  const releasedAt = Math.max(now(), current.payload.acquiredAt);
  const tombstone = {
    ...current.payload,
    releasedAt,
    expiresAt: releasedAt,
  };
  const response = await request({
    method: 'PUT',
    key: imageNamespaceLockKey(normalized.namespace),
    body: JSON.stringify(tombstone),
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'if-match': current.etag,
    },
  });
  if (response.status === 412) return false;
  if (response.status < 200 || response.status >= 300) {
    const body = await responseText(response);
    throw new Error(`[r2-image-namespace-lock] release ${normalized.namespace} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return true;
}

export async function releaseImageNamespaceLeases(leases, options = {}) {
  if (!Array.isArray(leases)) throw new Error('[r2-image-namespace-lock] leases must be an array');
  const released = [];
  let firstError;
  for (const lease of [...leases].reverse()) {
    try {
      if (await releaseImageNamespaceLock(lease, options)) released.push(lease.namespace);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return released;
}

function requiredFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`[r2-image-namespace-lock] ${flag} requires a value`);
  }
  return args[index + 1];
}

async function main(args = process.argv.slice(2), env = process.env) {
  const command = args[0];
  const request = createR2Request(env);

  if (command === 'acquire') {
    const namespaces = parseImageNamespaces(requiredFlag(args, '--namespace'));
    const leases = await acquireImageNamespaceLeases(namespaces, { request });
    process.stdout.write(`${serializeImageLeaseContext(leases)}\n`);
    return;
  }

  if (command === 'verify') {
    const namespace = requiredFlag(args, '--namespace');
    const context = requiredFlag(args, '--context');
    await verifyImageNamespaceLease(context, namespace, { request });
    return;
  }

  if (command === 'release') {
    const context = parseLeaseContext(requiredFlag(args, '--context'));
    const released = await releaseImageNamespaceLeases(context.leases, { request });
    const notReleased = context.leases.map(({ namespace }) => namespace).filter((namespace) => !released.includes(namespace));
    if (notReleased.length > 0) {
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
