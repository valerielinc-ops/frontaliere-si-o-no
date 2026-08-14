import { useCallback, useState } from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertForJob, upgradeBackfilledAlertConsent } from '@/services/jobAlertService';
import ConsentNotice from '@/components/shared/ConsentNotice';

export type JobDetailJobAlertButtonStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface JobDetailJobAlertButtonProps {
  /** Stable job id this alert is pinned to (matcher `specificJobId`). */
  jobId: string;
  /** Authenticated user id. */
  userId: string;
  /** Authenticated user email. */
  email: string;
  /** Active locale — passed straight to the alert config. */
  locale: Locale;
  /** Slug of the job — stored as subscription provenance. */
  sourceJobSlug?: string | null;
  /** Full canonical URL of the job — stored as subscription provenance. */
  sourceJobUrl?: string | null;
  /** Title of the job — stored as subscription provenance. */
  sourceJobTitle?: string | null;
  /** Called on a successful create (analytics / gating side-effects). */
  onSubscribed?: () => void;
  /** Called when subscribe throws. */
  onErrored?: (error: unknown) => void;
  /** Optional override for the subscribe call (used by tests). */
  subscribe?: typeof subscribeJobAlertForJob;
  /** Optional override for the consent-proof upgrade (used by tests). */
  upgradeConsent?: typeof upgradeBackfilledAlertConsent;
}

export default function JobDetailJobAlertButton({
  jobId,
  userId,
  email,
  locale,
  sourceJobSlug,
  sourceJobUrl,
  sourceJobTitle,
  onSubscribed,
  onErrored,
  subscribe = subscribeJobAlertForJob,
  upgradeConsent = upgradeBackfilledAlertConsent,
}: JobDetailJobAlertButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JobDetailJobAlertButtonStatus>('idle');

  const handleClick = useCallback(async () => {
    if (!jobId) return;
    setStatus('submitting');
    try {
      await subscribe(userId, email, jobId, locale, {
        slug: sourceJobSlug ?? null,
        url: sourceJobUrl ?? null,
        title: sourceJobTitle ?? null,
      });
      setStatus('success');
      // #5876 — the person pressed a button that activates an alert, with the
      // notice above on screen. If their alert came from the travaso, that act
      // is what turns a deduced consent into an explicit one. Deliberately not
      // awaited into this CTA's error path: a proof that fails to land must
      // never present a successful subscription as a failure.
      void upgradeConsent(email, locale).catch(() => {});
      if (onSubscribed) onSubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [email, jobId, locale, onErrored, onSubscribed, sourceJobSlug, sourceJobTitle, sourceJobUrl, subscribe, upgradeConsent, userId]);

  if (status === 'success') {
    return (
      <p className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-success">
        <Check className="w-4 h-4" aria-hidden="true" />
        {t('jobAlert.jobDetailButton.success', 'Ti avviseremo su questo annuncio ✓')}
      </p>
    );
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={status === 'submitting'}
        aria-busy={status === 'submitting'}
        className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold rounded-lg border border-accent-border bg-surface text-accent hover:bg-accent-subtle transition-colors disabled:opacity-60"
      >
        {status === 'submitting' ? (
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        ) : (
          <BellRing className="w-4 h-4" aria-hidden="true" />
        )}
        {t('jobAlert.jobDetailButton.cta', 'Avvisami per questo annuncio')}
      </button>
      <ConsentNotice
        consentKey="communicationsOptIn"
        locale={locale}
        className="mt-2 text-[11px] text-muted leading-relaxed block"
      />
      {status === 'error' && (
        <p className="mt-2 text-xs text-danger">
          {t(
            'jobAlert.jobDetailButton.error',
            "Non sono riuscito a creare l'alert. Riprova.",
          )}
        </p>
      )}
    </div>
  );
}
