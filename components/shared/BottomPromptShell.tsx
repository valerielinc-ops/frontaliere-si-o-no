/**
 * BottomPromptShell — the ONE bottom-anchored floating prompt, and the reason
 * two of them can no longer land on the same pixels.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * Four surfaces carried this class list, byte-for-byte identical:
 *
 *   fixed above-mobile-nav right-4 z-40 w-[calc(100%-2rem)] max-w-sm animate-slide-up
 *
 * `JobDetailAlertPrompt`, `SavedJobsAlertNudge`, `ProfileEnrichmentPrompt` and
 * — centred instead of right-aligned, same offset and same z — the
 * `JobAlertStickyBanner`. Identical coordinates are not a near-miss: any two of
 * them on screen at once are pixel-on-pixel, the lower one unreachable and
 * unreadable. `services/popupQueue.ts` has arbitrated exactly this since long
 * before these prompts existed, and not one of them called it.
 *
 * The only guard in the tree was `savedJobsNudgeJsx = savedNudge &&
 * !jobDetailPromptVisible` in JobBoard: one hardcoded pair out of the ten a set
 * of five produces, expressed as a boolean in a parent that happens to render
 * both. It could not cover `ProfileEnrichmentPrompt` (rendered from
 * `JobAlertForm`, a different subtree) or the sticky banner, and it said
 * nothing at all about the surfaces already in the queue — the cookie banner,
 * the newsletter popup, the gamification toast, and the chatbot FAB, which sits
 * at `right-3 bottom-[4.5rem]`, four pixels off the prompts' own corner and a
 * full ten z-layers above them.
 *
 * ── THE FIX, AND WHY IT IS A COMPONENT ─────────────────────────────────────
 * Suppression logic in the parents would have been a fifth copy of the same
 * boolean. Instead the geometry and the arbitration live in ONE place: a prompt
 * gets its position by using this shell, and using it IS the queue claim. A
 * sixth prompt cannot be added at these coordinates without going through the
 * queue, because there is no other way to reach the coordinates.
 *
 * Being in the queue buys three things the ad-hoc boolean never could:
 *  · the other four prompts, in any subtree, on any route;
 *  · the pre-existing queue members, including the chatbot FAB, which already
 *    hides itself whenever `hasActiveSlot()` is true — so the FAB/prompt
 *    overlap is fixed by joining, with no CSS at all;
 *  · promotion. A losing prompt is not dropped, it waits: dismiss the winner
 *    and the next one appears 500ms later. The old boolean deleted the nudge
 *    outright, so the visitor who saved four jobs while the category prompt was
 *    up was simply never asked.
 *
 * ── onShown, AND WHY THE IMPRESSION MOVED HERE ─────────────────────────────
 * Callers used to count the impression at the moment they decided to show a
 * prompt. With a queue in between, deciding and appearing are different events,
 * and counting the first would report impressions for a toast nobody saw —
 * inflating the denominator of exactly the conversion rate this work is meant
 * to improve. `onShown` fires once, when the prompt is actually on screen.
 *
 * This is the same defect `hooks/useImpressionTracker.ts` was written for
 * (#5039: two CTAs contributed 56% of the `job_alert_cta_shown` denominator
 * with zero clicks between them, because they counted renders). It is NOT
 * built on that hook, though: the observer answers "is this element in the
 * viewport", and a `fixed` toast anchored to the bottom of the viewport is in
 * it by construction the moment it renders. The open question here was never
 * visibility, it was whether the prompt rendered AT ALL — so the answer is the
 * slot, not an IntersectionObserver.
 */
import React, { useEffect, useRef } from 'react';

import { usePopupSlot } from '@/hooks/usePopupSlot';
import { ABOVE_MOBILE_NAV_BOTTOM } from '@/components/shared/mobileNavClearance';

export interface BottomPromptShellProps {
  /** Queue id — unique per prompt, stable across renders. */
  slotId: string;
  /** `POPUP_PRIORITY` value. Higher wins and preempts. */
  priority: number;
  /**
   * `right` for the corner toasts, `center` for the full-width sticky banner.
   * The two are NOT interchangeable positions that happen to differ: on a phone
   * both are `calc(100% - 2rem)` wide, so they occupy the same box either way —
   * the distinction only shows from `sm` up.
   */
  align?: 'right' | 'center';
  /**
   * `sm` (24rem) is the corner-toast default. `md` (28rem) is for a prompt whose
   * body includes the consent formula: the sentence is fixed by
   * `services/consentTexts.ts` and cannot be shortened here, so the only way to
   * spend fewer vertical pixels on it is to give it more horizontal ones.
   * Below `sm` both collapse to the same `calc(100% - 2rem)`.
   */
  width?: 'sm' | 'md';
  role?: 'dialog' | 'region' | 'status';
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Fired once, the first time this prompt is actually on screen. */
  onShown?: () => void;
  /**
   * Escape-to-dismiss, attached ONLY while this prompt is the visible one.
   *
   * It belongs here and not in the prompt for the same reason the position
   * does. Two prompts used to bind `keydown` on `window` from their own
   * effects, which ran whether or not they were rendered — harmless when a
   * prompt was either mounted-and-visible or not mounted at all, and wrong the
   * moment a prompt can be mounted and WAITING: Escape pressed for any other
   * reason would run the queued prompt's dismiss path, recording a dismissal
   * (and burning its gating cooldown) for a toast nobody ever saw. That is the
   * mirror image of the impression bug `onShown` fixes, and it deserved the
   * same answer rather than a second one.
   *
   * Pass `undefined` to disable — e.g. while a submit is in flight.
   */
  onEscape?: () => void;
  children: React.ReactNode;
}

/**
 * The shared geometry. Exported so tests can assert that no OTHER component
 * hardcodes it — the class list is the thing that must not be copied.
 */
export const BOTTOM_PROMPT_BASE_CLASS = `fixed ${ABOVE_MOBILE_NAV_BOTTOM} z-40 w-[calc(100%-2rem)] animate-slide-up`;

const ALIGN_CLASS: Record<'right' | 'center', string> = {
  right: 'right-4',
  center: 'left-1/2 -translate-x-1/2',
};

const WIDTH_CLASS: Record<'sm' | 'md', string> = {
  sm: 'max-w-sm',
  md: 'max-w-sm sm:max-w-md',
};

const BottomPromptShell: React.FC<BottomPromptShellProps> = ({
  slotId,
  priority,
  align = 'right',
  width = 'sm',
  role = 'dialog',
  ariaLabel,
  ariaLabelledBy,
  onShown,
  onEscape,
  children,
}) => {
  const active = usePopupSlot(slotId, priority);
  // Keyed on the slot, not just "have we fired once": React reuses a component
  // instance when the same element type reappears in the same position, so a
  // shell whose `slotId` changed would otherwise inherit the previous prompt's
  // "already counted" flag and silently drop the new prompt's impression.
  const shownForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active || shownForRef.current === slotId) return;
    shownForRef.current = slotId;
    onShown?.();
    // `onShown` is deliberately out of the dependency list: callers pass an
    // inline arrow, and re-running on every render would fire the impression
    // again on each parent update. The ref is what makes it once-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, slotId]);

  // Read through a ref so an inline arrow at the call site does not re-bind the
  // listener on every parent render.
  const escapeRef = useRef<(() => void) | undefined>(onEscape);
  escapeRef.current = onEscape;
  const escapeEnabled = Boolean(onEscape);

  useEffect(() => {
    if (!active || !escapeEnabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') escapeRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, escapeEnabled]);

  if (!active) return null;

  return (
    <div
      role={role}
      aria-modal={role === 'dialog' ? false : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-bottom-prompt={slotId}
      className={`${BOTTOM_PROMPT_BASE_CLASS} ${ALIGN_CLASS[align]} ${WIDTH_CLASS[width]}`}
    >
      {children}
    </div>
  );
};

export default BottomPromptShell;
