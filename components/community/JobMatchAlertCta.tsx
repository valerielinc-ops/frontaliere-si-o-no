import { useCallback, useState } from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap } from '@/services/jobAlertService';
import { useImpressionTracker } from '@/hooks/useImpressionTracker';

/**
 * One-tap "Avvisami per ruoli come questo" CTA (issue #3650, JM3).
 *
 * Renders next to the job-match personalization pill in JobBoard.tsx and
 * pre-fills a job alert straight from the profile JM1 (#3648) already
 * inferred from SalarySurvey answers / newsletter signals
 * (`services/jobMatchProfile.ts`) — sector → category label, canton — instead
 * of sending the user through the full `JobAlertForm` to re-enter filters
 * they've already given us. Modeled on `JobDetailJobAlertButton.tsx`'s
 * idle/submitting/success/error state machine.
 */
export type JobMatchAlertCtaStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface JobMatchAlertCtaProps {
  /** Authenticated user id. */
  userId: string;
  /** Authenticated user email. */
  email: string;
  /** Active locale — passed straight to the alert config. */
  locale: Locale;
  /** Localized, emoji-prefixed category label (e.g. "💻 Tecnologia") used as
   * both the alert keyword and the CTA copy substitution. */
  categoryLabel: string;
  /** Validated 2-letter canton code from the job-match profile, or null when
   * the profile has no canton / it isn't a real canton code (see
   * `CANTON_CODES` in `services/cantonList.ts`). */
  cantonCode?: string | null;
  /** Called on a successful create (analytics side-effects). */
  onSubscribed?: () => void;
  /** Called when subscribe throws. */
  onErrored?: (error: unknown) => void;
  /** Fired ONCE, the first time this CTA is genuinely visible in the viewport.
   * Deliberately not a mount callback: this surface renders inside a long job
   * list most visitors never scroll to, and firing on mount is what inflated the
   * `job_alert_cta_shown` denominator of the alert_funnel_conversion goal with
   * impressions nobody ever saw (issue #5039). */
  onImpression?: () => void;
  /** Optional override for the subscribe call (used by tests). */
  subscribe?: typeof subscribeJobAlertOneTap;
}

export default function JobMatchAlertCta({
  userId,
  email,
  locale,
  categoryLabel,
  cantonCode,
  onSubscribed,
  onErrored,
  onImpression,
  subscribe = subscribeJobAlertOneTap,
}: JobMatchAlertCtaProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JobMatchAlertCtaStatus>('idle');

  const handleClick = useCallback(async () => {
    if (!categoryLabel) return;
    setStatus('submitting');
    try {
      await subscribe(userId, email, categoryLabel, locale, undefined, cantonCode ?? null);
      setStatus('success');
      if (onSubscribed) onSubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [categoryLabel, cantonCode, email, locale, onErrored, onSubscribed, subscribe, userId]);

  // Impression = genuinely on screen, never merely mounted (issue #5039).
  const impressionRef = useImpressionTracker(() => { if (onImpression) onImpression(); });

  if (status === 'success') {
    return (
      <p className="inline-flex items-center gap-2 text-sm font-semibold text-success">
        <Check className="w-4 h-4" aria-hidden="true" />
        {t('jobAlert.jobMatchCta.success', 'Alert attivato ✓')}
      </p>
    );
  }

  return (
    <div ref={impressionRef}>
      <button
        type="button"
        onClick={handleClick}
        disabled={status === 'submitting'}
        aria-busy={status === 'submitting'}
        className="inline-flex items-center gap-2 px-3 py-1.5 min-h-[44px] text-sm font-semibold rounded-full border border-accent-border bg-surface text-accent hover:bg-accent-subtle transition-colors disabled:opacity-60"
      >
        {status === 'submitting' ? (
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        ) : (
          <BellRing className="w-4 h-4" aria-hidden="true" />
        )}
        {t('jobAlert.jobMatchCta.cta', 'Avvisami per ruoli come questo')}
      </button>
      {status === 'error' && (
        <p className="mt-2 text-xs text-danger">
          {t('jobAlert.jobMatchCta.error', "Non sono riuscito a creare l'alert. Riprova.")}
        </p>
      )}
    </div>
  );
}
