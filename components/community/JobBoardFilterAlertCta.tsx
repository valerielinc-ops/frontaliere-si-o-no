import { useCallback, useState } from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap, upgradeBackfilledAlertConsent } from '@/services/jobAlertService';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { useImpressionTracker } from '@/hooks/useImpressionTracker';

export type JobBoardFilterAlertCtaStatus = 'idle' | 'submitting' | 'success' | 'error';

/**
 * One-tap "Avvisami per questa ricerca" CTA (issue #4298).
 *
 * Job board with active filters (profession dropdown and/or free-text search)
 * is a real intent signal, same class as the job-match personalization pill
 * (`JobMatchAlertCta.tsx`, issue #3650) — the user already told us what they
 * want. For an authenticated user this creates the alert directly from that
 * signal in a single tap; the (opt-in, keyword-only-by-default) `JobAlertForm`
 * stays available underneath for anyone who wants to add locations/contract
 * type/sectors before submitting.
 *
 * Deliberately reuses `subscribeJobAlertOneTap` — the exact helper the
 * job-detail and job-match-pill one-tap surfaces already use — instead of a
 * new service function, so this surface inherits the same engine-managed
 * frequency default and canton hard-scope validation.
 */
export interface JobBoardFilterAlertCtaProps {
  /** Authenticated user id. */
  userId: string;
  /** Authenticated user email. */
  email: string;
  /** Active locale — passed straight to the alert config. */
  locale: Locale;
  /** Localized profession/search label used as both keyword and CTA copy. */
  keywordLabel: string;
  /** 2-letter canton code from the current board route, or null (all cantons). */
  cantonCode?: string | null;
  /** Called on a successful create (analytics / gating side-effects). */
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
  /** Optional override for the consent-proof upgrade (used by tests). */
  upgradeConsent?: typeof upgradeBackfilledAlertConsent;
}

export default function JobBoardFilterAlertCta({
  userId,
  email,
  locale,
  keywordLabel,
  cantonCode,
  onSubscribed,
  onErrored,
  onImpression,
  subscribe = subscribeJobAlertOneTap,
  upgradeConsent = upgradeBackfilledAlertConsent,
}: JobBoardFilterAlertCtaProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JobBoardFilterAlertCtaStatus>('idle');

  const handleClick = useCallback(async () => {
    if (!keywordLabel) return;
    setStatus('submitting');
    try {
      // No `source` job to attribute — this CTA is driven by board filters,
      // not one specific job listing (same as JobMatchAlertCta.tsx).
      await subscribe(userId, email, keywordLabel, locale, undefined, cantonCode ?? null);
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
  }, [cantonCode, email, keywordLabel, locale, onErrored, onSubscribed, subscribe, upgradeConsent, userId]);

  // Impression = genuinely on screen, never merely mounted (issue #5039).
  const impressionRef = useImpressionTracker(() => { if (onImpression) onImpression(); });

  if (status === 'success') {
    return (
      <p className="inline-flex items-center gap-2 text-sm font-semibold text-success">
        <Check className="w-4 h-4" aria-hidden="true" />
        {t('jobAlert.boardFilterCta.success', 'Alert attivato ✓')}
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
        {t('jobAlert.boardFilterCta.cta', 'Avvisami per questa ricerca')}
      </button>
      <ConsentNotice
        consentKey="communicationsOptIn"
        locale={locale}
        className="mt-2 text-[11px] text-muted leading-relaxed block"
      />
      {status === 'error' && (
        <p className="mt-2 text-xs text-danger">
          {t('jobAlert.boardFilterCta.error', "Non sono riuscito a creare l'alert. Riprova.")}
        </p>
      )}
    </div>
  );
}
