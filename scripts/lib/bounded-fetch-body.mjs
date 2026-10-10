/**
 * Fetch a URL and read its body under ONE hard deadline.
 *
 * An AbortController whose timer is cleared once `fetch()` resolves covers
 * only the headers: the caller's later `await res.text()` has no deadline, and
 * a server that sends headers and then stalls the body holds the caller until
 * the job timeout. That hung an article run for 2h42m (hotfix 7ba2e5a, #4118)
 * and blocked the concurrency-1 publishing chain. Here the fetch and the body
 * read race one timer; at the deadline the request is aborted, the body is
 * cancelled, and the call rejects even if `fetchImpl` ignores the signal.
 *
 * Returns `{ response, body }`. The body is read (as text, or parsed JSON with
 * `as: 'json'`) only when `response.ok === true`; otherwise `body` is null.
 * Rejects on network errors, invalid JSON and the deadline.
 *
 * Dependency-free (no Node-only APIs) so CI scripts can use it before
 * `npm ci`.
 */

export const FETCH_BODY_CANCEL_TIMEOUT_MS = 1_000;

async function boundedCancel(cancel) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(cancel),
      new Promise((resolve) => {
        timer = setTimeout(resolve, FETCH_BODY_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // The deadline verdict stays authoritative even if cleanup rejects.
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBodyWithDeadline(fetchImpl, url, init, timeoutMs, { as = 'text' } = {}) {
  const controller = new AbortController();
  let response;
  let reader;
  let timer;

  const readBody = async () => {
    const stream = response.body;
    if (!stream || typeof stream.getReader !== 'function') {
      return as === 'json' ? response.json() : response.text();
    }
    // Own the reader so the deadline can cancel a body that is mid-read.
    reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      try { reader.releaseLock(); } catch { /* cancelled mid-read */ }
    }
    text += decoder.decode();
    return as === 'json' ? JSON.parse(text) : text;
  };

  const work = (async () => {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = response?.ok === true ? await readBody() : null;
    return { response, body };
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`fetch deadline ${timeoutMs}ms exceeded`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    work.catch(() => {});
    await boundedCancel(() => (reader ? reader.cancel() : response?.body?.cancel?.()));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
