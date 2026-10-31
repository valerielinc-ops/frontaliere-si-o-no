/** Private lifetime of one owner-native HTTP operation; never a semantic grant or DTO. */
export const NATIVE_OPERATION_BUDGET_MS = 120_000;
const operations = new WeakMap();

export function createNativeOperation({ signal = null, now = Date.now } = {}) {
  const startedAt = now();
  if (!Number.isFinite(startedAt) || startedAt <= 0) throw new Error('native_operation_clock_invalid');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || new Error('native_operation_aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('native_operation_deadline')), NATIVE_OPERATION_BUDGET_MS);
  timer.unref?.();
  const operation = Object.freeze({ startedAt, deadlineAt: startedAt + NATIVE_OPERATION_BUDGET_MS, signal: controller.signal });
  operations.set(operation, { now, timer, signal, abort });
  return operation;
}

export function nativeOperationRemainingMs(operation, reserveMs = 0) {
  const owned = operations.get(operation);
  if (!owned || operation.signal.aborted || !Number.isFinite(reserveMs) || reserveMs < 0) return 0;
  const current = owned.now();
  if (!Number.isFinite(current)) return 0;
  return Math.max(0, operation.deadlineAt - Math.max(operation.startedAt, current) - reserveMs);
}

export function disposeNativeOperation(operation) {
  const owned = operations.get(operation);
  if (!owned) return;
  clearTimeout(owned.timer);
  owned.signal?.removeEventListener('abort', owned.abort);
  operations.delete(operation);
}
