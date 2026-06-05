/**
 * Single source of truth for the regexes that EXTRACT the content-hashed SPA
 * entry-bundle filenames out of the built `dist/index.html`.
 *
 * Vite emits the root shell with quoted attributes:
 *   <script ... src="/assets/index-{hash}.js">                         (same-origin)
 *   <script ... src="https://cdn.frontaliereticino.ch/assets/index-…js"> (ASSET_CDN)
 *
 * The `[^"]*` before `/assets/` tolerates an optional origin prefix so the
 * match works whether Vite emitted a same-origin path or an absolute CDN URL
 * (vite.config experimental.renderBuiltUrl, gated on ASSET_CDN). The capture
 * group is always the BARE hashed filename (`index-{hash}.js` / `.css`, no
 * `/assets/` prefix) so callers can re-prefix it onto a CDN base if needed.
 * Without this tolerance an ASSET_CDN build makes both regexes miss.
 *
 * Why a shared module: this exact pair used to be copy-pasted in
 * `spaBundleResolver.ts` and `seoPageShell.ts`. Drift between the two copies
 * is precisely the "stesso anti-pattern nel file gemello" class the reviewer
 * keeps flagging (e.g. PR #1297) — keeping one definition makes that drift
 * impossible. Edit the pattern HERE and both consumers move together.
 *
 * NOTE (intentional scope): this is the quote-STRICT *extract* form, matched to
 * the un-minified root `dist/index.html` that both consumers read. It is NOT
 * the same shape as the quote-FLEXIBLE *detection* regex `SPA_BUNDLE_RX` in
 * `scripts/audit-spa-bundle-injection.mjs` (which scans per-page minified HTML
 * where `removeAttributeQuotes` may have stripped quotes), nor the *rewrite*
 * regex in `asyncCssPlugin.ts`. Those are different jobs and stay separate.
 *
 * The hash CHARACTER CLASS (`[A-Za-z0-9_-]`, base64url) is shared with the
 * generic CDN-janitor matcher via `./viteAssetHashRx` so the two can't drift
 * (AGENTS.md #6). Only the alphabet is shared; the SPA-`index`-specific shape
 * (quoted-attr extract, `index-` prefix, no fixed length) stays local here.
 */
import { VITE_HASH_CHARS } from './viteAssetHashRx';

const H = `[${VITE_HASH_CHARS}]`;
export const SPA_ENTRY_JS_RX = new RegExp(`src="[^"]*\\/assets\\/(index-${H}+\\.js)"`);
export const SPA_ENTRY_CSS_RX = new RegExp(`href="[^"]*\\/assets\\/(index-${H}+\\.css)"`);
