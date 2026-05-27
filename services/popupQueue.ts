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
}

let queue: QueueEntry[] = [];
let activeId: string | null = null;
const listeners = new Set<Listener>();

function notify() {
 listeners.forEach((fn) => {
 try { fn(); } catch { /* noop */ }
 });
}

function promoteNext() {
 if (queue.length === 0) {
 activeId = null;
 notify();
 return;
 }
 // Brief delay so the previous popup's exit doesn't visually collide with the next
 setTimeout(() => {
 if (queue.length === 0) {
 activeId = null;
 notify();
 return;
 }
 queue.sort((a, b) => b.priority - a.priority || a.requestedAt - b.requestedAt);
 activeId = queue[0].id;
 notify();
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
 if (activeId === id) return true;
 // Re-evaluate if this should preempt current
 if (activeId) {
 const currentEntry = queue.find((e) => e.id === activeId);
 if (currentEntry && priority > currentEntry.priority) {
 activeId = id;
 notify();
 return true;
 }
 }
 return false;
 }

 queue.push({ id, priority, requestedAt: Date.now() });

 if (activeId === null) {
 activeId = id;
 notify();
 return true;
 }

 // Preempt if higher priority than current
 const currentEntry = queue.find((e) => e.id === activeId);
 if (currentEntry && priority > currentEntry.priority) {
 activeId = id;
 notify();
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
 if (activeId === id) {
 promoteNext();
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

/** Priority constants */
export const POPUP_PRIORITY = {
 CHATBOT_PANEL: 120,
 INLINE_AUTH_GATE: 110,
 ACHIEVEMENT_TOAST: 100,
 EASTER_EGG_TOAST: 90,
 COOKIE_CONSENT: 85,
 AUTH_GATE: 80,
 GUIDE_BANNER: 60,
 NEWSLETTER: 20,
} as const;
