import {
  lookupTranslationMemoryV2,
  recordTranslationCandidateV2,
  serializeTranslationMemoryV2,
  validateTranslationMemoryV2,
} from './content-addressed-translation-memory-v2.mjs';
import { assessTranslationCandidateQualityV2 } from './translation-candidate-quality-v2.mjs';
import {
  assertTranslationExactKeysV2,
  assertTranslationPlainObjectV2,
  deepFreezeTranslationV2,
  digestTranslationDocumentV2,
  normalizeTranslationVersionV2,
  validateTranslationUnitIdentityV2,
} from './translation-unit-identity-v2.mjs';
import { normalizeTranslationText, sha256TranslationText } from './translation-unit-identity.mjs';

export const TRANSLATION_CANDIDATE_EXECUTOR_V2_SCHEMA_VERSION = 2;

const INPUT_KEYS = ['currentScanDigest', 'engineVersion', 'gateVersion', 'identity', 'memory', 'provider', 'providerTimeoutMs', 'quality', 'scanDigest'];
const PROVIDER_KEYS = ['costClass', 'engineVersion', 'schemaVersion', 'translate'];
const QUALITY_KEYS = ['field', 'protectedTokens', 'sourceLang', 'sourceText', 'targetLang'];
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_PROVIDER_OUTPUT_LENGTH = 120_000;
const MAX_PROVIDER_TIMEOUT_MS = 300_000;

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
  assertTranslationPlainObjectV2(input, 'translation candidate executor v2 quality input');
  assertTranslationExactKeysV2(input, QUALITY_KEYS, 'translation candidate executor v2 quality input');
  const quality = deepFreezeTranslationV2(structuredClone(input));
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

function validateInput(input) {
  assertTranslationPlainObjectV2(input, 'translation candidate executor v2 input');
  assertTranslationExactKeysV2(input, INPUT_KEYS, 'translation candidate executor v2 input');
  if (!DIGEST_PATTERN.test(input.scanDigest ?? '') || !DIGEST_PATTERN.test(input.currentScanDigest ?? '')) {
    throw new TypeError('translation candidate executor v2 scan digest is invalid');
  }
  const identity = validateTranslationUnitIdentityV2(input.identity);
  const memory = validateTranslationMemoryV2(input.memory);
  const engineVersion = normalizeTranslationVersionV2(input.engineVersion, 'engineVersion');
  const gateVersion = normalizeTranslationVersionV2(input.gateVersion, 'gateVersion');
  if (!Number.isSafeInteger(input.providerTimeoutMs) || input.providerTimeoutMs < 1 || input.providerTimeoutMs > MAX_PROVIDER_TIMEOUT_MS) {
    throw new TypeError('translation candidate executor v2 providerTimeoutMs is invalid');
  }
  assertTranslationPlainObjectV2(input.provider, 'translation candidate executor v2 provider');
  assertTranslationExactKeysV2(input.provider, PROVIDER_KEYS, 'translation candidate executor v2 provider');
  if (input.provider.schemaVersion !== TRANSLATION_CANDIDATE_EXECUTOR_V2_SCHEMA_VERSION
      || input.provider.costClass !== 'zero'
      || normalizeTranslationVersionV2(input.provider.engineVersion, 'provider engineVersion') !== engineVersion
      || typeof input.provider.translate !== 'function') {
    throw new TypeError('translation candidate executor v2 provider is invalid');
  }
  const quality = validateQuality(input.quality, identity);
  return Object.freeze({
    currentScanDigest: input.currentScanDigest,
    engineVersion,
    gateVersion,
    identity,
    memory,
    provider: input.provider,
    providerTimeoutMs: input.providerTimeoutMs,
    quality,
    scanDigest: input.scanDigest,
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
  if (lookup.candidates.length > 0 && lookup.applicableCandidates.length === 0) {
    return outcome({
      status: 'duplicate_attempt', attemptKey: lookup.attemptKey, memory: value.memory,
      evidence: fixedEvidence('duplicate_attempt'), providerCalls: 0, recorded: false,
    });
  }

  let candidateText;
  const controller = new AbortController();
  let timeoutId;
  try {
    const timedOut = Symbol('provider timeout');
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve(timedOut);
      }, value.providerTimeoutMs);
    });
    // The request is a deep-frozen quality snapshot; the only second argument
    // is an AbortSignal, so provider code cannot mutate caller-owned data.
    candidateText = await Promise.race([
      Promise.resolve().then(() => value.provider.translate(value.quality, { signal: controller.signal })),
      timeout,
    ]);
    if (candidateText === timedOut) candidateText = null;
  } catch {
    candidateText = null;
  } finally {
    clearTimeout(timeoutId);
  }
  if (typeof candidateText !== 'string'
      || candidateText.trim().length === 0
      || candidateText.length > MAX_PROVIDER_OUTPUT_LENGTH) {
    return outcome({
      status: 'generation_failed', attemptKey: lookup.attemptKey, memory: value.memory,
      evidence: fixedEvidence('generation_failed'), providerCalls: 1, recorded: false,
    });
  }

  const quality = assessTranslationCandidateQualityV2({ ...value.quality, candidateText });
  const nextMemory = recordTranslationCandidateV2(value.memory, {
    identity: value.identity,
    engineVersion: value.engineVersion,
    gateVersion: value.gateVersion,
    outputText: candidateText,
    status: quality.status,
    evidence: quality.evidence,
  });
  const duplicate = serializeTranslationMemoryV2(nextMemory) === serializeTranslationMemoryV2(value.memory);
  const outputHash = sha256TranslationText(normalizeTranslationText(candidateText));
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
