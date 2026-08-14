import { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap, upgradeBackfilledAlertConsent } from '@/services/jobAlertService';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { ABOVE_MOBILE_NAV_BOTTOM } from '@/components/shared/mobileNavClearance';

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

  // Escape key closes the toast in any non-submitting state.
  useEffect(() => {
    if (status === 'submitting') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (status === 'success') {
          onClose();
        } else {
          handleDismiss();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleDismiss, onClose, status]);

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
    // ABOVE_MOBILE_NAV_BOTTOM keeps the CTA buttons clear of the mobile bottom nav.
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={TITLE_ID}
      className={`fixed ${ABOVE_MOBILE_NAV_BOTTOM} right-4 z-40 w-[calc(100%-2rem)] max-w-sm animate-slide-up`}
    >
      <div className="relative p-4 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
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
            <p className="mt-1 text-xs text-subtle">{body}</p>
            {(status === 'idle' || status === 'error') && (
              <ConsentNotice
                consentKey="communicationsOptIn"
                locale={locale}
                className="mt-2 text-[11px] text-muted leading-relaxed block"
              />
            )}
            <div className="mt-3 flex items-center gap-2">
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
          </div>
        </div>
      </div>
    </div>
  );
}
