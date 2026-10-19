/**
 * jobgate-v5 — contrast/accent variants of the promoted Spotlight auth gate.
 *
 * Every arm keeps the same copy, controls, tracking, consent notice, order and
 * box-model dimensions. Only the contrast/accent treatment changes. The
 * `spotlight` arm is the promoted default. Hypotheses:
 * docs/AUTHGATE-HEADLINE-EXPERIMENT.md (round 5).
 *
 * Colours stay inside the design system and use semantic tokens so every arm
 * follows the active theme. The class strings live in `components/` so
 * Tailwind's content scan sees them.
 *
 * HEIGHT INVARIANT: every arm renders the gate exactly as tall as `spotlight`.
 * Remote Config can settle after first paint; if the height changed, the
 * AdSense slot below the gate would jump (CLS). Arms may recolour, but never
 * change border width, control sizes, block order, paddings or gaps.
 */

import type { JobGateArm } from '@/services/jobGateExperiment';

export interface JobGateSkin {
  /** `#job-auth-gate` region. */
  container: string;
  /** Reserved for the legacy layout; v5 keeps this null in every arm. */
  headerBand: string | null;
  /** Wrapper of everything below the band (or of the whole gate without a band). */
  body: string;
  heading: string;
  headingIcon: string;
  subtitle: string;
  trustList: string;
  trustIcon: string;
  /** ConsentNotice text (null = the component's own default). */
  consentNotice: string | null;
  socialProof: string;
  divider: string;
  dividerLabel: string;
  emailInput: string;
  emailSubmit: string;
  /** The email CTA is disabled (faded) until an address is typed. */
  emailSubmitDisabledWhenEmpty: boolean;
  linkedInButton: string;
  /** LinkedIn glyph colour when the button is neutral (null = inherits on-accent). */
  linkedInIcon: string | null;
  googleFallbackButton: string;
  authError: string;
  /** The public description preview fades into the gate. */
  previewFade: boolean;
  /** Reserved for the legacy order; v5 keeps the same order in every arm. */
  actionsFirst: boolean;
}

const BASE_GATE: JobGateSkin = {
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent-border bg-accent-subtle p-4 sm:p-6',
  headerBand: null,
  body: '',
  heading: 'flex items-start gap-2 text-lg sm:text-xl font-bold font-display text-heading leading-tight',
  headingIcon: 'w-5 h-5 mt-0.5 text-accent flex-shrink-0',
  subtitle: 'mt-2 text-sm text-subtle',
  trustList: 'mt-3 space-y-1.5 text-sm text-subtle',
  trustIcon: 'text-success flex-shrink-0',
  consentNotice: null,
  socialProof: 'mt-3 text-xs font-medium text-accent',
  divider: 'flex-1 h-px bg-surface-raised/50',
  dividerLabel: 'inline-flex items-center gap-1.5 text-sm text-muted hover:text-subtle transition-colors',
  emailInput: 'w-full px-3 py-2.5 rounded-stripe border border-edge bg-surface text-sm text-heading placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  emailSubmit: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors',
  emailSubmitDisabledWhenEmpty: true,
  linkedInButton: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-brand-linkedin hover:bg-brand-linkedin-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors',
  linkedInIcon: null,
  googleFallbackButton: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-surface border border-edge hover:bg-surface-raised disabled:opacity-60 text-strong text-sm font-semibold shadow-sm transition-colors',
  authError: 'text-sm text-danger mt-2',
  previewFade: false,
  actionsFirst: false,
};

/**
 * spotlight — one action, one colour. In the incumbent gate the strongest
 * colour is LinkedIn's brand blue and the email CTA sits faded until an
 * address is typed, so nothing says "start here". Here the gate is a white
 * card lifted off the page (accent ring + the large Stripe shadow), the
 * preview fades into it as if the text continued underneath, LinkedIn goes
 * neutral like Google, and the email CTA is the only saturated control —
 * always enabled: an empty submit is stopped by the input's native
 * `required` validation and lands the caret in the field.
 */
const SPOTLIGHT: JobGateSkin = {
  ...BASE_GATE,
  // 1px border + 1px ring reads as a 2px accent outline; the ring is a shadow, so the box keeps Spotlight's size.
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent ring-1 ring-accent bg-surface p-4 sm:p-6 shadow-stripe-lg',
  emailSubmit: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold shadow-stripe transition-colors',
  emailSubmitDisabledWhenEmpty: false,
  linkedInButton: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-surface border border-edge hover:bg-surface-raised disabled:opacity-60 text-strong text-sm font-semibold shadow-sm transition-colors',
  linkedInIcon: 'text-brand-linkedin',
  previewFade: true,
};

/** Reduce frame emphasis but retain the strong single-action email CTA. */
const SPOTLIGHT_QUIET: JobGateSkin = {
  ...SPOTLIGHT,
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-edge bg-surface p-4 sm:p-6',
};

/** Shift the accent from the outline into the surface, using theme tokens. */
const SPOTLIGHT_TINTED: JobGateSkin = {
  ...SPOTLIGHT,
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent bg-accent-subtle p-4 sm:p-6',
};

/** Use a crisp outline as the single emphasis signal; no extra shadow or size. */
const SPOTLIGHT_OUTLINE: JobGateSkin = {
  ...SPOTLIGHT,
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-transparent ring-2 ring-accent bg-surface p-4 sm:p-6',
};

const SKINS: Record<JobGateArm, JobGateSkin> = {
  spotlight: SPOTLIGHT,
  spotlight_quiet: SPOTLIGHT_QUIET,
  spotlight_tinted: SPOTLIGHT_TINTED,
  spotlight_outline: SPOTLIGHT_OUTLINE,
};

export function jobGateSkin(arm: JobGateArm): JobGateSkin {
  return SKINS[arm] ?? SPOTLIGHT;
}
