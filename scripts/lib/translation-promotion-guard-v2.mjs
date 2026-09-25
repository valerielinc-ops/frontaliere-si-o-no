/**
 * Fail-closed promotion boundary for the translation scheduler v2.
 *
 * Generation and state-ref checkpointing are useful observations, but neither
 * is permission to promote a translation into production.  This module keeps
 * that decision separate from the provider flag and gives a future publisher
 * an explicit, bounded rollback hook.  The hook receives a checkpoint only;
 * this module never resets, force-pushes, or otherwise mutates `main`.
 */

export const TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV = 'TRANSLATION_SCHEDULER_PUBLISH_ENABLED';
export const TRANSLATION_PROMOTION_GUARD_V2_SCHEMA_VERSION = 1;
export const MAX_TRANSLATION_PROMOTION_ROLLBACK_ATTEMPTS_V2 = 1;
export const TRANSLATION_PROMOTION_DISABLED_CODE_V2 = 'TRANSLATION_PROMOTION_DISABLED_V2';

const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes']);
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', '']);
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function freeze(value) {
  return Object.freeze(value);
}

function normalizeBooleanFlag(value, label) {
  if (typeof value === 'boolean') {
    return { enabled: value, rawValue: String(value), reason: value ? 'explicitly_enabled' : 'explicitly_disabled' };
  }
  if (typeof value === 'number') {
    if (value === 1) return { enabled: true, rawValue: '1', reason: 'explicitly_enabled' };
    if (value === 0) return { enabled: false, rawValue: '0', reason: 'explicitly_disabled' };
  }
  if (typeof value !== 'string') {
    return { enabled: false, rawValue: value === undefined ? null : String(value), reason: `${label}_invalid` };
  }
  const rawValue = value.trim().toLowerCase();
  if (ENABLED_VALUES.has(rawValue)) {
    return { enabled: true, rawValue, reason: 'explicitly_enabled' };
  }
  if (DISABLED_VALUES.has(rawValue)) {
    return { enabled: false, rawValue, reason: rawValue === '' ? 'default_off' : 'explicitly_disabled' };
  }
  return { enabled: false, rawValue, reason: `${label}_invalid` };
}

function readFlag(options) {
  const environment = options.env === undefined ? process.env : options.env;
  if (environment === null || typeof environment !== 'object') {
    return {
      enabled: false,
      rawValue: null,
      reason: 'environment_invalid',
      source: 'environment',
    };
  }
  if (Object.hasOwn(environment, TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV)) {
    return {
      ...normalizeBooleanFlag(
        environment[TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV],
        TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV,
      ),
      source: 'environment',
    };
  }
  const hasOverride = Object.hasOwn(options, 'publishEnabled') && options.publishEnabled !== undefined;
  if (hasOverride) {
    return { ...normalizeBooleanFlag(options.publishEnabled, 'publishEnabled'), source: 'option' };
  }
  return { enabled: false, rawValue: null, reason: 'default_off', source: 'default' };
}

/**
 * Resolve the publication decision without ever treating malformed input as
 * permission to publish.
 */
export function evaluateTranslationPromotionGuardV2(options = {}) {
  assertPlainObject(options, 'translation promotion guard options');
  const flag = readFlag(options);
  return freeze({
    schemaVersion: TRANSLATION_PROMOTION_GUARD_V2_SCHEMA_VERSION,
    variable: TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV,
    enabled: flag.enabled,
    rawValue: flag.rawValue,
    reason: flag.reason,
    source: flag.source,
  });
}

function validateCommit(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a 40- or 64-character commit sha`);
  }
  return value;
}

function validateCheckpoint(value) {
  assertPlainObject(value, 'translation promotion checkpoint');
  const mainCommit = validateCommit(value.mainCommit, 'translation promotion checkpoint mainCommit');
  const stateCommit = validateCommit(
    value.stateCommit ?? value.stateTip ?? null,
    'translation promotion checkpoint stateCommit',
    { nullable: true },
  );
  if (typeof value.stateRef !== 'string' || !REF_PATTERN.test(value.stateRef)
      || value.stateRef === 'refs/heads/main' || value.stateRef.includes('..')
      || value.stateRef.includes('//')) {
    throw new TypeError('translation promotion checkpoint stateRef must be a dedicated branch ref');
  }
  if (typeof value.scopeKey !== 'string' || value.scopeKey.trim().length === 0
      || value.scopeKey.length > 256) {
    throw new TypeError('translation promotion checkpoint scopeKey is invalid');
  }
  return freeze({
    schemaVersion: TRANSLATION_PROMOTION_GUARD_V2_SCHEMA_VERSION,
    mainCommit,
    stateCommit,
    stateRef: value.stateRef,
    scopeKey: value.scopeKey,
  });
}

function errorSummary(error) {
  return freeze({
    name: typeof error?.name === 'string' && error.name.length > 0 ? error.name : 'Error',
    message: typeof error?.message === 'string' && error.message.length > 0
      ? error.message.slice(0, 512)
      : String(error).slice(0, 512),
  });
}

export class TranslationPromotionDisabledError extends Error {
  constructor(decision, phase = 'translation promotion') {
    super(`${phase} is disabled by ${TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV}`);
    this.name = 'TranslationPromotionDisabledError';
    this.code = TRANSLATION_PROMOTION_DISABLED_CODE_V2;
    this.decision = decision;
    this.phase = phase;
  }
}

/**
 * Create one immutable publication decision and one bounded rollback budget.
 * The configured rollback callback is intentionally caller-owned: a caller
 * must explicitly provide the action that restores its own publication layer.
 */
export function createTranslationPromotionGuardV2(options = {}) {
  assertPlainObject(options, 'translation promotion guard options');
  const decision = evaluateTranslationPromotionGuardV2(options);
  const maxRollbackAttempts = options.maxRollbackAttempts
    ?? MAX_TRANSLATION_PROMOTION_ROLLBACK_ATTEMPTS_V2;
  if (maxRollbackAttempts !== MAX_TRANSLATION_PROMOTION_ROLLBACK_ATTEMPTS_V2) {
    throw new TypeError('translation promotion rollback attempts must equal the bounded contract value of 1');
  }
  const configuredRollback = options.rollback ?? options.onRollback ?? null;
  if (configuredRollback !== null && typeof configuredRollback !== 'function') {
    throw new TypeError('translation promotion rollback must be a function');
  }

  let checkpoint = null;
  let rollbackAttempts = 0;
  let rollbackStatus = 'not_started';

  function assertEnabled(phase = 'translation promotion') {
    if (!decision.enabled) throw new TranslationPromotionDisabledError(decision, phase);
    return decision;
  }

  function captureCheckpoint(value) {
    assertEnabled('translation promotion checkpoint capture');
    const next = validateCheckpoint(value);
    if (checkpoint !== null) {
      if (checkpoint.mainCommit !== next.mainCommit
          || checkpoint.stateCommit !== next.stateCommit
          || checkpoint.stateRef !== next.stateRef
          || checkpoint.scopeKey !== next.scopeKey) {
        throw new TypeError('translation promotion checkpoint cannot be replaced');
      }
      return checkpoint;
    }
    checkpoint = next;
    return checkpoint;
  }

  async function rollbackToCheckpoint(rollbackAction = configuredRollback, context = {}) {
    if (!decision.enabled) {
      rollbackStatus = 'disabled';
      return freeze({
        status: rollbackStatus,
        attempts: rollbackAttempts,
        maxAttempts: maxRollbackAttempts,
        checkpoint,
        reason: decision.reason,
      });
    }
    if (checkpoint === null) {
      rollbackStatus = 'unavailable';
      return freeze({
        status: rollbackStatus,
        attempts: rollbackAttempts,
        maxAttempts: maxRollbackAttempts,
        checkpoint: null,
        reason: 'checkpoint_not_captured',
      });
    }
    if (rollbackAttempts >= maxRollbackAttempts) {
      rollbackStatus = 'bounded';
      return freeze({
        status: rollbackStatus,
        attempts: rollbackAttempts,
        maxAttempts: maxRollbackAttempts,
        checkpoint,
        reason: 'rollback_attempt_budget_exhausted',
      });
    }
    if (typeof rollbackAction !== 'function') {
      rollbackStatus = 'not_configured';
      return freeze({
        status: rollbackStatus,
        attempts: rollbackAttempts,
        maxAttempts: maxRollbackAttempts,
        checkpoint,
        reason: 'explicit_rollback_callback_required',
      });
    }

    rollbackAttempts += 1;
    try {
      const result = await rollbackAction(checkpoint, freeze({
        attempt: rollbackAttempts,
        maxAttempts: maxRollbackAttempts,
        phase: typeof context.phase === 'string' ? context.phase : 'translation promotion',
        cause: context.cause === undefined ? null : errorSummary(context.cause),
      }));
      if (result === false || (result && typeof result === 'object' && result.ok === false)) {
        rollbackStatus = 'failed';
        return freeze({
          status: rollbackStatus,
          attempts: rollbackAttempts,
          maxAttempts: maxRollbackAttempts,
          checkpoint,
          reason: 'rollback_callback_rejected',
        });
      }
      rollbackStatus = 'rolled_back';
      return freeze({
        status: rollbackStatus,
        attempts: rollbackAttempts,
        maxAttempts: maxRollbackAttempts,
        checkpoint,
      });
    } catch (error) {
      rollbackStatus = 'failed';
      return freeze({
        status: rollbackStatus,
        attempts: rollbackAttempts,
        maxAttempts: maxRollbackAttempts,
        checkpoint,
        error: errorSummary(error),
      });
    }
  }

  function snapshot() {
    return freeze({
      decision,
      checkpoint,
      rollback: freeze({
        status: rollbackStatus,
        attempts: rollbackAttempts,
        maxAttempts: maxRollbackAttempts,
      }),
    });
  }

  return Object.freeze({
    decision,
    enabled: decision.enabled,
    assertEnabled,
    captureCheckpoint,
    get checkpoint() {
      return checkpoint;
    },
    rollbackToCheckpoint,
    rollback: rollbackToCheckpoint,
    snapshot,
  });
}

export function summarizeTranslationPromotionErrorV2(error) {
  return errorSummary(error);
}
