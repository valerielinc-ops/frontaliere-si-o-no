/**
 * adFilterSafeChunkName — neutralise ad-blocker FILTER-TRIGGER substrings in a
 * stable chunk basename so the emitted `/assets/<name>.js` URL cannot match an
 * EasyList / EasyPrivacy / AdGuard / uBlock network rule.
 *
 * Why (issue #2971): every JS chunk filename is STABLE / non-hashed (see
 * vite.config `rollupOptions.output` rationale). A first-party chunk whose name
 * carries a tracker keyword — `vendor-firebase-firestore.js`, `analytics.js` —
 * is a PERMANENT ad-filter magnet for aggressive mobile content blockers
 * (AdGuard for Safari, Brave, 1Blocker) and custom/regional lists. When such a
 * chunk is network-blocked OR served as an empty surrogate, any OTHER chunk
 * that statically imports a binding from it fails to LINK and the ES module
 * loader throws, per engine:
 *   - WebKit / Safari: `SyntaxError: Importing binding name 's' is not found.`
 *   - V8 / Chrome:     `does not provide an export named '…'`
 * → a white-screen routed to the React ErrorBoundary. The reload self-heal
 * (recoverFromStaleChunk / `_swReloadCount`) CANNOT fix it: an ad blocker
 * re-blocks the same chunk on reload, so after the one-reload guard the dead
 * crash page returns. Reproduced live in WebKit by surrogating
 * `vendor-firebase-*.js` → the exact `Importing binding name …` SyntaxError.
 *
 * Fix: rewrite the trigger substring to a neutral, collision-free alias so the
 * chunk is invisible to those filters. Rollup rewrites every internal import
 * reference to the emitted filename, so the rename is self-consistent; the
 * mapping is a pure deterministic 1:1 substring swap, so filenames stay STABLE
 * across deploys (the non-hashed-name caching invariant is preserved). It is a
 * no-op for every chunk name without a trigger word.
 *
 * The replacement tokens are asserted non-matching against EasyList,
 * EasyPrivacy, AdGuard Base/Tracking/Mobile, uBlock privacy/filters/badware and
 * Peter Lowe's list in tests/build-plugins/adFilterSafeChunkName.test.ts.
 *
 * The map covers only trigger words that ACTUALLY occur in this repo's
 * first-party chunk/module names — `firebase` (vendor-firebase-* vendor chunks),
 * `analytics` (services/analytics*.ts dynamic chunks) and `recaptcha`
 * (services/recaptchaService.ts). Tracker keywords that are exclusively
 * THIRD-PARTY script names (adsbygoogle, gtag, doubleclick, …) can never be a
 * Rollup chunk name, so rewriting them would be dead code — left out on purpose.
 *
 * Kept as a tiny pure module with ZERO imports: it is loaded by vite.config
 * (the config graph forbids `@/` value imports — must resolve relatively).
 */
const AD_FILTER_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/firebase/gi, 'fdb'],
  [/analytics/gi, 'mx'],
  [/recaptcha/gi, 'rcp'],
];

export function adFilterSafeChunkName(name: string): string {
  let out = name;
  for (const [rx, to] of AD_FILTER_REWRITES) out = out.replace(rx, to);
  return out;
}
