/**
 * Pending save-job intent — survives the auth round-trip, including a
 * magic-link email that opens in a BRAND NEW tab (SaveSignInPromptModal's
 * email path, `services/newsletterSubscribers.ts` confirm-and-autologin).
 *
 * A ref-based stash (`useRef` in JobBoard.tsx) works for the Google/LinkedIn
 * popup case (same tab, same component instance) but is silently lost when
 * the auth completion happens in a fresh tab — nothing there ever set the
 * ref. Storage/TTL mechanics live in services/pendingIntentStore.ts, shared
 * with services/pendingJobAlert.ts (same auth-round-trip problem, different
 * payload) — localStorage (not sessionStorage) so it survives across tabs.
 *
 * Two intents share this store because both are stashed by the same modal:
 * a bookmark tap on a specific job, or the "Salvati" filter pill tap (no
 * job attached, just "turn the filter on once signed in").
 */

import type { SavedJobEntry } from '@/services/savedJobsService';
import { saveIntent, consumeIntent, peekIntent } from '@/services/pendingIntentStore';

const KEY = 'pending_save_job';

/**
 * Where the bookmark was tapped. `detail` and `detail_gate` are the same
 * control on the same page but two different readers — the gate one has no
 * account yet and competes for the click with the sign-in form right under it,
 * so folding them together would hide the gate's much lower completion rate
 * inside the unlocked detail's rate. Same separation as
 * `company_follow_gate` / `company_follow_button`.
 */
export type SaveJobSurface = 'list' | 'detail' | 'detail_gate';

export type PendingSaveJobIntent =
  | { kind: 'save_job'; entry: Omit<SavedJobEntry, 'savedAt'>; surface: SaveJobSurface }
  | { kind: 'show_saved_only' };

export function savePendingSaveJobIntent(intent: PendingSaveJobIntent): void {
  saveIntent(KEY, intent);
}

/**
 * Return the pending intent and clear it, but only if saved within the TTL.
 * Returns null when absent, expired, or malformed.
 */
export function consumePendingSaveJobIntent(): PendingSaveJobIntent | null {
  return consumeIntent<PendingSaveJobIntent>(KEY);
}

/**
 * Read the pending intent WITHOUT clearing it — used when the modal is
 * dismissed (e.g. to log which job_id the dismiss applied to) while an
 * email-confirmation link may still be in flight and must still replay
 * later.
 */
export function peekPendingSaveJobIntent(): PendingSaveJobIntent | null {
  return peekIntent<PendingSaveJobIntent>(KEY);
}
