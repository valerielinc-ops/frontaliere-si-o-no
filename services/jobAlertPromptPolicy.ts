import { isDismissalActive, parseDismissalTimestamp } from './newsletterCtaState';

/** Shared company/category prompt cap, including storage-refused sessions. */
const SEEN_KEY = 'ft_job_alert_prompt_seen';
export const DISMISSED_KEY = 'ft_job_alert_prompt_dismissed';
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
let shown = false;
let dismissedAt = 0;

export function canShowJobAlertPrompt(now = Date.now()): boolean {
 try {
  shown ||= sessionStorage.getItem(SEEN_KEY) === '1';
  const rawDismissedAt = localStorage.getItem(DISMISSED_KEY);
  const parsedDismissedAt = parseDismissalTimestamp(rawDismissedAt);
  if (parsedDismissedAt !== null
    && isDismissalActive(rawDismissedAt, COOLDOWN_MS / (24 * 60 * 60 * 1000), now)) {
   dismissedAt = Math.max(dismissedAt, parsedDismissedAt);
  }
 } catch { /* Memory preserves the cap when browser storage is refused. */ }
 return !shown && (!dismissedAt || now - dismissedAt >= COOLDOWN_MS);
}

/** Call on actual visibility, never when a prompt is merely queued. */
export function markJobAlertPromptShown(owner = 'unknown'): void {
 shown = true;
 if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ft-job-alert-prompt-shown', { detail: owner }));
 try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* Memory fallback. */ }
}

export function dismissJobAlertPrompt(now = Date.now()): void {
 dismissedAt = now;
 try { localStorage.setItem(DISMISSED_KEY, String(now)); } catch { /* Memory fallback. */ }
}
