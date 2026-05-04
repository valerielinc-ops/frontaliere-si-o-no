/**
 * Company logo fallback helpers.
 *
 * Chain of attempts for a company logo (resolved by the calling component,
 * usually `<ProviderLogo>`):
 *   1. Local slug-based asset (`PROVIDER_LOGOS[slug].localPath` in `services/brandLogos.ts`)
 *   2. Insurer-domain logo map (`getInsurerLogoUrl` in `services/brandLogos.ts`)
 *   3. Clearbit logo CDN (`logo.clearbit.com`)
 *   4. Local stylized SVG placeholder (`/icons/company-placeholder.svg`)
 *
 * Note: the older Google favicons step (`google.com/s2/favicons`) was removed
 * because it returned a generic gray-globe icon for unknown/disallowed
 * domains, which looked broken to users. We now fall straight from Clearbit
 * to the local placeholder.
 *
 * This service exports a single onError handler for <img> tags so every
 * broken-logo path eventually resolves to a visible placeholder instead of
 * a hidden image or missing-image icon. This directly addresses the Semrush
 * "broken external images" audit finding.
 */
import type { SyntheticEvent } from 'react';

export const COMPANY_LOGO_PLACEHOLDER = '/icons/company-placeholder.svg';

/**
 * onError handler for <img> tags displaying a company logo.
 *
 * Strategy:
 *   - Any failure (including Clearbit) falls through to the local SVG
 *     placeholder. The Google favicons fallback was removed (gray-globe).
 *
 * The placeholder is only assigned once (we guard against infinite error loops
 * by checking `dataset.logoFallback` before mutating).
 */
export function handleCompanyLogoError(event: SyntheticEvent<HTMLImageElement>): void {
  const el = event.currentTarget;
  // Avoid infinite loop: once placeholder is set, stop.
  if (el.dataset.logoFallback === 'placeholder') return;

  // Any failure → local SVG placeholder. We deliberately do NOT fall back to
  // Google favicons (`google.com/s2/favicons`) because it serves a generic
  // gray-globe icon for unknown domains and the user reported this as broken.
  el.src = COMPANY_LOGO_PLACEHOLDER;
  el.dataset.logoFallback = 'placeholder';
  // Make sure it's visible (some older sites hid the image on error)
  el.style.visibility = 'visible';
}
