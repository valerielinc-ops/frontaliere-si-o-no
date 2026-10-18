import { useCallback, useRef, useState } from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap, stripKeywordEmoji } from '@/services/jobAlertService';
import type { JobAlertConfig, JobAlertOneTapFilters } from '@/services/jobAlertService';
import { openJobAlertForm } from '@/services/jobAlertOpenSignal';
import { savePendingJobAlert, type PendingJobAlertOrigin } from '@/services/pendingJobAlert';
import { useImpressionTracker } from '@/hooks/useImpressionTracker';

export type JobBoardFilterAlertCtaStatus = 'idle' | 'submitting' | 'success' | 'error';
export type JobBoardFilterAlertCtaContext = 'category' | 'sector' | 'search';

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
  /** Authenticated user id, or null for the existing form/pending-intent path. */
  userId?: string | null;
  /** Authenticated user email, or null for the existing form/pending-intent path. */
  email?: string | null;
  /** Active locale — passed straight to the alert config. */
  locale: Locale;
  /** Localized profession/search label used as both keyword and CTA copy. */
  keywordLabel: string;
  /** Whether the active filter is a category, sector, or free-text search. */
  context?: JobBoardFilterAlertCtaContext;
  /** 2-letter canton code from the current board route, or null (all cantons). */
  cantonCode?: string | null;
  /** Called on a successful create (analytics / gating side-effects). */
  onSubscribed?: () => void;
  /** Called once on a direct one-tap action, before the create request starts. */
  onAccepted?: () => void;
  /** Called when subscribe throws. */
  onErrored?: (error: unknown) => void;
  /** Called when an anonymous visitor hands off to the mounted JobAlertForm. */
  onAnonymousOpen?: () => void;
  /** Called after an anonymous one-tap intent is safely parked for auth replay. */
  onAnonymousAuthRequired?: () => void;
  /** Surface to preserve when an anonymous tap is handed to JobAlertForm. */
  formOrigin?: PendingJobAlertOrigin;
  /** Active board filters supported by `JobAlertConfig`. */
  filters?: JobAlertOneTapFilters;
  /** Fired ONCE, the first time this CTA is genuinely visible in the viewport.
   * Deliberately not a mount callback: this surface renders inside a long job
   * list most visitors never scroll to, and firing on mount is what inflated the
   * `job_alert_cta_shown` denominator of the alert_funnel_conversion goal with
   * impressions nobody ever saw (issue #5039). */
  onImpression?: () => void;
  /** Optional override for the subscribe call (used by tests). */
  subscribe?: typeof subscribeJobAlertOneTap;
}

export default function JobBoardFilterAlertCta({
  userId,
  email,
  locale,
  keywordLabel,
  context = 'search',
  cantonCode,
  onSubscribed,
  onAccepted,
  onErrored,
  onAnonymousOpen,
  onAnonymousAuthRequired,
  formOrigin,
  filters,
  onImpression,
  subscribe = subscribeJobAlertOneTap,
}: JobBoardFilterAlertCtaProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<JobBoardFilterAlertCtaStatus>('idle');
  const submissionStartedRef = useRef(false);

  const handleAnonymousOpen = useCallback(() => {
    if (!keywordLabel) return;
    // This CTA is the anonymous equivalent of the authenticated one-tap path:
    // park the exact criteria before entering the existing auth screen, so the
    // JobAlertForm can create the alert automatically after the auth round-trip.
    // If storage is unavailable, keep the old form hand-off instead of sending
    // the visitor through auth with no replayable intent.
    const keyword = stripKeywordEmoji(keywordLabel);
    if (onAnonymousAuthRequired && keyword) {
      const config: JobAlertConfig = {
        keywords: [keyword],
        locations: [...(filters?.locations ?? [])],
        contractTypes: [...(filters?.contractTypes ?? [])],
        sectors: [...(filters?.sectors ?? [])],
        cantonFilter: cantonCode ? [cantonCode] : null,
        frequency: 'weekly',
        locale,
      };
      const saved = savePendingJobAlert(config, formOrigin ?? 'inline_card');
      if (saved.ok) {
        onAnonymousOpen?.();
        return onAnonymousAuthRequired();
      }
    }

    // Notify an already-mounted form and retain the queued request for a lazy
    // mount (for example when the CTA was clicked on a detail route).
    onAnonymousOpen?.();
    openJobAlertForm(keywordLabel, formOrigin);
  }, [cantonCode, filters, formOrigin, keywordLabel, locale, onAnonymousAuthRequired, onAnonymousOpen]);

  const handleClick = useCallback(async () => {
    if (!keywordLabel) return;
    if (!userId || !email) {
      handleAnonymousOpen();
      return;
    }
    if (submissionStartedRef.current) return;
    submissionStartedRef.current = true;
    setStatus('submitting');
    try {
      // Telemetry must not prevent the requested alert from being created.
      try { onAccepted?.(); } catch { /* best-effort analytics */ }
      // No `source` job to attribute — this CTA is driven by board filters,
      // not one specific job listing (same as JobMatchAlertCta.tsx).
      await subscribe(userId, email, keywordLabel, locale, undefined, cantonCode ?? null, {
        email,
        source: 'job_alert_filter_cta',
        sourceChannel: 'job_alert_filter_cta',
        sourcePage: typeof window !== 'undefined' ? window.location.pathname : null,
        sourceCta: 'job_alert_filter_cta',
        sourceComponent: 'JobBoardFilterAlertCta',
        sourceRouteFamily: 'job-board',
        locale,
      }, filters);
      setStatus('success');
      if (onSubscribed) onSubscribed();
    } catch (error: unknown) {
      submissionStartedRef.current = false;
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [cantonCode, email, filters, handleAnonymousOpen, keywordLabel, locale, onAccepted, onErrored, onSubscribed, subscribe, userId]);

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
        {context === 'category'
          ? t('jobAlert.boardFilterCta.category', 'Segui questa categoria')
          : context === 'sector'
          ? t('jobAlert.boardFilterCta.sector', 'Segui questo settore')
          : t('jobAlert.boardFilterCta.cta', 'Avvisami per questa ricerca')}
      </button>
      {status === 'error' && (
        <p className="mt-2 text-xs text-danger">
          {t('jobAlert.boardFilterCta.error', "Non sono riuscito a creare l'alert. Riprova.")}
        </p>
      )}
    </div>
  );
}
