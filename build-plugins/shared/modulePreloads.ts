/**
 * `<link rel="modulepreload">` tags for a static page's route chunks, without
 * repeating a chunk the head already preloads.
 *
 * staticPagesPlugin writes two lists into the same `<head>`: the core list
 * (vendor-react, it-core, it-calculator — every SPA-shell page) and the page
 * list (the route's component chunks plus its section's locale chunk). The two
 * overlapped: every `/calcola-stipendio/...` page shipped
 * `<link rel="modulepreload" href="/assets/it-calculator.js">` twice, because
 * the calculator section's locale chunk IS a core chunk. The browser dedupes
 * the request, so it costs no bytes on the wire — it is a duplicated hint in
 * the HTML of every calculator URL, and the same overlap would silently grow
 * with any new section whose chunk is also in the core list.
 *
 * Usage: every route-chunk modulepreload of the page list goes through here
 * (tests/build-plugins/modulePreloads.test.ts checks the plugin source).
 */

/**
 * Off: the hints name the stable `/assets/<chunk>` aliases, but the executable
 * graph is imported from `/assets/releases/<build>/`, a different URL. The
 * browser downloaded both copies: 162 kB wasted on every calculator load
 * (vendor-react, it-core, it-calculator, InputCard — live 31/10/2026). Static
 * HTML outlives a release, so it cannot name the release path; turn this back
 * on only if the hints ever resolve to the URL the entry actually imports.
 */
export const EMIT_CHUNK_MODULEPRELOADS = false;

export function routeModulePreloadTags(
  chunks: ReadonlyArray<string | null | undefined>,
  alreadyPreloaded: ReadonlySet<string>,
): string[] {
  const seen = new Set(alreadyPreloaded);
  const tags: string[] = [];
  for (const chunk of chunks) {
    if (!chunk || seen.has(chunk)) continue;
    seen.add(chunk);
    tags.push(`<link rel="modulepreload" href="/assets/${chunk}">`);
  }
  return tags;
}
