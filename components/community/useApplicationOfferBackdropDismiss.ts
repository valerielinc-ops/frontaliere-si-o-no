import { useCallback, useRef, type MouseEvent } from 'react';

/**
 * A double click on "Candidati" lands its second click on the backdrop of the
 * application offer it just opened. Backdrop dismissals inside this window
 * belong to that same gesture, so they are ignored; the close button and
 * Escape keep working immediately.
 */
export const APPLICATION_OFFER_BACKDROP_GRACE_MS = 600;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Backdrop click handler for the application offer dialogs. */
export function useApplicationOfferBackdropDismiss(onDismiss: (() => void) | undefined) {
  const openedAtRef = useRef<number | null>(null);
  if (openedAtRef.current === null) openedAtRef.current = now();

  return useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (now() - (openedAtRef.current ?? 0) < APPLICATION_OFFER_BACKDROP_GRACE_MS) return;
    onDismiss?.();
  }, [onDismiss]);
}
