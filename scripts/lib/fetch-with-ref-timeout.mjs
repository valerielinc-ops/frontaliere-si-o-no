/**
 * Fetch with a referenced timeout that covers both response headers and body
 * consumption.
 *
 * `AbortSignal.timeout()` uses an unref'd timer, and an abort signal is only a
 * cancellation hint: a provider can leave either `fetch()` or
 * `response.json()`/`response.text()` pending forever after the deadline.
 * Keep a referenced timer and race both phases against an explicit rejection;
 * the abort remains the best-effort transport cancellation.
 */

const BODY_METHODS = new Set(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
const ACTIVE_DEADLINES = new WeakMap();
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

function withBodyDeadline(response, cleanup, timeoutPromise) {
  let wrappedResponse;
  const trackedCleanup = () => {
    cleanup();
    if (wrappedResponse) ACTIVE_DEADLINES.delete(wrappedResponse);
  };
  wrappedResponse = new Proxy(response, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (BODY_METHODS.has(property)) {
        // Defer invocation so a synchronous brand/type error still reaches
        // finally(cleanup), rather than leaking the referenced timer.
        return (...args) => Promise.race([
          Promise.resolve().then(() => value.apply(target, args)),
          timeoutPromise,
        ]).finally(trackedCleanup);
      }
      // Response methods such as clone() are brand-checked too. Bind them to
      // the real Response while leaving body readers under the deadline above.
      return value.bind(target);
    },
  });
  ACTIVE_DEADLINES.set(wrappedResponse, { response, cleanup: trackedCleanup });
  return wrappedResponse;
}

function cancelBodyBestEffort(response) {
  try {
    const body = response?.body;
    if (typeof body?.cancel === 'function') {
      Promise.resolve(body.cancel()).catch(() => {});
    }
  } catch {
    // A body may be a minimal fetch double or expose a throwing cancel().
  }
}

/**
 * Release a response whose caller deliberately does not consume its body.
 *
 * Status-only branches must use this instead of returning/throwing with the
 * proxy still live: otherwise the referenced deadline and upstream listener
 * stay installed until the timeout. Body cancellation is best-effort because
 * cleanup must still happen for test doubles and unusual Response bodies.
 *
 * @param {Response} response
 */
export function releaseFetchWithRefTimeout(response) {
  const deadline = ACTIVE_DEADLINES.get(response);
  if (!deadline) return;
  ACTIVE_DEADLINES.delete(response);
  try {
    cancelBodyBestEffort(deadline.response);
  } finally {
    deadline.cleanup();
  }
}

/**
 * @param {string|URL} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Response>}
 */
export async function fetchWithRefTimeout(
  url,
  options = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
) {
  const { signal: upstreamSignal, ...requestOptions } = options;
  const controller = new AbortController();
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs))
    : DEFAULT_FETCH_TIMEOUT_MS;
  let cleaned = false;
  let timeoutReject;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject;
  });
  // The deadline may fire before a caller starts reading the body. Keep the
  // deferred rejection handled in that case; body readers race this same
  // promise when they are invoked.
  timeoutPromise.catch(() => {});
  let responseForCancellation;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const reason = new DOMException('The operation timed out', 'TimeoutError');
    controller.abort(reason);
    timeoutReject(reason);
    cancelBodyBestEffort(responseForCancellation);
  }, effectiveTimeoutMs);
  const forwardAbort = () => controller.abort(upstreamSignal.reason);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', forwardAbort);
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      forwardAbort();
    } else {
      upstreamSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  try {
    const fetchPromise = Promise.resolve().then(
      () => fetchImpl(url, { ...requestOptions, signal: controller.signal }),
    );
    // Abort is only a hint. If a fetch implementation ignores it and returns
    // a Response after the caller has already timed out, release that late
    // response body as well instead of leaking its transport resources.
    fetchPromise.then((response) => {
      if (timedOut) cancelBodyBestEffort(response);
    }, () => {});
    const response = await Promise.race([
      fetchPromise,
      timeoutPromise,
    ]);
    responseForCancellation = response;
    // HEAD/204-style responses have no body to protect; ordinary responses
    // release the timer only after json/text/etc. has finished below.
    if (response.body === null) {
      cleanup();
      return response;
    }
    return withBodyDeadline(response, cleanup, timeoutPromise);
  } catch (error) {
    cleanup();
    throw error;
  }
}
