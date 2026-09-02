import {
  lookupTranslationMemoryV2,
  recordTranslationCandidateV2,
  serializeTranslationMemoryV2,
  validateTranslationMemoryV2,
} from './content-addressed-translation-memory-v2.mjs';
import { assessTranslationCandidateQualityV2 } from './translation-candidate-quality-v2.mjs';
import {
  deepFreezeTranslationV2,
  digestTranslationDocumentV2,
  normalizeTranslationVersionV2,
  validateTranslationUnitIdentityV2,
} from './translation-unit-identity-v2.mjs';
import { normalizeTranslationText, sha256TranslationText } from './translation-unit-identity.mjs';
import { MessagePort, receiveMessageOnPort, Worker } from 'node:worker_threads';

export const TRANSLATION_CANDIDATE_EXECUTOR_V2_SCHEMA_VERSION = 2;

const INPUT_KEYS = ['currentScanDigest', 'engineVersion', 'gateVersion', 'identity', 'memory', 'provider', 'providerTimeoutMs', 'quality', 'scanDigest'];
const PROVIDER_KEYS = ['costClass', 'engineVersion', 'executionClass', 'exportName', 'moduleUrl', 'schemaVersion'];
const QUALITY_KEYS = ['field', 'protectedTokens', 'sourceLang', 'sourceText', 'targetLang'];
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_PROVIDER_OUTPUT_LENGTH = 120_000;
const MAX_PROVIDER_TIMEOUT_MS = 300_000;
const MAX_UNTRUSTED_SNAPSHOT_DEPTH = 64;
const MAX_UNTRUSTED_SNAPSHOT_NODES = 100_000;
const MAX_UNTRUSTED_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRUSTED_SNAPSHOT_ARRAY_LENGTH = 100_000;
const PROVIDER_PROTOCOL_SCHEMA_VERSION = 3;
const PROVIDER_WORKER_STARTUP_TIMEOUT_MS = 30_000;
const PROVIDER_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
});

function snapshotExactDataObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError(`${label} has an unsupported schema`);
  }
  const snapshot = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      throw new TypeError(`${label} must use data properties`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotProtectedTokens(value) {
  if (!Array.isArray(value)) throw new TypeError('protectedTokens must be a bounded array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 64) {
    throw new TypeError('protectedTokens must be a bounded array');
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== length + 1 || !Object.hasOwn(descriptors, 'length')) {
    throw new TypeError('protectedTokens must be a bounded array');
  }
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('protectedTokens must be a bounded array');
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
      throw new TypeError('protectedTokens must be a bounded array');
    }
  }
  const tokens = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      throw new TypeError('protectedTokens must use data properties');
    }
    tokens.push(snapshotExactDataObject(descriptor.value, ['category', 'value'], 'protected token'));
  }
  return Object.freeze(tokens);
}

function snapshotUntrustedData(value, label) {
  const state = { bytes: 0, nodes: 0, ancestors: new WeakSet() };
  const addBytes = (count) => {
    state.bytes += count;
    if (state.bytes > MAX_UNTRUSTED_SNAPSHOT_BYTES) {
      throw new TypeError(`${label} exceeds snapshot bounds`);
    }
  };
  const clone = (current, depth) => {
    if (typeof current === 'string') {
      addBytes(Buffer.byteLength(current, 'utf8') + 2);
      return current;
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'number' || current === undefined) {
      addBytes(16);
      return current;
    }
    if (typeof current !== 'object' || depth > MAX_UNTRUSTED_SNAPSHOT_DEPTH) {
      throw new TypeError(`${label} exceeds snapshot bounds`);
    }
    state.nodes += 1;
    if (state.nodes > MAX_UNTRUSTED_SNAPSHOT_NODES || state.ancestors.has(current)) {
      throw new TypeError(`${label} exceeds snapshot bounds`);
    }
    state.ancestors.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (Array.isArray(current)) {
        const length = descriptors.length?.value;
        const remainingNodes = MAX_UNTRUSTED_SNAPSHOT_NODES - state.nodes;
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_UNTRUSTED_SNAPSHOT_ARRAY_LENGTH || length > remainingNodes) {
          throw new TypeError(`${label} exceeds snapshot bounds`);
        }
        if (ownKeys.length !== length + 1 || !Object.hasOwn(descriptors, 'length')) {
          throw new TypeError(`${label} has an unsupported schema`);
        }
        for (const key of ownKeys) {
          if (key === 'length') continue;
          if (typeof key !== 'string') throw new TypeError(`${label} has an unsupported schema`);
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
            throw new TypeError(`${label} has an unsupported schema`);
          }
        }
        const copy = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[index];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
            throw new TypeError(`${label} must use data properties`);
          }
          copy.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(copy);
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null
          || ownKeys.some((key) => typeof key !== 'string' || !descriptors[key].enumerable)) {
        throw new TypeError(`${label} has an unsupported schema`);
      }
      const copy = Object.create(null);
      for (const key of ownKeys) {
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
          throw new TypeError(`${label} must use data properties`);
        }
        addBytes(Buffer.byteLength(key, 'utf8') + 3);
        Object.defineProperty(copy, key, {
          value: clone(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
        });
      }
      return Object.freeze(copy);
    } finally {
      state.ancestors.delete(current);
    }
  };
  return clone(value, 0);
}

function fixedEvidence(code) {
  return Object.freeze([Object.freeze({
    code,
    digest: digestTranslationDocumentV2({ code, schemaVersion: TRANSLATION_CANDIDATE_EXECUTOR_V2_SCHEMA_VERSION }),
  })]);
}

function outcome({ status, attemptKey, candidate = null, memory, evidence, providerCalls, recorded }) {
  return deepFreezeTranslationV2({
    schemaVersion: TRANSLATION_CANDIDATE_EXECUTOR_V2_SCHEMA_VERSION,
    status,
    attemptKey,
    candidate,
    memory,
    evidence,
    metrics: { providerCalls, recorded },
  });
}

function validateQuality(input, identity) {
  const value = snapshotExactDataObject(input, QUALITY_KEYS, 'translation candidate executor v2 quality input');
  const quality = deepFreezeTranslationV2({
    field: value.field,
    protectedTokens: snapshotProtectedTokens(value.protectedTokens).map((token) => ({
      category: token.category,
      value: token.value,
    })),
    sourceLang: value.sourceLang,
    sourceText: value.sourceText,
    targetLang: value.targetLang,
  });
  // Reuse the public gate's exact schema and bounds before any provider call.
  assessTranslationCandidateQualityV2({ ...quality, candidateText: quality.sourceText });
  if (
    sha256TranslationText(quality.sourceText) !== identity.sourceHash
    || quality.sourceLang !== identity.sourceLocale
    || quality.targetLang !== identity.targetLocale
    || quality.field !== identity.fieldPath
  ) {
    throw new TypeError('translation candidate executor v2 quality does not match identity');
  }
  return quality;
}

function snapshotProvider(input, engineVersion) {
  const descriptors = snapshotExactDataObject(input, PROVIDER_KEYS, 'translation candidate executor v2 provider');
  const provider = deepFreezeTranslationV2({
    costClass: descriptors.costClass,
    engineVersion: descriptors.engineVersion,
    executionClass: descriptors.executionClass,
    exportName: descriptors.exportName,
    moduleUrl: descriptors.moduleUrl,
    schemaVersion: descriptors.schemaVersion,
  });
  if (provider.schemaVersion !== PROVIDER_PROTOCOL_SCHEMA_VERSION
      || provider.costClass !== 'zero'
      || provider.executionClass !== 'isolated_callback'
      || normalizeTranslationVersionV2(provider.engineVersion, 'provider engineVersion') !== engineVersion
      || typeof provider.moduleUrl !== 'string'
      || provider.moduleUrl.length === 0
      || typeof provider.exportName !== 'string'
      || provider.exportName.length === 0
      || provider.exportName.length > 256) {
    throw new TypeError('translation candidate executor v2 provider is invalid');
  }
  try {
    new URL(provider.moduleUrl);
  } catch {
    throw new TypeError('translation candidate executor v2 provider is invalid');
  }
  return provider;
}

function isProviderMessage(value, nonce) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !descriptors[key].enumerable
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].get || descriptors[key].set)) return false;
  if (descriptors.schemaVersion?.value !== PROVIDER_PROTOCOL_SCHEMA_VERSION
      || descriptors.nonce?.value !== nonce) return false;
  if (descriptors.type?.value === 'fail') {
    return keys.length === 3 && keys.includes('schemaVersion') && keys.includes('type') && keys.includes('nonce');
  }
  return descriptors.type?.value === 'succeed'
    && keys.length === 4
    && keys.includes('schemaVersion')
    && keys.includes('type')
    && keys.includes('text')
    && keys.includes('nonce')
    && typeof descriptors.text?.value === 'string';
}

function isBootstrapMessage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === 4
    && keys.every((key) => typeof key === 'string' && descriptors[key].enumerable
      && Object.hasOwn(descriptors[key], 'value') && !descriptors[key].get && !descriptors[key].set)
    && keys.includes('schemaVersion')
    && keys.includes('type')
    && keys.includes('port')
    && keys.includes('nonce')
    && descriptors.schemaVersion.value === PROVIDER_PROTOCOL_SCHEMA_VERSION
    && descriptors.type.value === 'bootstrap'
    && descriptors.port.value instanceof MessagePort
    && typeof descriptors.nonce.value === 'string'
    && /^[a-f0-9]{64}$/.test(descriptors.nonce.value);
}

function isAckMessage(value, nonce) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === 3
    && keys.every((key) => typeof key === 'string' && descriptors[key].enumerable
      && Object.hasOwn(descriptors[key], 'value') && !descriptors[key].get && !descriptors[key].set)
    && keys.includes('schemaVersion')
    && keys.includes('type')
    && keys.includes('nonce')
    && descriptors.schemaVersion.value === PROVIDER_PROTOCOL_SCHEMA_VERSION
    && descriptors.type.value === 'ack'
    && descriptors.nonce.value === nonce;
}

async function runIsolatedProvider(provider, request, timeoutMs) {
  let worker;
  try {
    worker = new Worker(new URL('./translation-candidate-provider-worker-v2.mjs', import.meta.url), {
      execArgv: ['--unhandled-rejections=strict'],
      resourceLimits: PROVIDER_WORKER_RESOURCE_LIMITS,
      workerData: { provider, request },
    });
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    let finishing = false;
    let resultPort = null;
    let bootstrapObserved = false;
    let nonce = null;
    let acknowledged = false;
    let bufferedResult = null;
    let exitDrainImmediate = null;
    let timeoutId = setTimeout(() => finish(null), PROVIDER_WORKER_STARTUP_TIMEOUT_MS);

    async function finish(candidateText) {
      if (finishing) return;
      finishing = true;
      clearTimeout(timeoutId);
      if (exitDrainImmediate) clearImmediate(exitDrainImmediate);
      if (resultPort) {
        resultPort.removeAllListeners();
        resultPort.close();
        resultPort = null;
      }
      try {
        await worker.terminate();
      } catch {
        candidateText = null;
      }
      resolve(candidateText);
    }

    function maybeFinish() {
      if (!acknowledged || !bufferedResult) return false;
      finish(bufferedResult.type === 'succeed' ? bufferedResult.text : null);
      return true;
    }

    function handleProviderResult(result) {
      if (!isProviderMessage(result, nonce) || bufferedResult) return;
      bufferedResult = result;
      maybeFinish();
    }

    function drainProviderResults() {
      if (!resultPort) return;
      while (resultPort) {
        const received = receiveMessageOnPort(resultPort);
        if (!received) break;
        handleProviderResult(received.message);
      }
    }

    worker.once('error', () => finish(null));
    worker.once('exit', () => {
      if (finishing) return;
      drainProviderResults();
      if (maybeFinish()) return;
      exitDrainImmediate = setImmediate(() => {
        exitDrainImmediate = null;
        drainProviderResults();
        if (!maybeFinish()) finish(null);
      });
    });
    worker.on('message', (message) => {
      if (finishing) return;
      if (resultPort) {
        if (isAckMessage(message, nonce)) {
          acknowledged = true;
          maybeFinish();
        }
        return;
      }
      if (bootstrapObserved) return;
      bootstrapObserved = true;
      if (!isBootstrapMessage(message)) {
        finish(null);
        return;
      }
      resultPort = message.port;
      nonce = message.nonce;
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => finish(null), timeoutMs);
      resultPort.once('messageerror', () => finish(null));
      resultPort.on('message', handleProviderResult);
      resultPort.start();
    });
  });
}

function validateInput(input) {
  const value = snapshotExactDataObject(input, INPUT_KEYS, 'translation candidate executor v2 input');
  if (!DIGEST_PATTERN.test(value.scanDigest ?? '') || !DIGEST_PATTERN.test(value.currentScanDigest ?? '')) {
    throw new TypeError('translation candidate executor v2 scan digest is invalid');
  }
  const identity = validateTranslationUnitIdentityV2(snapshotUntrustedData(value.identity, 'translation candidate executor v2 identity'));
  const memory = validateTranslationMemoryV2(snapshotUntrustedData(value.memory, 'translation candidate executor v2 memory'));
  const engineVersion = normalizeTranslationVersionV2(value.engineVersion, 'engineVersion');
  const gateVersion = normalizeTranslationVersionV2(value.gateVersion, 'gateVersion');
  if (!Number.isSafeInteger(value.providerTimeoutMs) || value.providerTimeoutMs < 1 || value.providerTimeoutMs > MAX_PROVIDER_TIMEOUT_MS) {
    throw new TypeError('translation candidate executor v2 providerTimeoutMs is invalid');
  }
  const provider = snapshotProvider(value.provider, engineVersion);
  const quality = validateQuality(value.quality, identity);
  return Object.freeze({
    currentScanDigest: value.currentScanDigest,
    engineVersion,
    gateVersion,
    identity,
    memory,
    provider,
    providerTimeoutMs: value.providerTimeoutMs,
    quality,
    scanDigest: value.scanDigest,
  });
}

/**
 * Executes exactly one dependency-injected, zero-cost translation attempt.
 * This module deliberately owns no persistence or production provider.
 */
export async function executeTranslationCandidateV2(input) {
  const value = validateInput(input);
  const lookup = lookupTranslationMemoryV2(value.memory, {
    identity: value.identity,
    engineVersion: value.engineVersion,
    gateVersion: value.gateVersion,
  });
  if (value.scanDigest !== value.currentScanDigest) {
    return outcome({
      status: 'stale_scan', attemptKey: lookup.attemptKey, memory: value.memory,
      evidence: fixedEvidence('stale_scan'), providerCalls: 0, recorded: false,
    });
  }
  if (lookup.status === 'exact_validated_hit') {
    return outcome({
      status: 'reused', attemptKey: lookup.attemptKey, candidate: lookup.applicableCandidates[0], memory: value.memory,
      evidence: fixedEvidence('reused'), providerCalls: 0, recorded: false,
    });
  }
  if (lookup.status === 'negative_cache') {
    return outcome({
      status: 'negative_cache', attemptKey: lookup.attemptKey, candidate: lookup.applicableCandidates[0], memory: value.memory,
      evidence: fixedEvidence('negative_cache'), providerCalls: 0, recorded: false,
    });
  }
  if (lookup.status === 'conflicting_candidates') {
    return outcome({
      status: 'conflict', attemptKey: lookup.attemptKey, memory: value.memory,
      evidence: fixedEvidence('conflict'), providerCalls: 0, recorded: false,
    });
  }
  const candidateText = await runIsolatedProvider(value.provider, value.quality, value.providerTimeoutMs);
  if (typeof candidateText !== 'string'
      || candidateText.trim().length === 0
      || candidateText.length > MAX_PROVIDER_OUTPUT_LENGTH) {
    return outcome({
      status: 'generation_failed', attemptKey: lookup.attemptKey, memory: value.memory,
      evidence: fixedEvidence('generation_failed'), providerCalls: 1, recorded: false,
    });
  }

  const quality = assessTranslationCandidateQualityV2({ ...value.quality, candidateText });
  if (quality.status === 'rejected' && quality.retryClass === 'retryable') {
    return outcome({
      status: 'retryable_reject', attemptKey: lookup.attemptKey, memory: value.memory,
      evidence: quality.evidence, providerCalls: 1, recorded: false,
    });
  }
  const outputHash = sha256TranslationText(normalizeTranslationText(candidateText));
  const existing = lookup.candidates.find((candidate) => candidate.outputHash === outputHash);
  if (existing) {
    return outcome({
      status: 'duplicate_attempt', attemptKey: lookup.attemptKey, candidate: existing, memory: value.memory,
      evidence: fixedEvidence('duplicate_attempt'), providerCalls: 1, recorded: false,
    });
  }
  const nextMemory = recordTranslationCandidateV2(value.memory, {
    identity: value.identity,
    engineVersion: value.engineVersion,
    gateVersion: value.gateVersion,
    outputText: candidateText,
    status: quality.status,
    evidence: quality.evidence,
  });
  const duplicate = serializeTranslationMemoryV2(nextMemory) === serializeTranslationMemoryV2(value.memory);
  const candidateId = `translation-candidate:v2:${digestTranslationDocumentV2({
    attemptKey: lookup.attemptKey,
    outputHash,
  })}`;
  const candidate = nextMemory.records
    .find((record) => record.identity.key === value.identity.key)
    ?.candidates.find((item) => item.candidateId === candidateId) ?? null;
  return outcome({
    status: duplicate ? 'duplicate_attempt' : quality.status === 'validated' ? 'validated' : 'rejected_candidate',
    attemptKey: lookup.attemptKey,
    candidate,
    memory: nextMemory,
    evidence: quality.evidence,
    providerCalls: 1,
    recorded: !duplicate,
  });
}
