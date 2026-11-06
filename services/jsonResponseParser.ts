/**
 * Read and parse a JSON response without making a large payload's JSON.parse
 * block the UI thread. Small payloads stay synchronous to avoid worker startup
 * overhead; browsers without module workers keep the same correctness path.
 */

const OFF_THREAD_THRESHOLD_BYTES = 256 * 1024;

interface JsonParseWorkerResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

function parseLocally(buffer: ArrayBuffer): unknown {
  return JSON.parse(new TextDecoder().decode(buffer));
}

function parseInWorker(buffer: ArrayBuffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./jsonParseWorker.ts', import.meta.url), { type: 'module' });
    } catch (error: unknown) {
      reject(error);
      return;
    }

    const finish = (): void => worker.terminate();
    worker.onmessage = (event: MessageEvent<JsonParseWorkerResult>) => {
      finish();
      const result = event.data;
      if (result?.ok) {
        resolve(result.value);
      } else {
        reject(new Error(result?.error || 'JSON worker parse failed'));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      finish();
      reject(event.error instanceof Error ? event.error : new Error(event.message || 'JSON worker failed'));
    };

    // Keep the original buffer available for the local fallback if the worker
    // asset is blocked by a CSP or fails to load. The normal path still keeps
    // JSON.parse off the main thread; the duplicate exists only on failure.
    const transferable = buffer.slice(0);
    worker.postMessage(transferable, [transferable]);
  });
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < OFF_THREAD_THRESHOLD_BYTES || typeof Worker === 'undefined') {
    return parseLocally(buffer);
  }

  try {
    return await parseInWorker(buffer);
  } catch {
    return parseLocally(buffer);
  }
}
