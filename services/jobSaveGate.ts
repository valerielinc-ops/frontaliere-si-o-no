/**
 * The one save-job action: a bookmark on ANY job card, in any surface, goes
 * through here. Signed in → toggle; anonymous → stash the intent, ask for an
 * account, and replay the save once sign-in completes.
 *
 * This lived inside JobBoard, which is not mounted on the `staticOverlay` SEO
 * pages (`/aziende/<slug>/`, hubs, landings): a card there had nobody to open
 * the modal or replay the intent. It is plain module state so that App.tsx
 * (auth + replay), `JobSaveMount` (the modal) and every button share it without
 * a provider around surfaces that are not even in the same React subtree — a
 * static-page island is a portal.
 */

import { Analytics } from '@/services/analytics';
import { POPUP_PRIORITY, releaseSlot, requestSlot } from '@/services/popupQueue';
import {
  consumePendingSaveJobIntent,
  peekPendingSaveJobIntent,
  savePendingSaveJobIntent,
  type PendingSaveJobIntent,
  type SaveJobSurface,
} from '@/services/pendingSaveJob';
import { ensureSavedJob, toggleSavedJob, type SavedJobEntry } from '@/services/savedJobsService';

export type SaveableJob = Omit<SavedJobEntry, 'savedAt'>;

/** The fields of a saved entry, from whatever job record a card holds. */
export function toSaveableJob(job: {
  id: string;
  slug?: string | null;
  title: string;
  company: string;
  canton?: string | null;
  category?: string | null;
}): SaveableJob {
  return {
    id: job.id,
    slug: job.slug ?? null,
    title: job.title,
    company: job.company,
    canton: job.canton ?? null,
    category: job.category ?? null,
  };
}

const PROMPT_SLOT = 'save-auth-prompt';

let currentUid: string | null = null;
let promptOpen = false;
const promptListeners = new Set<() => void>();

// Issue 9575 (sibling of the job-alert form): when localStorage cannot hold the
// pending intent, keep it in memory. The sign-in modal opens in THIS tab, so an
// in-tab sign-in still replays the save; only a link opened in another tab has
// no channel to it. Every reader below falls back to this.
let pendingFallback: PendingSaveJobIntent | null = null;

function setPromptOpen(open: boolean): void {
  if (promptOpen === open) return;
  promptOpen = open;
  for (const listener of promptListeners) listener();
}

export function isSavePromptOpen(): boolean {
  return promptOpen;
}

export function subscribeSavePrompt(listener: () => void): () => void {
  promptListeners.add(listener);
  return () => {
    promptListeners.delete(listener);
  };
}

export function peekPendingSave(): PendingSaveJobIntent | null {
  return peekPendingSaveJobIntent() ?? pendingFallback;
}

function consumePendingSave(): PendingSaveJobIntent | null {
  const intent = consumePendingSaveJobIntent() ?? pendingFallback;
  pendingFallback = null;
  return intent;
}

function stashPendingSave(intent: PendingSaveJobIntent): boolean {
  const stored = savePendingSaveJobIntent(intent);
  pendingFallback = stored ? null : intent;
  return stored;
}

/**
 * AUTH_GATE priority preempts the (lower-priority) newsletter popup — without a
 * queue slot, NewsletterPopup's own timer/exit-intent trigger can claim the
 * empty queue and render its full-screen overlay on top of this modal.
 */
export function openSavePrompt(): void {
  requestSlot(PROMPT_SLOT, POPUP_PRIORITY.AUTH_GATE);
  setPromptOpen(true);
}

function closeSavePrompt(): void {
  releaseSlot(PROMPT_SLOT);
  setPromptOpen(false);
}

/** "Salvati" filter pill: same modal, no job attached. */
export function requestSavedFilterSignIn(): boolean {
  const pendingStored = stashPendingSave({ kind: 'show_saved_only' });
  openSavePrompt();
  return pendingStored;
}

/**
 * Tap on a bookmark. Anonymous tap never writes: the intent is stashed in
 * services/pendingSaveJob.ts (localStorage, survives a magic-link email opened
 * in a brand new tab) and the sign-in modal opens.
 *
 * `uid` defaults to the App-level auth state; JobBoard passes its own so the
 * board keeps reading the identity it renders with.
 */
export function requestJobSave(
  job: SaveableJob,
  surface: SaveJobSurface,
  uid: string | null = currentUid,
): void {
  if (!uid) {
    const pendingStored = stashPendingSave({ kind: 'save_job', entry: job, surface });
    openSavePrompt();
    Analytics.trackEvent('save_signin_prompt_shown', { job_id: job.id, surface, pending_stored: pendingStored });
    return;
  }
  const result = toggleSavedJob(job, uid);
  Analytics.trackEvent(result === 'saved' ? 'job_saved' : 'job_unsaved', {
    job_id: job.id,
    job_canton: job.canton || '(none)',
    job_category: job.category || '(none)',
    job_company: job.company || '(none)',
    surface,
  });
}

/**
 * Follows the auth state, from App.tsx so it runs on every page. Replays a
 * pending bookmark as soon as a uid exists — gated ONLY on uid, because the
 * email magic-link path can complete sign-in in a brand new tab where the modal
 * was never rendered. ensureSavedJob (not toggleSavedJob) so a second tab
 * replaying the same intent around the same time can't race a genuine toggle
 * back off.
 *
 * `show_saved_only` is left in place: only JobBoard can turn its filter on
 * (`consumePendingSavedFilter`).
 */
export function syncJobSaveAuth(uid: string | null): void {
  currentUid = uid;
  if (!uid) return;
  closeSavePrompt();
  if (peekPendingSave()?.kind !== 'save_job') return;
  const intent = consumePendingSave();
  if (intent?.kind !== 'save_job') return;
  Analytics.trackEvent('save_signin_prompt_completed', { job_id: intent.entry.id, surface: intent.surface });
  if (ensureSavedJob(intent.entry, uid) === 'saved') {
    Analytics.trackEvent('job_saved', {
      job_id: intent.entry.id,
      job_canton: intent.entry.canton || '(none)',
      job_category: intent.entry.category || '(none)',
      job_company: intent.entry.company || '(none)',
      surface: intent.surface,
    });
  }
}

/** True when a filter-pill sign-in was pending: the caller turns the filter on. */
export function consumePendingSavedFilter(): boolean {
  if (peekPendingSave()?.kind !== 'show_saved_only') return false;
  consumePendingSave();
  Analytics.trackEvent('save_signin_prompt_completed', { surface: 'saved_filter_pill' });
  return true;
}

/**
 * Dismiss only closes the modal — it does NOT clear the pending intent. The
 * email path is inherently async (the link may be clicked later, in another
 * tab); closing the "check your email" card isn't abandonment. The 15-minute
 * TTL in pendingSaveJob.ts handles true abandonment.
 */
export function dismissSavePrompt(): void {
  const intent = peekPendingSave();
  Analytics.trackEvent(
    'save_signin_prompt_dismissed',
    intent?.kind === 'save_job' ? { job_id: intent.entry.id, surface: intent.surface } : { surface: 'saved_filter_pill' },
  );
  closeSavePrompt();
}

/** Test-only reset of the module state. */
export function _resetJobSaveGateForTests(): void {
  currentUid = null;
  promptOpen = false;
  pendingFallback = null;
  promptListeners.clear();
}
