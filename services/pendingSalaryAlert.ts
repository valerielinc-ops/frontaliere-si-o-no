/**
 * Pending calculator salary-alert intent.
 *
 * This is deliberately separate from the generic job-board alert intent:
 * signing in from the calculator must replay only the explicit salary-alert
 * request and must never consume an unrelated alert created on the board.
 * The shared intent store supplies the same 15-minute TTL and storage guards
 * as the other authentication round-trips.
 */

import type { JobAlertConfig } from '@/services/jobAlertService';
import { saveIntent, consumeIntent, clearIntent } from '@/services/pendingIntentStore';

const KEY = 'pending_salary_alert';

/**
 * Returns whether the intent is readable back after the auth round-trip
 * (issue 9575, same class as pendingJobAlert.ts): `false` means private mode /
 * quota / a storage shim, and the caller must keep its own recovery path.
 */
export function savePendingSalaryAlert(config: JobAlertConfig): boolean {
  return saveIntent(KEY, config);
}

/** Read and clear a still-valid calculator alert intent. */
export function consumePendingSalaryAlert(): JobAlertConfig | null {
  return consumeIntent<JobAlertConfig>(KEY);
}

export function clearPendingSalaryAlert(): void {
  clearIntent(KEY);
}
