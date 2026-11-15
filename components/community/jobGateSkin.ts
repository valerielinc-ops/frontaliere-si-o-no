/**
 * jobgate-v6 — visual variants of the promoted tinted auth gate.
 *
 * Every arm keeps the same copy, controls, tracking, consent notice, order and
 * box-model dimensions. Only the visual treatment changes. `control` is the
 * promoted tinted default; the other three arms are the selected v6 styles.
 *
 * Colours stay inside the design system and use semantic tokens so every arm
 * follows the active theme. The class strings live in `components/` so
 * Tailwind's content scan sees them.
 *
 * HEIGHT INVARIANT: every arm renders the gate exactly as tall as `control`.
 * Remote Config can settle after first paint; if the height changed, the
 * AdSense slot below the gate would jump (CLS). Arms may recolour, but never
 * change border width, control sizes, block order, paddings or gaps.
 */

import type { JobGateArm } from '@/services/jobGateExperiment';

export interface JobGateSkin {
  /** `#job-auth-gate` region. */
  container: string;
  /** Reserved for the legacy layout; v6 keeps this null in every arm. */
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
  /** Whether the email CTA is disabled (faded) until an address is typed. */
  emailSubmitDisabledWhenEmpty: boolean;
  linkedInButton: string;
  /** LinkedIn glyph colour when the button is neutral (null = inherits on-accent). */
  linkedInIcon: string | null;
  googleFallbackButton: string;
  authError: string;
  /** The public description preview fades into the gate. */
  previewFade: boolean;
  /** Reserved for the legacy order; v6 keeps the same order in every arm. */
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

/** Control — the promoted tinted treatment with one clear email action. */
const CONTROL: JobGateSkin = {
  ...BASE_GATE,
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent bg-accent-subtle p-4 sm:p-6',
  emailSubmit: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold shadow-stripe transition-colors',
  emailSubmitDisabledWhenEmpty: false,
  linkedInButton: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-surface border border-edge hover:bg-surface-raised disabled:opacity-60 text-strong text-sm font-semibold shadow-sm transition-colors',
  linkedInIcon: 'text-brand-linkedin',
  previewFade: true,
};

/** V6-02 — tinted field with a crisp double frame; the ring preserves geometry. */
const TINTED_FRAME: JobGateSkin = {
  ...CONTROL,
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent ring-1 ring-surface bg-accent-subtle p-4 sm:p-6',
};

/** V6-07 — a quiet dossier surface with a restrained document-like lift. */
const DOSSIER: JobGateSkin = {
  ...CONTROL,
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-edge bg-surface-alt p-4 sm:p-6 shadow-stripe-sm',
};

/** V6-13 — navy companion: authoritative surface, same controls and hierarchy. */
const NAVY_COMPANION: JobGateSkin = {
  ...CONTROL,
  container: 'relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-admin-rail-edge bg-admin-rail p-4 sm:p-6 shadow-stripe-lg',
  heading: 'flex items-start gap-2 text-lg sm:text-xl font-bold font-display text-admin-rail-ink leading-tight',
  headingIcon: 'w-5 h-5 mt-0.5 text-accent flex-shrink-0',
  subtitle: 'mt-2 text-sm text-admin-rail-muted',
  trustList: 'mt-3 space-y-1.5 text-sm text-admin-rail-muted',
  trustIcon: 'text-accent flex-shrink-0',
  consentNotice: 'text-xs text-admin-rail-muted leading-relaxed',
  socialProof: 'mt-3 text-xs font-medium text-accent',
  divider: 'flex-1 h-px bg-admin-rail-edge',
  dividerLabel: 'inline-flex items-center gap-1.5 text-sm text-admin-rail-muted hover:text-admin-rail-ink transition-colors',
  emailSubmit: 'w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-admin-rail-ink hover:bg-surface-raised disabled:opacity-60 text-admin-rail text-sm font-semibold transition-colors',
};

const SKINS: Record<JobGateArm, JobGateSkin> = {
  control: CONTROL,
  navy_companion: NAVY_COMPANION,
  tinted_frame: TINTED_FRAME,
  dossier: DOSSIER,
};

export function jobGateSkin(arm: JobGateArm): JobGateSkin {
  return SKINS[arm] ?? CONTROL;
}
