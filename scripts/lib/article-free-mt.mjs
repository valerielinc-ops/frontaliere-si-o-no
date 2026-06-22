/**
 * Quota-free article translation helpers (2026-06-22).
 *
 * Article translation historically went through the generation LLM cascade
 * (callLLM), consuming ~60% of the per-article LLM calls — the daily free-tier
 * quota bottleneck that starves GENERATION. These helpers route translation
 * through the dedicated free MT cascade instead (the same `freeTranslateWithRetry`
 * the job crawlers + FAQ batch already use), so the LLM quota is reserved for
 * generation.
 *
 * Extracted into a lib module so the logic is unit-testable: scripts/create-article.mjs
 * runs `main()` on import, so its internals can't be imported directly.
 */

const NAV_LINK_RE = /\[[^\]]+\]\(nav:[^)]+\)/g;
const NAV_SENTINEL_RE = /0NAVLINK(\d+)0/g;

/**
 * Mask internal `[testo](nav:azione)` CTA links so machine translation passes
 * them through verbatim (the `nav:azione` target is a router action, not prose).
 *
 * The sentinel `0NAVLINK<n>0` is digit-delimited ASCII — MT engines reorder /
 * translate / strip bracketed or word-like placeholders, but leave this token
 * intact in practice. `restore()` reports `ok:false` if the restored count does
 * not match the masked count, letting the caller drop a mangled field rather
 * than ship a body with a broken internal link.
 *
 * @param {string} text
 * @returns {{ masked: string, expected: number, restore: (s: string) => { text: string, ok: boolean } }}
 */
export function maskNavLinks(text) {
  const store = [];
  const masked = String(text ?? '').replace(NAV_LINK_RE, (m) => {
    const token = `0NAVLINK${store.length}0`;
    store.push(m);
    return token;
  });
  const restore = (s) => {
    let n = 0;
    const out = String(s ?? '').replace(NAV_SENTINEL_RE, (_, i) => {
      const original = store[Number(i)];
      if (original === undefined) return '';
      n += 1;
      return original;
    });
    return { text: out, ok: n === store.length };
  };
  return { masked, expected: store.length, restore };
}

/**
 * Translate a single article text field via the injected free MT translator,
 * preserving internal nav-links. Returns '' on any failure (empty input, MT
 * error, empty output, or a mangled nav-link sentinel) so the caller's per-field
 * recovery (LLM retry → IT fallback) takes over — free MT can only IMPROVE
 * coverage, never produce broken output.
 *
 * @param {object} args
 * @param {string} args.text                source text
 * @param {string} args.sourceLang
 * @param {string} args.targetLang
 * @param {string} args.fieldType           'title' | 'description'
 * @param {(a: { text: string, sourceLang: string, targetLang: string, fieldType: string }) => Promise<string>} args.translate
 *        the MT call (freeTranslateWithRetry in prod, a stub in tests)
 * @param {(s: string) => string} [args.balanceMarkdown]  optional markdown repair
 * @param {(msg: string) => void} [args.onWarn]
 * @returns {Promise<string>}
 */
export async function translateFieldFreeMt({
  text,
  sourceLang,
  targetLang,
  fieldType,
  translate,
  balanceMarkdown = (s) => s,
  onWarn = () => {},
}) {
  const src = String(text ?? '').trim();
  if (!src) return '';
  const { masked, expected, restore } = maskNavLinks(src);
  let out;
  try {
    out = await translate({ text: masked, sourceLang, targetLang, fieldType });
  } catch (err) {
    onWarn(`free-MT ${targetLang}:${fieldType} failed (${err?.message || err})`);
    return '';
  }
  if (!out || !String(out).trim()) return '';
  let restored = String(out);
  if (expected > 0) {
    const r = restore(restored);
    if (!r.ok) {
      onWarn(`free-MT ${targetLang}:${fieldType} nav-link sentinel mangled (expected ${expected})`);
      return '';
    }
    restored = r.text;
  }
  return balanceMarkdown(restored);
}
