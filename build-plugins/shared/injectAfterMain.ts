/**
 * injectAfterMain.ts — shared, pure HTML block injector for post-build
 * link-graph plugins.
 *
 * Several SEO link-injector plugins (AE-3 profession landings, per-canton
 * profession landings, …) all need the identical operation: splice a
 * contextual `<aside>`/`<ul>` block into an already-emitted static page so the
 * BFS-from-`/` link graph reaches a family of otherwise-orphan landings. The
 * insertion logic — find `<main …>`, fall back to `</main>` then `</body>`,
 * idempotent on a per-plugin marker — was duplicated verbatim. Extracted here
 * so the behaviour cannot drift between callers (CLAUDE.md regola #6).
 *
 * Pure (no I/O): the caller reads the file, calls this, and writes the result
 * only when `outcome === 'inserted'`. The `marker` makes idempotency explicit
 * per caller, so two different injectors can target the same page without
 * clobbering each other.
 */

export type InjectionOutcome = 'inserted' | 'duplicate' | 'no-anchor';

/**
 * Inserts `block` immediately after the opening `<main …>` tag in `html`.
 * Falls back to the position just before `</main>` and then `</body>` if
 * neither exists. Returns the original string when:
 *  - `marker` is already present in `html` (idempotent), OR
 *  - none of `<main>`, `</main>`, `</body>` are found (caller treats as failure).
 *
 * The `outcome` is `'inserted' | 'duplicate' | 'no-anchor'` so the caller can
 * hard-fail on `'no-anchor'` and silently no-op on `'duplicate'`.
 */
export function injectBlockAfterMain(
  html: string,
  block: string,
  marker: string,
): { html: string; outcome: InjectionOutcome } {
  if (html.includes(marker)) {
    return { html, outcome: 'duplicate' };
  }

  const mainOpen = html.match(/<main\b[^>]*>/);
  if (mainOpen && mainOpen.index !== undefined) {
    const insertAt = mainOpen.index + mainOpen[0].length;
    return {
      html: html.slice(0, insertAt) + block + html.slice(insertAt),
      outcome: 'inserted',
    };
  }
  if (html.includes('</main>')) {
    return {
      html: html.replace('</main>', `${block}</main>`),
      outcome: 'inserted',
    };
  }
  if (html.includes('</body>')) {
    return {
      html: html.replace('</body>', `${block}</body>`),
      outcome: 'inserted',
    };
  }
  return { html, outcome: 'no-anchor' };
}
