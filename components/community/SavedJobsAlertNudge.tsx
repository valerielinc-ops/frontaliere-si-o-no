import { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap, upgradeBackfilledAlertConsent } from '@/services/jobAlertService';
import ConsentNotice from '@/components/shared/ConsentNotice';
import BottomPromptShell from '@/components/shared/BottomPromptShell';
import { POPUP_PRIORITY } from '@/services/popupQueue';

/**
 * Saved-jobs alert nudge (issue #4467, epic #4465).
 *
 * Fixed-position toast shown when the visitor has saved ≥2 jobs (threshold +
 * cooldown gating in `services/savedJobsService.ts`): "ricevi email quando
 * escono job simili", prefilled with the dominant category/canton derived
 * from the saved list. Known users (userId+email) subscribe in ONE tap via
 * `subscribeJobAlertOneTap`; anonymous users are routed to the always-mounted
 * `JobAlertForm` (via `onAnonymousAccept` → `requestJobAlertOpen`), which owns
 * the auth/email capture flow.
 *
 * Modeled byte-for-byte on `JobDetailAlertPrompt.tsx` (same state machine,
 * same toast shell, same mobile-nav clearance) so the surface stays visually
 * and behaviorally consistent — and, being `fixed`-positioned, it can never
 * shift layout (zero CLS, Non-Negotiable #7 untouched).
 */
export type SavedJobsAlertNudgeStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface SavedJobsAlertNudgeProps {
  /** Localized category label (may carry the emoji prefix — stripped downstream). */
  categoryLabel: string;
  /** Validated 2-letter canton code, or null (no geo scope). */
  cantonCode: string | null;
  /** Localized canton display name for copy, or null. */
  cantonLabel: string | null;
  /** Authenticated user id, or null for anonymous visitors. */
  userId: string | null;
  /** Authenticated user email, or null for anonymous visitors. */
  email: string | null;
  locale: Locale;
  /** Called once the toast should disappear (any reason). */
  onClose: () => void;
  /** Called on the accept TAP (known + anonymous) — the nudge_accepted funnel step. */
  onAcceptTapped?: () => void;
  /** Called after a successful one-tap create (known users only). */
  onAccepted: () => void;
  /** Called when an anonymous visitor taps accept — route to the alert form. */
  onAnonymousAccept: () => void;
  /** Called on explicit dismiss (✕ or "Non ora"). */
  onDismissed: () => void;
  /** Called when the one-tap subscribe throws. */
  onErrored?: (error: unknown) => void;
  /**
   * Fired once, when the nudge is actually on screen — which, since it now
   * queues behind higher-priority prompts, is no longer the same moment the
   * parent decided to render it.
   */
  onShown?: () => void;
  /** Injectable for tests. */
  subscribe?: typeof subscribeJobAlertOneTap;
  /** Optional override for the consent-proof upgrade (used by tests). */
  upgradeConsent?: typeof upgradeBackfilledAlertConsent;
}

const SUCCESS_AUTO_DISMISS_MS = 6000;
const TITLE_ID = 'saved-jobs-nudge-title';

export default function SavedJobsAlertNudge({
  categoryLabel,
  cantonCode,
  cantonLabel,
  userId,
  email,
  locale,
  onClose,
  onAcceptTapped,
  onAccepted,
  onAnonymousAccept,
  onDismissed,
  onErrored,
  onShown,
  subscribe = subscribeJobAlertOneTap,
  upgradeConsent = upgradeBackfilledAlertConsent,
}: SavedJobsAlertNudgeProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SavedJobsAlertNudgeStatus>('idle');

  const handleAccept = useCallback(async () => {
    if (status === 'idle' && onAcceptTapped) onAcceptTapped();
    if (!userId || !email) {
      // Anonymous: hand off to the always-mounted JobAlertForm (owns auth).
      onAnonymousAccept();
      onClose();
      return;
    }
    setStatus('submitting');
    try {
      await subscribe(userId, email, categoryLabel, locale, undefined, cantonCode);
      setStatus('success');
      // #5876 — an explicit "Sì, avvisami" under the notice below. Records the
      // consent proof on this person's travaso alerts, never awaited into the
      // error path.
      void upgradeConsent(email, locale).catch(() => {});
      onAccepted();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [status, userId, email, categoryLabel, cantonCode, locale, onAcceptTapped, onAccepted, onAnonymousAccept, onClose, onErrored, subscribe, upgradeConsent]);

  const handleDismiss = useCallback(() => {
    onDismissed();
    onClose();
  }, [onClose, onDismissed]);

  // Escape closes the toast in any non-submitting state. Handed to the shell
  // rather than bound here: this component is now mounted while it WAITS for a
  // popupQueue slot, and a `window` listener bound from its own effect would
  // dismiss — and record the dismissal of — a toast that is not on screen.
  const handleEscape =
    status === 'submitting' ? undefined : status === 'success' ? onClose : handleDismiss;

  // Auto-dismiss after success.
  useEffect(() => {
    if (status !== 'success') return;
    const id = window.setTimeout(() => onClose(), SUCCESS_AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [onClose, status]);

  const title =
    status === 'success'
      ? t('savedJobsNudge.successTitle', 'Alert attivato ✓')
      : t('savedJobsNudge.title', 'Ti piacciono questi annunci?');
  const body =
    status === 'success'
      ? t('savedJobsNudge.successBody', 'Ti scriviamo appena escono nuove offerte nei tuoi criteri.')
      : cantonLabel
        ? t('savedJobsNudge.bodyWithCanton', { category: categoryLabel, canton: cantonLabel })
        : t('savedJobsNudge.body', { category: categoryLabel });

  const closeAriaLabel = t('common.close', 'Chiudi');

  return (
    // Position + one-at-a-time arbitration come from the shell. JobBoard used to
    // suppress this nudge outright whenever the job-detail prompt was up — the
    // only overlap guard in the tree, and it DELETED the ask instead of
    // deferring it. Through the queue it simply waits its turn.
    <BottomPromptShell
      slotId="saved-jobs-alert-nudge"
      priority={POPUP_PRIORITY.SAVED_JOBS_NUDGE}
      width="md"
      ariaLabelledBy={TITLE_ID}
      onShown={onShown}
      onEscape={handleEscape}
    >
      <div className="relative p-3.5 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
        <button
          type="button"
          onClick={status === 'success' ? onClose : handleDismiss}
          aria-label={closeAriaLabel}
          disabled={status === 'submitting'}
          className="absolute top-2 right-2 p-1 text-muted hover:text-strong transition-colors disabled:opacity-50"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
        <div className="flex items-start gap-3">
          <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent-strong text-on-accent shadow-sm">
            <BellRing className="w-4 h-4" aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0 pr-4">
            <h3 id={TITLE_ID} className="text-sm font-bold text-heading">
              {title}
            </h3>
            <p className="mt-0.5 text-xs text-subtle">{body}</p>
            <div className="mt-2 flex items-center gap-2">
              {(status === 'idle' || status === 'submitting') && (
                <>
                  <button
                    type="button"
                    onClick={handleAccept}
                    disabled={status === 'submitting'}
                    aria-busy={status === 'submitting'}
                    className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors disabled:opacity-60"
                  >
                    {status === 'submitting' && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    )}
                    {t('savedJobsNudge.acceptCta', 'Sì, avvisami')}
                  </button>
                  <button
                    type="button"
                    onClick={handleDismiss}
                    disabled={status === 'submitting'}
                    className="inline-flex items-center px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg border border-edge text-subtle hover:bg-surface-raised transition-colors disabled:opacity-50"
                  >
                    {t('savedJobsNudge.dismissCta', 'Non ora')}
                  </button>
                </>
              )}
              {status === 'error' && (
                <>
                  <p className="text-xs text-danger">
                    {t('savedJobsNudge.errorBody', "Non sono riuscito a creare l'alert. Riprova.")}
                  </p>
                  <button
                    type="button"
                    onClick={handleAccept}
                    className="inline-flex items-center px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
                  >
                    {t('savedJobsNudge.retryCta', 'Riprova')}
                  </button>
                </>
              )}
            </div>
            {(status === 'idle' || status === 'error') && (
              // Small print under the buttons, same rationale as
              // JobDetailAlertPrompt: the sentence is the stored consent proof
              // and stays verbatim, but it no longer sits between the promise
              // and the CTA.
              <ConsentNotice
                consentKey="communicationsOptIn"
                locale={locale}
                className="mt-2 text-[10px] text-muted leading-snug block"
              />
            )}
          </div>
        </div>
      </div>
    </BottomPromptShell>
  );
}
