import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeOperation, nativeOperationRemainingMs, disposeNativeOperation } from '../functions/src/lib/assistedApplicationNativeOperation.js';
import { verifyNativeApplicationProof } from '../functions/src/assistedApplicationNativeProof.js';
afterEach(() => { vi.useRealTimers(); });

describe('one private HTTP lifetime for native owner verification', () => {
  it('shares source-read time with the model and preserves a final five-second reserve', () => {
    let now = 1000;
    const operation = createNativeOperation({ now: () => now });
    try {
      expect(operation.deadlineAt).toBe(121000);
      now += 40_000;
      expect(nativeOperationRemainingMs(operation, 5000)).toBe(75_000);
      expect(nativeOperationRemainingMs({ ...operation, deadlineAt: now + 999999 })).toBe(0);
      now += 80_001;
      expect(nativeOperationRemainingMs(operation)).toBe(0);
    } finally { disposeNativeOperation(operation); }
  });
  it('does not extend its deadline when the clock moves backward', () => {
    let now = 1000;
    const operation = createNativeOperation({ now: () => now });
    try { now = 500; expect(nativeOperationRemainingMs(operation)).toBe(120000); }
    finally { disposeNativeOperation(operation); }
  });
  it('propagates a real disconnection signal and denies later authorization', () => {
    const controller = new AbortController();
    const operation = createNativeOperation({ signal: controller.signal });
    try { controller.abort(new Error('synthetic_disconnection')); expect(operation.signal.aborted).toBe(true); expect(nativeOperationRemainingMs(operation)).toBe(0); }
    finally { disposeNativeOperation(operation); }
  });
  it('aborts the operation at its single entry deadline', () => {
    vi.useFakeTimers();
    const operation = createNativeOperation();
    try { vi.advanceTimersByTime(120000); expect(operation.signal.aborted).toBe(true); expect(nativeOperationRemainingMs(operation)).toBe(0); }
    finally { disposeNativeOperation(operation); }
  });
  it('disposes the timer and private authority without aborting an already observed outcome', () => {
    const operation = createNativeOperation(); disposeNativeOperation(operation);
    expect(nativeOperationRemainingMs(operation)).toBe(0);
    expect(operation.signal.aborted).toBe(false);
  });
  it.each([0, -1, NaN, Infinity, 0.5])('does not start a model or source verification with exhausted/invalid budget %s', async budgetMs => {
    const generate = vi.fn();
    expect(await verifyNativeApplicationProof({ proof: null, context: null, budgetMs, generate })).toMatchObject({ status: 'unverified', verification: { failure: 'proof_deadline' } });
    expect(generate).not.toHaveBeenCalled();
  });
});
