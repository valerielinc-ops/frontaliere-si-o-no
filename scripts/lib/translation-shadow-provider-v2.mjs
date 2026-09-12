import { freeTranslateWithRetryDetailed } from './free-translate.mjs';

/**
 * Production provider seam for the v2 shadow scheduler.
 *
 * The scheduler keeps generation disabled unless the operator explicitly
 * enables it. The callback protocol is intentionally synchronous at the
 * boundary: the isolated worker requires the provider to return undefined
 * after starting its asynchronous work.
 */
export function translate(request, { signal, succeedText, fail }) {
  if (signal.aborted || process.env.TRANSLATION_SHADOW_ENABLE_GENERATION !== '1') {
    fail();
    return;
  }

  void freeTranslateWithRetryDetailed({
    text: request.sourceText,
    sourceLang: request.sourceLang,
    targetLang: request.targetLang,
    fieldType: request.field,
    maxRetries: 0,
  }).then((result) => {
    if (signal.aborted || result?.passthrough || typeof result?.text !== 'string'
        || result.text.trim().length === 0) {
      if (!signal.aborted) fail();
      return;
    }
    succeedText(result.text);
  }).catch(() => {
    if (!signal.aborted) fail();
  });
}
