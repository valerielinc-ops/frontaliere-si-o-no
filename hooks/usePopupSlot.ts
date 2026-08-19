/**
 * usePopupSlot — the React half of `services/popupQueue.ts`.
 *
 * The queue has existed for a while and eight surfaces route through it
 * (CookieBanner, NewsletterPopup, AiChatbot, FeatureSurvey, GamificationWidget,
 * the two JobBoard auth gates, the guide banners). Every one of them hand-rolls
 * the same four lines:
 *
 *   requestSlot(id, priority)
 *   setActive(isActive(id))
 *   const unsub = subscribe(() => setActive(isActive(id)))
 *   return () => { unsub(); releaseSlot(id) }
 *
 * Copied eight times, it drifted: two call sites never release on unmount, one
 * subscribes before requesting. More to the point, copying it is enough work
 * that the five bottom-anchored job/alert prompts simply did not — which is the
 * defect `components/shared/BottomPromptShell.tsx` exists to close.
 *
 * `active` is the ONLY thing a caller needs: render when it is true, render
 * nothing when it is false. The slot is requested on mount and released on
 * unmount, so a prompt that disappears for its own reasons (dismissed, expired,
 * route changed) hands the queue back without remembering to.
 */
import { useEffect, useState } from 'react';

import { isActive, releaseSlot, requestSlot, subscribe } from '@/services/popupQueue';

export function usePopupSlot(slotId: string, priority: number): boolean {
  // Seeded from the queue rather than `false`: a slot that is free on the very
  // first render must not cost the prompt a paint, and the queue is a plain
  // module singleton so reading it during render is safe.
  const [active, setActive] = useState<boolean>(() => {
    // Do NOT request here — a render can be discarded (StrictMode, Suspense
    // replay) and a request made outside an effect would never be released.
    return isActive(slotId);
  });

  useEffect(() => {
    requestSlot(slotId, priority);
    setActive(isActive(slotId));
    const unsubscribe = subscribe(() => setActive(isActive(slotId)));
    return () => {
      unsubscribe();
      releaseSlot(slotId);
    };
  }, [priority, slotId]);

  return active;
}

export default usePopupSlot;
