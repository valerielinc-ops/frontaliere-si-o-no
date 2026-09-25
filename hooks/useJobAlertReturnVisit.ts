/**
 * useJobAlertReturnVisit — the one place the site says "this person came back".
 *
 * Issue #5705, owner's decision of 2026-08-14. A job alert that reached the
 * terminal `cadence_state: 'decayed'` comes back to life when the person returns
 * to the site; the decision is taken by the sender (scripts/lib/
 * jobAlertCadence.mjs), and all this hook does is record the fact for it to
 * judge. See services/jobAlertReturnVisit.ts for why the browser is not allowed
 * to decide anything here.
 *
 * WHY ONE HOOK IN App AND NOT A CALL PER SURFACE. "Torna sul sito" is one event,
 * and a second call site is a second definition of it — the shape that has cost
 * this channel three defects already (the click rule with three bodies, #5674 /
 * #5767, and the crawler regex this same PR de-duplicated out of two
 * components). The service throttles itself to one write per browser per day,
 * so mounting it at the root costs one Firestore write on the first identified
 * page view of the day and nothing after it.
 *
 * It runs only for an AUTHENTICATED session, because an unrecognised visit is
 * the sixth of the owner's seven refusals: with no identity there is nobody to
 * reactivate, and the sender checks the recorded uid against the alert's own
 * `userId` before it acts.
 */

import { useEffect } from 'react';

export function useJobAlertReturnVisit(user: { email?: string | null; uid?: string | null } | null | undefined): void {
  const email = user?.email || null;
  const uid = user?.uid || null;

  useEffect(() => {
    if (!email || !uid) return;
    let cancelled = false;
    // Deferred, and never awaited by anything on the render path: this is
    // bookkeeping for a cron that runs tonight, not something the page needs.
    const run = () => {
      if (cancelled) return;
      import('@/services/jobAlertReturnVisit')
        .then((m) => m.recordJobAlertReturnVisit({ email, uid }))
        .catch(() => {});
    };
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    const timer = idle ? idle(run) : window.setTimeout(run, 2000);
    return () => {
      cancelled = true;
      if (!idle) window.clearTimeout(timer as number);
    };
  }, [email, uid]);
}

export default useJobAlertReturnVisit;
