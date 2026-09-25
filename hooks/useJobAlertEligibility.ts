import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Analytics } from '@/services/analytics';
import {
  getJobAlertEligibility,
  type JobAlertEligibility,
} from '@/services/jobAlertEligibility';

export type JobAlertEligibilitySurface = 'sticky_banner' | 'end_card' | 'job_detail_button';

interface UseJobAlertEligibilityOptions {
  enabled: boolean;
  authResolved: boolean;
  userId: string | null;
  keyword?: string | null;
  surface: JobAlertEligibilitySurface;
}

function reportSkipOnce(
  reportedRef: MutableRefObject<string | null>,
  key: string,
  surface: JobAlertEligibilitySurface,
  reason: 'already_subscribed' | 'quota_full' | 'get_alerts_failed',
): void {
  if (reportedRef.current === key) return;
  reportedRef.current = key;
  Analytics.trackJobAlertCtaSkipped(surface, reason);
}

/**
 * Gate a job-alert CTA before it can render or report an impression.
 *
 * Anonymous users remain eligible: the shared form owns the auth/email
 * conversion path. Known users use the shared per-session alert snapshot, so
 * all three surfaces agree without three Firestore reads.
 */
export function useJobAlertEligibility({
  enabled,
  authResolved,
  userId,
  keyword,
  surface,
}: UseJobAlertEligibilityOptions): boolean | null {
  const normalizedUserId = userId?.trim() || null;
  const normalizedKeyword = keyword?.trim() || '';
  const eligibilityKey = [
    enabled ? 'on' : 'off',
    authResolved ? 'resolved' : 'pending',
    normalizedUserId || 'anonymous',
    normalizedKeyword,
    surface,
  ].join('|');
  const [eligibility, setEligibility] = useState<{
    key: string;
    value: JobAlertEligibility;
  } | null>(null);
  const reportedSkipRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEligibility(null);

    if (!enabled) {
      setEligibility({ key: eligibilityKey, value: { eligible: false, reason: null } });
      return () => { cancelled = true; };
    }
    // Do not render a CTA or count an impression during the auth transition.
    if (!authResolved) return () => { cancelled = true; };
    // The anonymous path is intentional: JobAlertForm can collect auth/email.
    if (!normalizedUserId) {
      setEligibility({ key: eligibilityKey, value: { eligible: true, reason: null } });
      return () => { cancelled = true; };
    }

    getJobAlertEligibility(normalizedUserId, normalizedKeyword)
      .then((next) => {
        if (cancelled) return;
        setEligibility({ key: eligibilityKey, value: next });
        if (!next.eligible && next.reason) {
          reportSkipOnce(
            reportedSkipRef,
            `${surface}:${normalizedUserId}:${normalizedKeyword}:${next.reason}`,
            surface,
            next.reason,
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        setEligibility({ key: eligibilityKey, value: { eligible: false, reason: null } });
        reportSkipOnce(
          reportedSkipRef,
          `${surface}:${normalizedUserId}:${normalizedKeyword}:get_alerts_failed`,
          surface,
          'get_alerts_failed',
        );
      });

    return () => { cancelled = true; };
  }, [authResolved, enabled, eligibilityKey, normalizedKeyword, normalizedUserId, surface]);

  return eligibility?.key === eligibilityKey ? eligibility.value.eligible : null;
}
