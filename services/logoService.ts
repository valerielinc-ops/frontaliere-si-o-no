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

const INITIALS_PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#dcfce7', fg: '#166534' },
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#e0e7ff', fg: '#3730a3' },
  { bg: '#f3e8ff', fg: '#6b21a8' },
  { bg: '#fee2e2', fg: '#991b1b' },
  { bg: '#ccfbf1', fg: '#115e59' },
];

/**
 * Build a deterministic per-company "initials" SVG, inlined as a data URI so
 * neither the SPA nor the static HTML issues an extra HTTP request and it never
 * 404s. Used when no curated brand asset is available — gives every company a
 * coloured visual identity instead of the neutral grey placeholder or the
 * Google favicon grey-globe. Shared verbatim with the static SEO renderer
 * (`build-plugins/shared/companyLogoResolver.ts` re-exports this) so the SPA
 * and the pre-rendered HTML produce byte-identical badges.
 */
export function generateInitialsLogo(company: string): string {
  const cleaned = company.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  const initials = words.length === 0
    ? '?'
    : words.length === 1
      ? words[0].slice(0, 2).toUpperCase()
      : (words[0][0] + words[1][0]).toUpperCase();
  let hash = 0;
  for (let i = 0; i < cleaned.length; i++) hash = (hash * 31 + cleaned.charCodeAt(i)) >>> 0;
  const palette = INITIALS_PALETTE[hash % INITIALS_PALETTE.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">` +
    `<rect width="40" height="40" rx="8" fill="${palette.bg}"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="16" font-weight="700" fill="${palette.fg}">` +
    `${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

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
