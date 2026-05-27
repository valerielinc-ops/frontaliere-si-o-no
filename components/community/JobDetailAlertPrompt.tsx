import { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap } from '@/services/jobAlertService';

export type JobDetailAlertPromptStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface JobDetailAlertPromptProps {
  /** Localized category label, e.g. "Sanità". Used both as the keyword and in copy. */
  category: string;
  /** Authenticated user id. */
  userId: string;
  /** Authenticated user email. */
  email: string;
  /** Active locale — passed straight to the alert config. */
  locale: Locale;
  /** Called once the toast should disappear (any reason). */
  onClose: () => void;
  /** Called when the user clicks "Sì, attiva" and the create succeeds. */
  onAccepted: () => void;
  /** Called when the user dismisses (✕ or "Non ora", incl. failed-accept fallthrough). */
  onDismissed: () => void;
  /** Called when subscribe throws. */
  onErrored?: (error: unknown) => void;
  /** Called when the user clicks the "Gestisci alert" link in the success state. */
  onManage: () => void;
  /** Optional override for the subscribe call (used by tests). */
  subscribe?: typeof subscribeJobAlertOneTap;
}

const TITLE_ID = 'job-detail-alert-prompt-title';
const SUCCESS_AUTO_DISMISS_MS = 4000;

export default function JobDetailAlertPrompt({
  category,
  userId,
  email,
  locale,
  onClose,
  onAccepted,
  onDismissed,
  onErrored,
  onManage,
  subscribe = subscribeJobAlertOneTap,
}: JobDetailAlertPromptProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JobDetailAlertPromptStatus>('idle');

  const handleAccept = useCallback(async () => {
    setStatus('submitting');
    try {
      await subscribe(userId, email, category, locale);
      setStatus('success');
      onAccepted();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [category, email, locale, onAccepted, onErrored, subscribe, userId]);

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
      ? t('jobAlert.jobDetailPrompt.successTitle', 'Alert attivato ✓').replace('{category}', category)
      : status === 'error'
      ? t('jobAlert.jobDetailPrompt.errorTitle', 'Errore')
      : t('jobAlert.jobDetailPrompt.title', 'Vuoi alert per {category}?').replace(
          '{category}',
          category,
        );

  const body =
    status === 'success'
      ? t(
          'jobAlert.jobDetailPrompt.successBody',
          'Ti avvisiamo quando escono nuove offerte «{category}».',
        ).replace('{category}', category)
      : status === 'error'
      ? t(
          'jobAlert.jobDetailPrompt.errorBody',
          "Non sono riuscito a creare l'alert. Riprova o gestiscilo dalla pagina alert.",
        )
      : t(
          'jobAlert.jobDetailPrompt.body',
          'Ti scriviamo quando escono nuovi lavori in «{category}».',
        ).replace('{category}', category);

  const closeAriaLabel = t('common.close', 'Chiudi');

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={TITLE_ID}
      className="fixed bottom-4 right-4 z-40 w-[calc(100%-2rem)] max-w-sm animate-slide-up"
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
            <div className="mt-3 flex items-center gap-2">
              {status === 'idle' && (
                <>
                  <button
                    type="button"
                    onClick={handleAccept}
                    className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
                  >
                    {t('jobAlert.jobDetailPrompt.acceptCta', 'Sì, attiva')}
                  </button>
                  <button
                    type="button"
                    onClick={handleDismiss}
                    className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-muted hover:text-strong transition-colors"
                  >
                    {t('jobAlert.jobDetailPrompt.dismissCta', 'Non ora')}
                  </button>
                </>
              )}
              {status === 'submitting' && (
                <button
                  type="button"
                  disabled
                  aria-busy="true"
                  className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent opacity-80"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  {t('jobAlert.jobDetailPrompt.acceptCta', 'Sì, attiva')}
                </button>
              )}
              {status === 'success' && (
                <button
                  type="button"
                  onClick={() => {
                    onManage();
                    onClose();
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg text-accent hover:underline transition-colors"
                >
                  {t('jobAlert.jobDetailPrompt.manageLink', 'Gestisci alert')}
                </button>
              )}
              {status === 'error' && (
                <>
                  <button
                    type="button"
                    onClick={handleAccept}
                    className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
                  >
                    {t('jobAlert.jobDetailPrompt.retryCta', 'Riprova')}
                  </button>
                  <button
                    type="button"
                    onClick={handleDismiss}
                    className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-muted hover:text-strong transition-colors"
                  >
                    {t('jobAlert.jobDetailPrompt.dismissCta', 'Non ora')}
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
