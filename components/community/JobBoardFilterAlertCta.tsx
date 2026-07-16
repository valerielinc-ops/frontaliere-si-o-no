import { useCallback, useState } from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap } from '@/services/jobAlertService';

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
  /** Optional override for the subscribe call (used by tests). */
  subscribe?: typeof subscribeJobAlertOneTap;
}

export default function JobBoardFilterAlertCta({
  userId,
  email,
  locale,
  keywordLabel,
  cantonCode,
  onSubscribed,
  onErrored,
  subscribe = subscribeJobAlertOneTap,
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
      if (onSubscribed) onSubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [cantonCode, email, keywordLabel, locale, onErrored, onSubscribed, subscribe, userId]);

  if (status === 'success') {
    return (
      <p className="inline-flex items-center gap-2 text-sm font-semibold text-success">
        <Check className="w-4 h-4" aria-hidden="true" />
        {t('jobAlert.boardFilterCta.success', 'Alert attivato ✓')}
      </p>
    );
  }

  return (
    <div>
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
      {status === 'error' && (
        <p className="mt-2 text-xs text-danger">
          {t('jobAlert.boardFilterCta.error', "Non sono riuscito a creare l'alert. Riprova.")}
        </p>
      )}
    </div>
  );
}
