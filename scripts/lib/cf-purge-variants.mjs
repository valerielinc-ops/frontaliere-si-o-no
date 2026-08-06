/**
 * cf-purge-variants — one definition of "purge THIS url, in every cache variant
 * the edge actually keeps for it".
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────
 * `cdn.frontaliereticino.ch` answers with `Vary: Origin`. The edge therefore
 * stores TWO entries per URL:
 *
 *   · the one a header-less request creates — curl, CI probes, our own gates;
 *   · the one a cross-origin `fetch`/module `<script>` from the SPA creates,
 *     which is the ONLY one a real browser ever reads.
 *
 * Cloudflare's `files: ['<url>']` purge matches the first. The browser's entry
 * survives, for as long as its own `Cache-Control` allows.
 *
 * Measured on this zone 2026-08-06, same URL one minute apart:
 *
 *     files: ['…/assets/App.js']                → Origin variant stayed HIT, age climbed 20→28
 *     files: [{url, headers:{Origin: <site>}}]  → Origin variant went MISS
 *
 * ── WHY IT MATTERS ────────────────────────────────────────────────────────
 * Every targeted purge in this repo runs right after re-uploading bytes to the
 * SAME url (bundle filenames here are stable, never content-hashed —
 * tests/stable-asset-names.test.ts). Purging only the header-less variant means
 * CI verifies a file that users are not being served: `/assets/App.js` measured
 * 2026-08-06 was 06:23 for curl and 20:48 the previous day for the browser. An
 * /aziende/<slug>/ page shipped with a hydration island the served JS knew
 * nothing about, and the CTA sat dead for 19h behind a green pipeline (#5012).
 *
 * ── WHY A SHARED MODULE ───────────────────────────────────────────────────
 * Two independent targeted-purge implementations exist (cf-purge-cache.mjs's
 * `--files=` mode and publish-article-chunks.mjs's `purgeCdnFiles`) and BOTH had
 * the defect. AGENTS.md #6: the construct lives once.
 */

/**
 * Origins whose `Vary: Origin` variant must be purged alongside the header-less
 * one. Only the site's own origin sends `Origin` to the CDN host; extra
 * front-end hosts can be added via CF_PURGE_ORIGINS (comma-separated).
 */
export const VARY_ORIGINS = (process.env.CF_PURGE_ORIGINS || 'https://frontaliereticino.ch')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Purge bodies for `urls`, one per cache variant.
 *
 * Separate bodies (⇒ separate POSTs) rather than one doubled `files` list on
 * purpose: the free-plan cap is counted in list entries, and doubling the list
 * would silently halve how many URLs a caller may pass. This way
 * MAX_TARGETED_FILES keeps meaning "URLs".
 *
 * @param {string[]} urls
 * @returns {Array<{ label: string, files: Array<string | { url: string, headers: Record<string,string> }> }>}
 */
export function purgeBodiesForUrls(urls) {
  return [
    { label: 'no Origin (CI/curl variant)', files: urls },
    ...VARY_ORIGINS.map((origin) => ({
      label: `Origin: ${origin} (browser variant)`,
      files: urls.map((url) => ({ url, headers: { Origin: origin } })),
    })),
  ];
}
