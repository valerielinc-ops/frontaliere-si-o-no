/**
 * TypeScript shim for the Vite content-hash char class / asset regex.
 *
 * The runtime definition lives in `./viteAssetHashRx.mjs` so raw-`node` CI
 * scripts (no Vite/tsx) can import it; this `.ts` re-export lets build-plugin
 * TypeScript consumers (e.g. `spaBundleRx.ts`) share the exact same source of
 * truth without copy-pasting the alphabet. Same pattern as `ejpMarker.ts`.
 */
export { VITE_HASH_CHARS, VITE_HASH_LEN, VITE_ASSET_RX } from './viteAssetHashRx.mjs';
