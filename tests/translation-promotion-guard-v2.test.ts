import { describe, expect, it } from 'vitest';
import {
  createTranslationPromotionGuardV2,
  evaluateTranslationPromotionGuardV2,
  TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV,
} from '../scripts/lib/translation-promotion-guard-v2.mjs';

const checkpoint = {
  mainCommit: 'a'.repeat(40),
  stateCommit: 'b'.repeat(40),
  stateRef: 'refs/heads/translation-state-v2',
  scopeKey: 'translation-shadow-v2',
};

describe('translation promotion guard v2', () => {
  it('defaults publication to off and treats malformed values as disabled', () => {
    expect(evaluateTranslationPromotionGuardV2({ env: {} })).toMatchObject({
      enabled: false,
      reason: 'default_off',
      source: 'default',
    });
    expect(evaluateTranslationPromotionGuardV2({
      env: { [TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV]: '0' },
    }).enabled).toBe(false);
    expect(evaluateTranslationPromotionGuardV2({
      env: { [TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV]: 'maybe' },
    })).toMatchObject({ enabled: false, reason: 'TRANSLATION_SCHEDULER_PUBLISH_ENABLED_invalid' });
    expect(evaluateTranslationPromotionGuardV2({
      env: { [TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV]: '1' },
    }).enabled).toBe(true);
  });

  it('captures the prior checkpoint and permits one explicit rollback only', async () => {
    const calls: any[] = [];
    const guard = createTranslationPromotionGuardV2({
      env: { [TRANSLATION_SCHEDULER_PUBLISH_ENABLED_ENV]: '1' },
      rollback: async (captured: any, context: any) => {
        calls.push({ captured, context });
        return true;
      },
    });

    const captured = guard.captureCheckpoint(checkpoint);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(guard.checkpoint).toEqual(captured);

    const first = await guard.rollback(undefined, { phase: 'publish', cause: new Error('publish failed') });
    const second = await guard.rollback(undefined, { phase: 'publish' });

    expect(first).toMatchObject({ status: 'rolled_back', attempts: 1, maxAttempts: 1 });
    expect(second).toMatchObject({ status: 'bounded', attempts: 1, maxAttempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      captured: checkpoint,
      context: {
        attempt: 1,
        maxAttempts: 1,
        phase: 'publish',
        cause: { message: 'publish failed' },
      },
    });
  });

  it('does not expose a rollback action while the kill-switch is off', async () => {
    const calls: any[] = [];
    const guard = createTranslationPromotionGuardV2({
      env: {},
      rollback: async () => calls.push('unexpected'),
    });

    expect(() => guard.assertEnabled()).toThrow(/disabled/);
    const result = await guard.rollback();

    expect(result).toMatchObject({ status: 'disabled', attempts: 0, maxAttempts: 1 });
    expect(calls).toEqual([]);
  });
});
