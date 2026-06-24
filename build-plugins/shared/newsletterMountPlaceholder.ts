/**
 * newsletterMountPlaceholder — shared green newsletter CTA box for static SSG
 * pages (weather alert + weather city plugins).
 *
 * Emits the `[data-newsletter-mount]` box that NewsletterMount.tsx hydrates
 * into the canonical `<Newsletter compact />` at boot (Google one-tap +
 * Google fallback + LinkedIn + email form + MX check + Firebase upsert +
 * analytics). Only heading/subtitle text differ per page.
 *
 * Pre-hydration the box now renders a non-interactive skeleton (faux email
 * input + submit + Google + LinkedIn rows) that mirrors the final compact
 * form. The previous placeholder was a `min-h-[200px]` box with only a
 * heading + subtitle, leaving ~150px of empty green — visible as an empty
 * "green void" for the ~3-4s hydration window (and permanently on a no-JS
 * render). The skeleton fills that space so the card reads as an intentional
 * newsletter sign-up while React loads, and its height tracks the real form
 * to minimise CLS. NewsletterMount clears `innerHTML` before mounting, so the
 * skeleton is replaced seamlessly on hydration.
 *
 * Single source of truth: the identical box string was previously copy-pasted
 * in weatherAlertPagesPlugin and weatherCityPagesPlugin (drift hazard).
 */
import { escHtml } from './htmlEscape';

interface NewsletterMountPlaceholderOptions {
  acquisitionSource: string;
  heading: string;
  sub: string;
}

export function newsletterMountPlaceholder({
  acquisitionSource,
  heading,
  sub,
}: NewsletterMountPlaceholderOptions): string {
  // Skeleton classes mirror the real compact form (Newsletter.tsx): input row
  // (input + submit), Google button, LinkedIn button. aria-hidden + no
  // interactive elements — purely visual filler, cleared on hydration.
  return `<div data-newsletter-mount data-acquisition-source="${escHtml(acquisitionSource)}" data-heading="${escHtml(heading)}" data-subtitle="${escHtml(sub)}" class="bg-gradient-to-r from-info-strong to-success-strong rounded-2xl p-4 sm:p-6 text-on-accent">
<p class="font-bold font-display text-lg text-on-accent">${escHtml(heading)}</p>
<p class="text-on-accent/80 text-sm mt-2 mb-4">${escHtml(sub)}</p>
<div aria-hidden="true" class="space-y-3">
<div class="flex gap-2">
<div class="flex-grow min-h-[44px] bg-on-accent/15 border border-on-accent/25 rounded-xl"></div>
<div class="px-5 min-h-[44px] bg-surface rounded-xl"></div>
</div>
<div class="w-full min-h-[44px] bg-on-accent/10 border border-on-accent/20 rounded-xl"></div>
<div class="w-full min-h-[44px] bg-brand-linkedin rounded-lg"></div>
</div>
</div>`;
}
