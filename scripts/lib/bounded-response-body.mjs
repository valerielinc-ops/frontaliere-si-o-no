/**
 * Read a fetch Response body without ever buffering more than `maxBytes`.
 *
 * A Content-Length pre-check followed by `await response.text()` or
 * `arrayBuffer()` is not a cap: a chunked response (no Content-Length) or a
 * lying length is downloaded in full before its size is ever compared, so the
 * limit only decides what happens to bytes that are already in memory. This
 * is the class closed for event images in #9729 (ported from the corpus,
 * nanakokyobashi-rgb/frontaliere-articles#1770): the cap is applied while the
 * stream is consumed, and the body is cancelled on every oversize path.
 *
 * Returns the bytes (an empty array when the response has no body), or `null`
 * when the declared or streamed size exceeds `maxBytes`. A read error is
 * rethrown after the body is cancelled. Cancelling and releasing the reader
 * lock are cleanup: they are time-bounded and never replace the verdict.
 *
 * Dependency-free (no Node-only APIs) so CI scripts can use it before
 * `npm ci`.
 */

export const RESPONSE_BODY_CANCEL_TIMEOUT_MS = 1_000;

async function boundedCleanup(cleanup) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise((resolve) => {
        timer = setTimeout(resolve, RESPONSE_BODY_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // The size verdict stays authoritative even if cleanup rejects.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readBoundedResponseBytes(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('invalid_response_byte_limit');
  }
  const rawLength = response?.headers?.get?.('content-length');
  const declared = rawLength === null || rawLength === undefined ? NaN : Number(rawLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await boundedCleanup(() => response.body?.cancel?.('response exceeds byte limit'));
    return null;
  }

  const body = response?.body;
  if (body === null || body === undefined) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ArrayBuffer.isView(value)) throw new TypeError('response_chunk_not_bytes');
      if (value.byteLength > maxBytes - size) {
        await boundedCleanup(() => reader.cancel('response exceeds byte limit'));
        return null;
      }
      if (value.byteLength === 0) continue;
      chunks.push(value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      size += value.byteLength;
    }
  } catch (error) {
    await boundedCleanup(() => reader.cancel());
    throw error;
  } finally {
    // Older WHATWG streams and polyfilled bodies throw from releaseLock()
    // (pending read, stream left mid-cancel by the bounded cleanup above);
    // thrown from here it would replace the verdict already reached.
    try { reader.releaseLock(); } catch { /* the read verdict stays authoritative */ }
  }

  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
