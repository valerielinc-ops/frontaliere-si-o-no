/** Parse one JSON payload away from the browser's main thread. */

interface JsonParseSuccess {
  ok: true;
  value: unknown;
}

interface JsonParseFailure {
  ok: false;
  error: string;
}

type JsonParseResult = JsonParseSuccess | JsonParseFailure;

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const text = new TextDecoder().decode(event.data);
    const result: JsonParseResult = { ok: true, value: JSON.parse(text) };
    self.postMessage(result);
  } catch (error: unknown) {
    const result: JsonParseResult = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(result);
  }
};

export {};
