import { useCallback, useRef, useState } from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertForJob } from '@/services/jobAlertService';
import { useImpressionTracker } from '@/hooks/useImpressionTracker';

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
  /** Fired once when the direct detail CTA becomes visible. */
  onImpression?: () => void;
  /** Optional override for the subscribe call (used by tests). */
  subscribe?: typeof subscribeJobAlertForJob;
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
  onImpression,
  subscribe = subscribeJobAlertForJob,
}: JobDetailJobAlertButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JobDetailJobAlertButtonStatus>('idle');
  const impressionTrackedRef = useRef(false);
  const reportImpression = useCallback(() => {
    if (impressionTrackedRef.current) return;
    impressionTrackedRef.current = true;
    onImpression?.();
  }, [onImpression]);
  const impressionRef = useImpressionTracker(reportImpression);
  const handleClick = useCallback(async () => {
    if (!jobId) return;
    // A click proves the CTA was visible even if the observer callback has not
    // run yet; emit the denominator before the create can succeed.
    reportImpression();
    setStatus('submitting');
    try {
      await subscribe(userId, email, jobId, locale, {
        slug: sourceJobSlug ?? null,
        url: sourceJobUrl ?? null,
        title: sourceJobTitle ?? null,
      }, {
        email,
        source: 'job_alert_detail_button',
        sourceChannel: 'job_alert_detail_button',
        sourcePage: typeof window !== 'undefined' ? window.location.pathname : null,
        sourceCta: 'job_alert_detail_button',
        sourceComponent: 'JobDetailJobAlertButton',
        sourceRouteFamily: 'job-detail',
        locale,
      });
      setStatus('success');
      // #5876 — the person pressed a button that activates an alert, with the
      // notice above on screen. If their alert came from the travaso, that act
      // is what turns a deduced consent into an explicit one. Deliberately not
      // awaited into this CTA's error path: a proof that fails to land must
      // never present a successful subscription as a failure.
      if (onSubscribed) onSubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [email, jobId, locale, onErrored, onSubscribed, reportImpression, sourceJobSlug, sourceJobTitle, sourceJobUrl, subscribe, userId]);

  if (status === 'success') {
    return (
      <div ref={impressionRef} className="mt-3">
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-success">
          <Check className="w-4 h-4" aria-hidden="true" />
          {t('jobAlert.jobDetailButton.success', 'Ti avviseremo su questo annuncio ✓')}
        </p>
      </div>
    );
  }

  return (
    <div ref={impressionRef} className="mt-3">
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
