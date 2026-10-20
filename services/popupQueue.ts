/**
 * Popup Queue — prevents overlapping popups/toasts/banners.
 *
 * Components register themselves via `requestSlot(id, priority)` and receive
 * a boolean back indicating whether they are the current active popup.
 * Only one popup is active at a time. When the active popup is released
 * via `releaseSlot(id)`, the next highest-priority queued popup is promoted.
 *
 * Priority levels (higher = more urgent, shows first):
 * 100 Achievement toast (short-lived, 3.5s — should interrupt)
 * 60 Guide welcome banner (contextual, auto-dismiss 15s)
 * 30 Preferred Sources article popup
 * 20 Newsletter popup (least urgent, can wait)
 *
 * Components should:
 * 1. Call `requestSlot(id, priority)` when they want to show
 * 2. Subscribe to changes via `subscribe(listener)`
 * 3. Only render visible UI when `isActive(id)` returns true
 * 4. Call `releaseSlot(id)` when dismissed / auto-hidden
 */

type Listener = () => void;

interface QueueEntry {
 id: string;
 priority: number;
 requestedAt: number;
 shown?: boolean;
}

let queue: QueueEntry[] = [];
let activeId: string | null = null;
let activePriority: number | null = null;
const listeners = new Set<Listener>();
let promotionTimer: ReturnType<typeof setTimeout> | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

// Explicit unsolicited surfaces only: consent, auth, user-opened dialogs and
// action feedback must never inherit a promotional delay from their priority.
const PROMOTIONAL_IDS = new Set([
 'newsletter-popup', 'feature-survey', 'guide-banner', 'job-detail-alert-prompt',
 'saved-jobs-alert-nudge', 'profile-enrichment-prompt', 'job-alert-sticky-banner',
 'preferred-source-popup',
]);
function isPromotional(id: string): boolean {
 return PROMOTIONAL_IDS.has(id) || id.startsWith('company-follow-prompt:');
}
function eligible(entry: QueueEntry): boolean {
 if (!isPromotional(entry.id) || entry.id === activeId) return true;
 // Do not swap two offers during the frame before the visible owner reports
 // onShown. Urgent/non-promotional surfaces can still preempt immediately.
 if (activeId && isPromotional(activeId) && queue.some((e) => e.id === activeId)) return false;
 return canShowPromotionalPrompt();
}
function scheduleCooldown() {
 if (cooldownTimer !== null) clearTimeout(cooldownTimer);
 cooldownTimer = null;
 if (activeId !== null || !queue.length) return;
 const remaining = promotionalDelay();
 if (!remaining) return;
 cooldownTimer = setTimeout(() => {
  cooldownTimer = null;
  if (activeId === null) promoteNext();
 }, remaining);
}

function notify() {
 listeners.forEach((fn) => {
 try { fn(); } catch { /* noop */ }
 });
}

function cancelPromotionTimer() {
 if (promotionTimer === null) return;
 clearTimeout(promotionTimer);
 promotionTimer = null;
}

function setActive(id: string | null, priority: number | null) {
 const changed = activeId !== id || activePriority !== priority;
 activeId = id;
 activePriority = priority;
 if (changed) notify();
}

function highestQueuedEntry(): QueueEntry | undefined {
 queue.sort((a, b) => b.priority - a.priority || a.requestedAt - b.requestedAt);
 return queue.find(eligible);
}

function reconcileActiveRequest(id: string, priority: number): boolean {
 const candidate = highestQueuedEntry();
 const next = candidate && candidate.id !== id && candidate.priority > priority
  ? candidate
  : { id, priority };
 cancelPromotionTimer();
 setActive(next.id, next.priority);
 return next.id === id;
}

function promoteNext() {
 cancelPromotionTimer();
 if (queue.length === 0) {
 setActive(null, null);
 return;
 }
 // Brief delay so the previous popup's exit doesn't visually collide with the next
 promotionTimer = setTimeout(() => {
 promotionTimer = null;
 if (queue.length === 0) {
 setActive(null, null);
 return;
 }
 const next = highestQueuedEntry();
 setActive(next?.id ?? null, next?.priority ?? null);
 scheduleCooldown();
 }, 500);
}

/**
 * Request a popup slot. Returns true if immediately active.
 * If another popup is showing, the request is queued.
 */
export function requestSlot(id: string, priority: number): boolean {
 // Already in queue? Update priority
 const existing = queue.find((e) => e.id === id);
 if (existing) {
 existing.priority = priority;
 if (activeId === id) {
 return reconcileActiveRequest(id, priority);
 }
 // Re-evaluate if this should preempt current
 if (activeId) {
 const currentEntry = queue.find((e) => e.id === activeId);
 const currentPriority = currentEntry?.priority ?? activePriority;
 if (currentPriority !== null && priority > currentPriority && eligible(existing)) {
 cancelPromotionTimer();
 activeId = id;
 activePriority = priority;
 notify();
 return true;
 }
 }
 return false;
 }

 const entry = { id, priority, requestedAt: Date.now() };
 queue.push(entry);

 // The released owner remains visible during the exit window. If it
 // re-requests with a new priority, include that candidate in the same
 // arbitration pass instead of leaving a stale activeId until the timer.
 if (promotionTimer !== null && activeId === id) {
 // A new mount is a new offer, even while the old owner's exit animation
 // retains its id. It must not bypass the cap by reusing that id.
 if (isPromotional(id) && !canShowPromotionalPrompt()) {
 setActive(null, null);
 return false;
 }
 return reconcileActiveRequest(id, priority);
 }

 if (activeId === null) {
 if (eligible(entry)) {
 setActive(id, priority);
 return true;
 }
 scheduleCooldown();
 return false;
 }

 // Preempt if higher priority than current
 const currentEntry = queue.find((e) => e.id === activeId);
 const currentPriority = currentEntry?.priority ?? activePriority;
 if (currentPriority !== null && priority > currentPriority && eligible(entry)) {
 cancelPromotionTimer();
 setActive(id, priority);
 return true;
 }

 return false;
}

/**
 * Release a popup slot. The popup is removed from the queue and
 * the next highest-priority popup is promoted.
 */
export function releaseSlot(id: string) {
 queue = queue.filter((e) => e.id !== id);
 if (!queue.length && cooldownTimer !== null) {
 clearTimeout(cooldownTimer);
 cooldownTimer = null;
 }
 if (activeId === id) {
  promoteNext();
 } else if (queue.length === 0 && promotionTimer !== null) {
 cancelPromotionTimer();
 setActive(null, null);
 }
}

/** Check if a specific popup is the currently active one. */
export function isActive(id: string): boolean {
 return activeId === id;
}

/** Returns true when any popup is currently active. */
export function hasActiveSlot(excludeId?: string): boolean {
 if (!activeId) return false;
 if (excludeId && activeId === excludeId) return false;
 return true;
}

/** Returns the id of the currently active popup (or null). */
export function getActiveSlotId(): string | null {
 return activeId;
}

/** Subscribe to queue changes. Returns unsubscribe function. */
export function subscribe(listener: Listener): () => void {
 listeners.add(listener);
 return () => { listeners.delete(listener); };
}

/**
 * Priority constants.
 *
 * The bottom-anchored `*_PROMPT`/`*_NUDGE`/`*_BANNER` values below are the
 * job/alert family (components/shared/BottomPromptShell.tsx). They sit between
 * the guide banner and the newsletter popup, and they are ordered by how much
 * the visitor's CURRENT action justifies the interruption:
 *
 *  · JOB_DETAIL_PROMPT — they are reading one ad in a category. Most specific
 *    offer we can make, and the only one tied to what is on screen right now.
 *  · SAVED_JOBS_NUDGE — they just saved a fourth job. Strong signal, but it is
 *    about a list rather than the thing they are looking at.
 *  · PROFILE_ENRICHMENT — they already have an alert; this improves it. Real
 *    value, no new subscription, so it yields to both asks above.
 *  · JOB_ALERT_STICKY — scroll-depth only. It knows nothing about intent and is
 *    the one that should wait.
 *  · COMPANY_FOLLOW_PROMPT — the URL names exactly one employer, so this is
 *    more relevant than a category prompt (55), but still an unsolicited ask:
 *    it yields to cookie/consent (85) and auth gates (80+).
 *  · PREFERRED_SOURCE — article context makes the ask relevant, but it is less
 *    urgent than a job or company action and should yield to those prompts.
 *
 * All bottom prompts are below `COOKIE_CONSENT` and `AUTH_GATE` on purpose: a consent
 * banner or a sign-in gate is not an offer that can be postponed.
 *
 * `REWARDED_APPLICATION_OFFER` holds the queue while the rewarded application
 * dialog, and the Google video it opens, is on screen. Site prompts yield
 * without changing Google ad visibility. Only the chatbot panel, which
 * the visitor opens deliberately, ranks above it.
 */
export const POPUP_PRIORITY = {
 CHATBOT_PANEL: 120,
 REWARDED_APPLICATION_OFFER: 115,
 INLINE_AUTH_GATE: 110,
 ACHIEVEMENT_TOAST: 100,
 EASTER_EGG_TOAST: 90,
 COOKIE_CONSENT: 85,
 AUTH_GATE: 80,
 GUIDE_BANNER: 60,
 COMPANY_FOLLOW_PROMPT: 60,
 JOB_DETAIL_PROMPT: 55,
 SAVED_JOBS_NUDGE: 50,
 PROFILE_ENRICHMENT: 45,
 JOB_ALERT_STICKY: 40,
 PREFERRED_SOURCE: 30,
 NEWSLETTER: 20,
} as const;

/** Shared frequency cap for unsolicited promotions. Auth/consent never use it. */
const PROMOTIONAL_PROMPT_KEY = 'ft_promotional_prompt_at';
let lastPromotionalPromptAt = 0;
function promotionalDelay(now = Date.now()): number {
  let last = lastPromotionalPromptAt;
  try { last = Math.max(last, Number(sessionStorage.getItem(PROMOTIONAL_PROMPT_KEY)) || 0); } catch { /* storage optional */ }
  return last ? Math.max(0, 60_000 - (now - last)) : 0;
}
export function canShowPromotionalPrompt(now = Date.now()): boolean {
  return promotionalDelay(now) === 0;
}
/** Visibility acknowledgement: queued/unmounted requests do not spend the cap. */
export function markSlotShown(id: string): void {
 const entry = queue.find((item) => item.id === id);
 if (activeId !== id || !entry || entry.shown || !isPromotional(id)) return;
 entry.shown = true;
 markPromotionalPromptShown();
}
export function markPromotionalPromptShown(now = Date.now()): void {
  lastPromotionalPromptAt = now;
  try { sessionStorage.setItem(PROMOTIONAL_PROMPT_KEY, String(now)); } catch { /* storage optional */ }
}
