// Local Opus-MT translation — LOCAL inference, NO API keys / quota / rate limits.
//
// Runs Helsinki-NLP Opus-MT models via @huggingface/transformers (onnxruntime)
// directly on the runner — the SAME local-ML runtime already proven in prod for
// embeddings (scripts/lib/evidence/embeddingClient.mjs, multilingual-e5-small).
// This gives the translation cascade a free, deterministic, offline tier that
// does NOT depend on fragile public proxies / capped freemium keys, replacing
// the dead self-hosted LibreTranslate container with zero new heavy deps
// (@huggingface/transformers + onnxruntime-node are already in package.json).
//
// Coverage: the funnel's 12 directions over {it,en,de,fr}. Only the 6
// English-paired Opus-MT models are used directly; the 6 non-English pairs
// (it↔de, it↔fr, de↔fr) PIVOT through English (src→en→tgt) — the same strategy
// Argos uses — so we depend only on models that reliably ship ONNX weights on
// the Xenova mirror (Xenova/opus-mt-en-it, -it-en, -en-de, -de-en, -en-fr, -fr-en).
//
// Opt-in: only used by the cascade when MT_LOCAL_OPUSMT is truthy. The module
// fails CLOSED — any load/inference error returns '' so freeTranslate falls
// through to the next tier (never throws into the caller).
//
// Model weights download once from the public HuggingFace CDN (no key) and are
// cached under .cache/transformers (env.cacheDir; CI-cacheable like embeddings).

const LOCALES = new Set(['it', 'en', 'de', 'fr']);

// Per-direction lazy singletons. Value is a Promise resolving to a translator
// callable, or null if that model is permanently unavailable (so we don't retry
// a failing download on every chunk). Cleared by the test seam.
const _pipelines = new Map();
let _override = null;

/**
 * Test seam: inject a fake translator factory `(modelId) => async (text) => out`
 * so unit tests never download/run the real ONNX models. Pass null to reset.
 */
export function setLocalOpusMtForTests(fn) {
  _override = fn;
  _pipelines.clear();
}

/** Whether the cascade should attempt the local Opus-MT tier at all. */
export function localOpusMtEnabled() {
  const v = (process.env.MT_LOCAL_OPUSMT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function normalizeSpace(s) {
  return String(s ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split text into chunks that stay well under the Opus-MT ~512-token limit.
 * Prefers paragraph then sentence boundaries; hard-splits only as last resort.
 * ~600 chars (~200 tokens) leaves ample headroom for output expansion.
 */
function chunkForOpusMt(text, maxChars = 600) {
  const clean = normalizeSpace(text);
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const out = [];
  const flush = (s) => { const t = s.trim(); if (t) out.push(t); };

  for (const para of clean.split(/\n{2,}/)) {
    if (para.length <= maxChars) { flush(para); continue; }
    // Split long paragraph at sentence boundaries.
    let cur = '';
    for (const sent of para.split(/(?<=[.!?])\s+/)) {
      if (sent.length > maxChars) {
        // Pathological run with no sentence breaks: hard-split by words.
        flush(cur); cur = '';
        let w = '';
        for (const word of sent.split(/\s+/)) {
          if (w && (w.length + word.length + 1) > maxChars) { flush(w); w = word; }
          else w = w ? `${w} ${word}` : word;
        }
        flush(w);
      } else if (cur && (cur.length + sent.length + 1) > maxChars) {
        flush(cur); cur = sent;
      } else {
        cur = cur ? `${cur} ${sent}` : sent;
      }
    }
    flush(cur);
  }
  return out;
}

async function getTranslator(modelId) {
  if (_override) {
    if (!_pipelines.has(modelId)) _pipelines.set(modelId, Promise.resolve(_override(modelId)));
    return _pipelines.get(modelId);
  }
  if (!_pipelines.has(modelId)) {
    const load = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = process.env.TRANSFORMERS_CACHE || '.cache/transformers';
        // q8 (quantized) is ~4× smaller/faster on CPU with negligible quality
        // loss — translation has no committed-store consistency constraint (unlike
        // embeddings), so favour speed on the 2-core runner. Overridable.
        const dtype = (process.env.MT_LOCAL_OPUSMT_DTYPE || 'q8').trim();
        return await pipeline('translation', modelId, { dtype });
      } catch {
        return null; // mark permanently unavailable; cascade falls through
      }
    })();
    _pipelines.set(modelId, load);
  }
  return _pipelines.get(modelId);
}

/** Translate text through ONE direct Opus-MT model (chunked). '' on failure. */
async function runDirect(text, modelId) {
  const translator = await getTranslator(modelId);
  if (!translator) return '';
  const chunks = chunkForOpusMt(text);
  if (!chunks.length) return '';
  const parts = [];
  for (const chunk of chunks) {
    const res = await translator(chunk, { max_new_tokens: 512 });
    const piece = Array.isArray(res)
      ? (res[0]?.translation_text || '')
      : (res?.translation_text || '');
    if (!piece) return '';
    parts.push(normalizeSpace(piece));
  }
  return normalizeSpace(parts.join('\n\n'));
}

const modelId = (dir) => `Xenova/opus-mt-${dir}`;

/**
 * Translate `text` from `sourceLang` to `targetLang` using local Opus-MT.
 * Returns '' (never throws) when disabled, unsupported, on any model/inference
 * failure, or when the output is identical to the input (no real translation).
 *
 * @param {string} text
 * @param {'it'|'en'|'de'|'fr'} sourceLang
 * @param {'it'|'en'|'de'|'fr'} targetLang
 * @returns {Promise<string>}
 */
export async function translateWithLocalOpusMt(text, sourceLang, targetLang) {
  if (!localOpusMtEnabled()) return '';
  const clean = normalizeSpace(text);
  if (!clean) return '';
  if (sourceLang === targetLang) return '';
  if (!LOCALES.has(sourceLang) || !LOCALES.has(targetLang)) return '';

  try {
    let out;
    if (sourceLang === 'en' || targetLang === 'en') {
      // Direct English-paired model.
      out = await runDirect(clean, modelId(`${sourceLang}-${targetLang}`));
    } else {
      // Pivot through English (src→en→tgt) — only the 6 reliable EN-paired models.
      const viaEn = await runDirect(clean, modelId(`${sourceLang}-en`));
      out = viaEn ? await runDirect(viaEn, modelId(`en-${targetLang}`)) : '';
    }
    if (out && out.toLowerCase() !== clean.toLowerCase()) return out;
    return '';
  } catch {
    return '';
  }
}
