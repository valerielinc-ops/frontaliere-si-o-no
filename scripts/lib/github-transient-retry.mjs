const MAX_TRANSIENT_GH_MUTATION_ATTEMPTS = 3;
const TRANSIENT_GH_MUTATION_RETRY_DELAYS_MS = Object.freeze([750, 2000]);
const TRANSIENT_GH_MUTATION_ERROR_RE = /(?:GraphQL:\s*Something went wrong|\b(?:HTTP\s*)?(?:429|50[23])\b|bad gateway|service unavailable|rate[- ]limit|abuse[- ]detection|timeout|timed?\s*out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up)/iu;

function sleepForGithubMutationRetry(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, delayMs);
}

function capturedGithubErrorOutput(error) {
  if (typeof error === 'string') return error;
  return [error?.message, error?.stderr, error?.stdout, error?.status]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))
    .filter(Boolean)
    .join('\n');
}

export function isTransientGithubMutationError(error) {
  return TRANSIENT_GH_MUTATION_ERROR_RE.test(capturedGithubErrorOutput(error));
}

/**
 * Retry a bounded GitHub operation only for known transient failures. A
 * caller can inspect the resource after a lost mutation response through
 * `findExisting`, avoiding a duplicate side effect before retrying.
 */
export function withTransientGithubMutationRetry(operation, {
  findExisting = () => null,
  attemptLimit = MAX_TRANSIENT_GH_MUTATION_ATTEMPTS,
  delaysMs = TRANSIENT_GH_MUTATION_RETRY_DELAYS_MS,
  sleep = sleepForGithubMutationRetry,
  onRetry = () => {},
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('GitHub mutation retry operation must be a function');
  if (typeof findExisting !== 'function') throw new TypeError('GitHub mutation existence lookup must be a function');
  const attempts = Number.isSafeInteger(attemptLimit) && attemptLimit > 0
    ? attemptLimit
    : MAX_TRANSIENT_GH_MUTATION_ATTEMPTS;
  const delays = Array.isArray(delaysMs) ? delaysMs : TRANSIENT_GH_MUTATION_RETRY_DELAYS_MS;
  const wait = typeof sleep === 'function' ? sleep : sleepForGithubMutationRetry;
  const notify = typeof onRetry === 'function' ? onRetry : () => {};

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return { reused: false, value: operation(), attempts: attempt + 1 };
    } catch (error) {
      if (attempt + 1 >= attempts || !isTransientGithubMutationError(error)) throw error;
      const existing = findExisting();
      if (existing) return { reused: true, value: existing, attempts: attempt + 1 };
      const delayMs = Number(delays[attempt]);
      notify(attempt + 2, attempts, delayMs);
      if (Number.isFinite(delayMs) && delayMs > 0) wait(delayMs);
    }
  }
  throw new Error('GitHub mutation retry exhausted without an attempt');
}
