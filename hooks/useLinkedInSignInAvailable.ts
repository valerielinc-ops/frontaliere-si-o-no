import { useEffect, useState } from 'react';
import { isLinkedInSignInAvailable } from '@/services/authService';

/**
 * Tri-state LinkedIn sign-in availability for every surface that offers the
 * button: `null` while Remote Config has not answered, then `true`/`false`.
 *
 * Why tri-state (CLS, measured live 2026-10-24 on a job detail, Pixel 5): the
 * surfaces used to start at `false` and mount the button when Remote Config
 * answered ~2s after first paint, pushing everything below it down by the
 * button's height (+56px under the job gate). A surface now renders the button
 * while the value is `null` too, with {@link linkedInPendingClass} holding its
 * box invisible, and drops it only on a definite `false`, so the common
 * answer (enabled) moves nothing.
 *
 * A rejected lookup resolves to `false`, so a pending box is never left
 * behind.
 */
export function useLinkedInSignInAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    isLinkedInSignInAvailable()
      .then((value) => { if (live) setAvailable(value); })
      .catch(() => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, []);
  return available;
}

/**
 * Class suffix for the LinkedIn button (or its wrapper) while availability is
 * still `null`. `invisible` is `visibility: hidden`: the box keeps its size
 * and is neither clickable, focusable nor exposed to assistive technology, so
 * no extra `disabled`/`aria-hidden`/`tabIndex` is needed.
 */
export function linkedInPendingClass(available: boolean | null): string {
  return available ? '' : ' invisible';
}
