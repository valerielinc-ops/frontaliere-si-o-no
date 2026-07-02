// cdnImageBase.ts
//
// Runtime CDN rewrite for the self-hosted brand/logo/author images that are
// offloaded out of the GitHub Pages artifact to the dedicated CDN repo
// `frontaliere-cdn` (its own GitHub Pages site, Fastly edge) at deploy time —
// served with a STABLE URL (CDN_BASE, no SHA pin), see
// scripts/offload-generated-images-cdn.mjs.
//
// Reuses the SAME injected base as cdnDataBase (`window.__CDN_DATA_BASE__`,
// inlined into every dist HTML page by the post-build offload step AFTER the
// assets are pushed to the CDN repo). One CDN base serves every offloaded asset
// (og, data, images) at its same path, so no second base is needed.
//
// WHY a dedicated image helper (not cdnDataUrl): cdnDataUrl blindly prefixes ANY
// path with the base. Logo resolvers (services/jobDataNormalization.ts
// resolveCompanyLogoUrl, services/brandLogos.ts) return a MIX of same-origin
// `/images/brands/…` paths AND external URLs (logo.clearbit.com, gFavicon, a few
// hard-coded vendor https URLs). Prefixing an already-absolute https URL would
// corrupt it. So cdnImageUrl rewrites ONLY same-origin paths under the offloaded
// prefixes and passes everything else (external URLs, data: URIs, the local SVG
// placeholder, /images/places/ which stays same-origin) through verbatim.
//
// STATIC HTML vs SPA RUNTIME (the two emit paths — both must be covered):
//   • SPA runtime: this helper rewrites the `<img src>` to the CDN at render time
//     (window.__CDN_DATA_BASE__ is set).
//   • Static SSG HTML: build plugins run under Node (no `window`) so this helper
//     returns the same-origin path; the post-build offload script's regex then
//     rewrites those emitted same-origin `/images/{prefix}/…` refs to the CDN.
//   Net: every reference — SPA and static — ends up on the CDN, and the offload
//   script's per-target leak guard KEEPS a dir in dist if any same-origin static
//   ref to it survives (so a missed static rewrite degrades to "shipped in the
//   artifact", never a 404).
//
// GRACEFUL DEGRADATION (CDN-down safety, cf. the rawFallbackForBlog fix #1354):
//   • Base unset (dev, or the non-fatal offload skipped/failed): returns the
//     original same-origin path → served from dist exactly as before.
//   • Base set but the CDN 404s a logo at runtime: the consuming <img>'s existing
//     onError chain (services/logoService.ts handleCompanyLogoError /
//     ProviderLogo onError) falls through to Clearbit → local SVG placeholder, so
//     a CDN outage never shows a broken image. This helper does NOT introduce a
//     one-shot flag — every call re-reads the base, so it self-heals once the CDN
//     recovers.

import { cdnDataBase } from './cdnDataBase';

// Path prefixes that the deploy pushes to the CDN and the offload script deletes
// from dist (scripts/offload-generated-images-cdn.mjs IMAGE_TARGETS). MUST stay
// in sync with that list. `/images/places/` is intentionally NOT here — it stays
// same-origin (blog hero places), so its refs are passed through unchanged.
export const CDN_OFFLOADED_IMAGE_PREFIXES = [
  '/images/brands/',
  '/images/insurers/',
  '/images/providers/',
  '/images/logos/',
  '/images/authors/',
  '/images/publisher/',
  // Nationwide events feature (issue #3125): mirrored source images written by
  // scripts/lib/events-utils.mjs mirrorEventImage() to public/images/events/.
  '/images/events/',
] as const;

/**
 * Rewrite a same-origin offloaded brand/logo/author image path to its CDN URL
 * when the CDN base is injected, else return the input unchanged.
 *
 * Pass-through (returned verbatim) for: nullish input, external/absolute URLs
 * (http/https/protocol-relative/data:), and any same-origin path that is NOT
 * under an offloaded prefix (e.g. /images/places/…, /icons/…). This keeps the
 * helper safe to wrap around the mixed output of the logo resolvers.
 */
export function cdnImageUrl<T extends string | null | undefined>(path: T): T {
  if (!path) return path;
  // Only same-origin absolute paths are candidates; never touch external URLs.
  if (path[0] !== '/') return path;
  let offloadable = false;
  for (const prefix of CDN_OFFLOADED_IMAGE_PREFIXES) {
    if (path.startsWith(prefix)) {
      offloadable = true;
      break;
    }
  }
  if (!offloadable) return path;
  const base = cdnDataBase();
  return (base ? base + path : path) as T;
}
