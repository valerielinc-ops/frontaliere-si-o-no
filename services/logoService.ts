/**
 * Company logo fallback helpers.
 *
 * Chain of attempts for a company logo:
 *   1. Explicit CRAWLED_COMPANY_LOGOS map (see jobDataNormalization.resolveCompanyLogoUrl)
 *   2. Clearbit logo CDN (logo.clearbit.com)
 *   3. Google favicon API (google.com/s2/favicons)
 *   4. Static SVG placeholder (/icons/company-placeholder.svg)
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
 *   - If the image was served by Clearbit, retry with Google's favicon API.
 *   - If the image was served by Google favicons, fall back to the local SVG placeholder.
 *   - Otherwise, fall back to the local SVG placeholder directly.
 *
 * The placeholder is only assigned once (we guard against infinite error loops
 * by checking the current src before mutating).
 */
export function handleCompanyLogoError(event: SyntheticEvent<HTMLImageElement>): void {
 const el = event.currentTarget;
 // Avoid infinite loop: once placeholder is set, stop.
 if (el.dataset.logoFallback === 'placeholder') return;

 const currentSrc = el.src || '';

 // Step 1: Clearbit → Google favicon
 if (currentSrc.includes('logo.clearbit.com')) {
 const domain = currentSrc.replace(/^https?:\/\/logo\.clearbit\.com\//, '').split(/[/?#]/)[0];
 if (domain) {
 el.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
 el.dataset.logoFallback = 'google-favicon';
 return;
 }
 }

 // Step 2 (or any other failure): local SVG placeholder
 el.src = COMPANY_LOGO_PLACEHOLDER;
 el.dataset.logoFallback = 'placeholder';
 // Make sure it's visible (some older sites hid the image on error)
 el.style.visibility = 'visible';
}
