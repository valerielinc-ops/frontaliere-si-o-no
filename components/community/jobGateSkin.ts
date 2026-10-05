/**
 * jobgate-v4 — per-arm visual treatment of the job-detail auth gate.
 *
 * Every arm keeps the same copy, controls, tracking and consent notice; only
 * colour, elevation and the order of the blocks change. `control` holds the
 * exact classes the gate shipped with before the round, so the control arm
 * renders byte-identical markup. Hypotheses: docs/AUTHGATE-HEADLINE-EXPERIMENT.md
 * (round 4).
 *
 * Colours stay inside the design system: semantic tokens where they must
 * follow the theme, and the fixed `navy-*` / `stripe-*` theme palette where a
 * panel must look the same in light and dark mode (white text on those is
 * ≥ 7:1 in both). The class strings live in `components/` so Tailwind's
 * content scan sees them.
 *
 * HEIGHT INVARIANT: every arm renders the gate exactly as tall as `control`.
 * A gate painted while Remote Config is still loading starts as control and
 * switches to its arm afterwards; if the height changed, the AdSense slot
 * below the gate would jump (CLS). So an arm may recolour, re-order and add
 * shadows/rings (no layout), but never changes border width, control sizes or
 * the sum of vertical paddings and gaps. `actions_first` shows the arithmetic.
 */

import type { JobGateArm } from '@/services/jobGateExperiment';

export interface JobGateSkin {
  /** `#job-auth-gate` region. */
  container: string;
  /** actions_first: the coloured band that holds the title; null = title in the body. */
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
  /** Sign-in buttons render right after the title, the explanation after them. */
  actionsFirst: boolean;
}

const CONTROL: JobGateSkin = {
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
 * navy_panel — figure/ground. The incumbent lavender box shares its colour
 * with the employer card right above it, so the decision point reads as one
 * more info card. A deep navy panel (the footer colour) breaks the page
 * rhythm exactly where the reader has to act. Text is white or white-tinted,
 * never grey, and the email CTA keeps the brand purple as the one saturated
 * fill on the panel.
 */
const NAVY_PANEL: JobGateSkin = {
  ...CONTROL,
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-navy-800 bg-navy-900 p-4 sm:p-6 shadow-stripe-lg',
  heading: 'flex items-start gap-2 text-lg sm:text-xl font-bold font-display text-on-accent leading-tight',
  headingIcon: 'w-5 h-5 mt-0.5 text-stripe-300 flex-shrink-0',
  subtitle: 'mt-2 text-sm text-on-accent/80',
  trustList: 'mt-3 space-y-1.5 text-sm text-on-accent/80',
  trustIcon: 'text-stripe-300 flex-shrink-0',
  consentNotice: 'text-xs leading-relaxed text-on-accent/70 [&_a]:text-on-accent',
  socialProof: 'mt-3 text-xs font-medium text-stripe-300',
  divider: 'flex-1 h-px bg-on-accent/20',
  dividerLabel: 'inline-flex items-center gap-1.5 text-sm text-on-accent/75 hover:text-on-accent transition-colors',
  emailInput: 'w-full px-3 py-2.5 rounded-stripe border border-navy-800 bg-surface text-sm text-heading placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-stripe-300',
  // 60% over navy turns the idle CTA into an unreadable muddy blue; 80% still
  // reads as "not yet" without hiding the label.
  emailSubmit: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-stripe-600 hover:bg-stripe-500 disabled:opacity-80 text-on-accent text-sm font-semibold ring-1 ring-on-accent/15 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stripe-300',
  authError: 'text-sm font-semibold text-on-accent mt-2',
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
  ...CONTROL,
  // 1px border + 1px ring reads as a 2px accent outline; the ring is a shadow, so the box keeps control's size.
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent ring-1 ring-accent bg-surface p-4 sm:p-6 shadow-stripe-lg',
  emailSubmit: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold shadow-stripe transition-colors',
  emailSubmitDisabledWhenEmpty: false,
  linkedInButton: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-surface border border-edge hover:bg-surface-raised disabled:opacity-60 text-strong text-sm font-semibold shadow-sm transition-colors',
  linkedInIcon: 'text-brand-linkedin',
  previewFade: true,
};

/**
 * actions_first — distance to action. On a 390px phone the sign-in buttons
 * start ~1,400px below the top of the gate card, behind a four-line
 * explanation, two benefits and the notice. Here the title sits in a solid
 * brand band and the buttons follow it immediately; the registration notice
 * stays directly under the buttons (it must be read with them), explanation
 * and benefits come after.
 *
 * Height arithmetic (P = control padding, 16px / 24px from `sm`): control is
 * 2P + gaps 8+12+12+12+16 = 2P + 60. Here the gaps are 12 (notice) + 12
 * (explanation) + 12 + 12 = 48 and the bottom padding is P, so band + body-top
 * padding must add up to P + 12: band 8+8 / 12+12, body top 12 → 28 / 36.
 */
const ACTIONS_FIRST: JobGateSkin = {
  ...CONTROL,
  container: 'relative z-10 mt-3 scroll-mt-20 overflow-hidden rounded-stripe border border-stripe-700 bg-surface shadow-stripe-md',
  headerBand: 'bg-stripe-700 px-4 py-2 sm:px-6 sm:py-3',
  body: 'px-4 pt-3 pb-4 sm:px-6 sm:pb-6',
  heading: 'flex items-start gap-2 text-lg sm:text-xl font-bold font-display text-on-accent leading-tight',
  headingIcon: 'w-5 h-5 mt-0.5 text-stripe-200 flex-shrink-0',
  subtitle: 'mt-3 text-sm text-subtle',
  actionsFirst: true,
};

const SKINS: Record<JobGateArm, JobGateSkin> = {
  control: CONTROL,
  navy_panel: NAVY_PANEL,
  spotlight: SPOTLIGHT,
  actions_first: ACTIONS_FIRST,
};

export function jobGateSkin(arm: JobGateArm): JobGateSkin {
  return SKINS[arm] ?? CONTROL;
}
