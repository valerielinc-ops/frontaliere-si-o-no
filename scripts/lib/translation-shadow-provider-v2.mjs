import { freeTranslateWithRetryDetailed } from './free-translate.mjs';

function generationIsDisabled() {
  const value = String(process.env.TRANSLATION_SHADOW_ENABLE_GENERATION ?? '')
    .trim()
    .toLowerCase();
  return value === '0' || value === 'false' || value === 'off' || value === 'no';
}

/**
 * Production provider seam for the v2 shadow scheduler.
 *
 * The scheduler owns the deterministic cohort gate and only invokes this
 * provider for selected units. The callback protocol is intentionally
 * synchronous at the boundary: the isolated worker requires the provider to
 * return undefined after starting its asynchronous work.
 */
export function translate(request, { signal, succeedText, fail }) {
  if (signal.aborted) {
    fail();
    return;
  }

  // The runtime contract is fail-closed: a selected canary must not reach the
  // free translation cascade while generation is disabled.
  if (generationIsDisabled()) {
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
