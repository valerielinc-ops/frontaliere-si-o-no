import { readBoundedResponseBytes } from '../../../lib/bounded-response-body.mjs';
import { DIAGNOSTIC_BODY_LIMIT, DIAGNOSTIC_BODY_READ_LIMIT, diagnosticLocation, hasBoundedBodyLength, responseErrors, settleDiagnostics } from './diagnostic-values.mjs';

export const FETCH_DIAGNOSTIC_BINDING = '__aaDiagnosticFetchError';
export const FETCH_DIAGNOSTIC_CONTROL = '__aaDiagnosticFetchControl';

/** Observe a clone: the portal receives its original Response unchanged. */
export function installFetchDiagnostics(target) {
  if (target[FETCH_DIAGNOSTIC_CONTROL] || typeof target.fetch !== 'function') return;
  const fetchOriginal = target.fetch;
  const pending = new Set();
  let reads = 0;
  let stopped = false;
  const inspect = async (response, method) => {
    if (stopped || reads >= DIAGNOSTIC_BODY_READ_LIMIT || !/json/i.test(response.headers.get('content-type') || '')) return;
    const location = diagnosticLocation(response.url);
    if (!location) return;
    // Known, bounded lengths are already covered by the Playwright observer.
    const length = response.headers.get('content-length');
    if (hasBoundedBodyLength(length)) return;
    reads += 1;
    const bytes = await readBoundedResponseBytes(response.clone(), DIAGNOSTIC_BODY_LIMIT);
    if (stopped) return;
    const errors = bytes && responseErrors(JSON.parse(new TextDecoder().decode(bytes)), response.status >= 400);
    if (errors?.length) await target[FETCH_DIAGNOSTIC_BINDING]({
      location, method, status: response.status, errors,
    });
  };
  target.fetch = function (...args) {
    const result = Reflect.apply(fetchOriginal, this, args);
    // Observe without replacing the original promise or changing its rejection.
    result.then((response) => {
      const method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
      const task = inspect(response, method).catch(() => {});
      pending.add(task);
      task.finally(() => pending.delete(task));
    }).catch(() => {});
    return result;
  };
  target[FETCH_DIAGNOSTIC_CONTROL] = {
    reset() { reads = 0; },
    async finish() {
      await settleDiagnostics(pending);
      stopped = true;
    },
  };
}
