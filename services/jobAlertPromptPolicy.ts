/** Shared company/category prompt cap, including storage-refused sessions. */
const SEEN_KEY = 'ft_job_alert_prompt_seen';
const DISMISSED_KEY = 'ft_job_alert_prompt_dismissed';
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
let shown = false;
let dismissedAt = 0;

export function canShowJobAlertPrompt(now = Date.now()): boolean {
 try {
  shown ||= sessionStorage.getItem(SEEN_KEY) === '1';
  dismissedAt = Math.max(dismissedAt, Number(localStorage.getItem(DISMISSED_KEY)) || 0);
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
