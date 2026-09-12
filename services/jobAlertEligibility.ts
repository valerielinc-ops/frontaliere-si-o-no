import type { JobAlert } from './jobAlertService';
import { normalizeKeyword } from './jobAlertKeyword';
import { fetchUserAlertsCached } from './userAlertsCache';

export type JobAlertEligibilityReason = 'already_subscribed' | 'quota_full';

export interface JobAlertEligibility {
  eligible: boolean;
  reason: JobAlertEligibilityReason | null;
}

/**
 * Resolve the one-tap CTA gate from one cached alert snapshot.
 *
 * The matching rule deliberately mirrors `findMatchingAlertForCategory` but
 * stays in this small resolver so all three lazy surfaces share the same
 * decision before they render or emit an impression.
 */
export function resolveJobAlertEligibility(
  alerts: Pick<JobAlert, 'active' | 'keywords'>[],
  keyword: string,
  maxAlerts: number,
): JobAlertEligibility {
  const target = normalizeKeyword(keyword);
  const activeAlerts = alerts.filter((alert) => Boolean(alert.active));
  const alreadySubscribed = Boolean(target) && alerts.some((alert) => (
    Boolean(alert.active)
    && (alert.keywords || []).some((candidate) => normalizeKeyword(candidate) === target)
  ));
  if (alreadySubscribed) return { eligible: false, reason: 'already_subscribed' };
  if (activeAlerts.length >= maxAlerts) return { eligible: false, reason: 'quota_full' };
  return { eligible: true, reason: null };
}

/** Read alerts through the shared session cache, then apply the common gate. */
export async function getJobAlertEligibility(
  userId: string,
  keyword: string,
): Promise<JobAlertEligibility> {
  const { getUserAlerts, MAX_ALERTS_PER_USER } = await import('./jobAlertService');
  const alerts = await fetchUserAlertsCached(userId, getUserAlerts);
  return resolveJobAlertEligibility(alerts, keyword, MAX_ALERTS_PER_USER);
}
