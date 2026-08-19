import { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap, upgradeBackfilledAlertConsent } from '@/services/jobAlertService';
import ConsentNotice from '@/components/shared/ConsentNotice';
import BottomPromptShell from '@/components/shared/BottomPromptShell';
import { POPUP_PRIORITY } from '@/services/popupQueue';

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
  /** Slug of the job the user is viewing — stored as subscription provenance. */
  sourceJobSlug?: string | null;
  /** Full canonical URL of that job — stored as subscription provenance. */
  sourceJobUrl?: string | null;
  /** Title of that job — stored as subscription provenance. */
  sourceJobTitle?: string | null;
  /** Canton code of the job being viewed (e.g. "TI") — prefills the alert's
   * canton filter. Issue #4298: the job-detail one-tap alert previously only
   * scoped by category, dropping the canton the visitor is already looking at. */
  cantonCode?: string | null;
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
  /**
   * Fired once, when the toast is actually on screen.
   *
   * The impression used to be counted by JobBoard at the moment it decided to
   * show the prompt. Since the prompt now waits for a `popupQueue` slot
   * (components/shared/BottomPromptShell.tsx), deciding and appearing are two
   * different events, and counting the first would inflate the denominator of
   * the very conversion rate this surface is judged on.
   */
  onShown?: () => void;
  /** Optional override for the subscribe call (used by tests). */
  subscribe?: typeof subscribeJobAlertOneTap;
  /** Optional override for the consent-proof upgrade (used by tests). */
  upgradeConsent?: typeof upgradeBackfilledAlertConsent;
}

const TITLE_ID = 'job-detail-alert-prompt-title';
const SUCCESS_AUTO_DISMISS_MS = 4000;

export default function JobDetailAlertPrompt({
  category,
  userId,
  email,
  locale,
  sourceJobSlug,
  sourceJobUrl,
  sourceJobTitle,
  cantonCode,
  onClose,
  onAccepted,
  onDismissed,
  onErrored,
  onManage,
  onShown,
  subscribe = subscribeJobAlertOneTap,
  upgradeConsent = upgradeBackfilledAlertConsent,
}: JobDetailAlertPromptProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JobDetailAlertPromptStatus>('idle');

  const handleAccept = useCallback(async () => {
    setStatus('submitting');
    try {
      await subscribe(
        userId,
        email,
        category,
        locale,
        {
          slug: sourceJobSlug ?? null,
          url: sourceJobUrl ?? null,
          title: sourceJobTitle ?? null,
        },
        cantonCode ?? null,
      );
      setStatus('success');
      // #5876 — "Sì, attiva" is the explicit act the owner ruled on: if this
      // person's alert came from the travaso, it is now consented to, with the
      // notice rendered below as the stored formula. Never awaited into the
      // error path — a proof that fails to land must not turn a successful
      // subscription into an error toast.
      void upgradeConsent(email, locale).catch(() => {});
      onAccepted();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [category, email, locale, onAccepted, onErrored, subscribe, upgradeConsent, userId, sourceJobSlug, sourceJobUrl, sourceJobTitle, cantonCode]);

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
    // Position + one-at-a-time arbitration both come from the shell: this toast
    // used to carry the same `fixed above-mobile-nav right-4 z-40` coordinates
    // as three siblings and no coordination with any of them.
    <BottomPromptShell
      slotId="job-detail-alert-prompt"
      priority={POPUP_PRIORITY.JOB_DETAIL_PROMPT}
      // `md` at sm+ so the consent formula — whose wording is pinned by
      // services/consentTexts.ts and cannot be trimmed here — wraps into fewer
      // lines instead of pushing the CTA row further down the toast.
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
            {status === 'idle' && (
              // Under the buttons, not above them: the formula is small print
              // that has to be on screen when the act happens (#5902), and
              // three lines of it between the promise and "Sì, attiva" pushed
              // the CTA down the toast for no legal gain. The sentence itself
              // is untouched — it is stored verbatim as the consent proof, so
              // shortening it here would make the register describe something
              // nobody read.
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
