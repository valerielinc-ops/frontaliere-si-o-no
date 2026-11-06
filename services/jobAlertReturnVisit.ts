/**
 * jobAlertReturnVisit.ts — records the FACT that a recognised person opened the
 * site, so the job-alert sender can decide whether a decayed alert comes back.
 *
 * ISSUE #5705, owner's decision of 2026-08-14: an alert that reached
 * `cadence_state: 'decayed'` returns to life by itself when the person comes
 * back — subject to seven refusals, of which this file applies four and the
 * sender re-applies all seven.
 *
 * THIS FILE DECIDES NOTHING, AND THAT IS THE POINT.
 * ────────────────────────────────────────────────
 * `firestore.rules` grants `allow write: if true` on
 * `job_alert_subscribers/{email}` — the grant createAlert needs to guarantee the
 * parent document exists. Anything written from a browser is therefore a CLAIM.
 * If the reactivation were decided here, "resume email to any address" would be
 * a `setDoc` away for anybody. So the browser writes a stamp and the sender
 * judges it, re-running every filter on the stored values (scripts/lib/
 * jobAlertCadence.mjs `reactivationAfterReturnVisit`) and requiring the recorded
 * uid to match the alert's own denormalized `userId`, which no browser can set.
 *
 * The four filters applied HERE are applied so that the stamp is not written at
 * all in the obvious cases — a crawler, a prefetch, an anonymous session, a
 * session that began on the way out. They are a saving, not a security boundary:
 * `functions/src/lib/returnVisit.js` holds the rule, both sides call it, and the
 * server's copy is the one that counts.
 *
 * WHAT IS STORED, AND WHAT IS DELIBERATELY NOT.
 * The landing URL passes through `redactVisitEntryUrl` before it leaves the
 * page: origin, path, and the single `action` query parameter the opt-out
 * predicates read. The unsubscribe and preference-centre links carry a signed
 * token and the address; keeping the whole query string would put a working
 * unsubscribe credential in Firestore for no gain, since nothing downstream
 * reads anything else.
 *
 * ONE WRITE PER DAY PER BROWSER. The stamp is a date, not a counter, so writing
 * it on every page view would buy nothing and cost a Firestore write per view.
 * The throttle lives in localStorage and is best-effort: losing it costs one
 * extra write, and a browser that blocks storage still works.
 */

import {
  classifyReturnVisit,
  redactVisitEntryUrl,
} from '@/functions/src/lib/returnVisit.js';

const THROTTLE_KEY = 'ja_return_visit_stamped_on';

/** The shape the module records — exactly what classifyReturnVisit reads. */
export interface ReturnVisitFacts {
  uid: string;
  userAgent: string;
  entryUrl: string;
  visible: boolean;
  prerender: boolean;
}

/**
 * Read the page load as the classifier sees it.
 *
 * `prerender` is true for both ways a page can exist without anybody looking at
 * it: the Speculation Rules prerender (`document.prerendering`) and an already
 * activated one (`activationStart > 0`, which is how a prerender that has since
 * been shown reports itself). `visible` is the plain question, and it is
 * required to be literally true downstream — "the page was never reported
 * visible" is not evidence that it was.
 */
export function readReturnVisitFacts(uid: string): ReturnVisitFacts {
  const nav = (typeof performance !== 'undefined'
    ? (performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined)
    : undefined);
  const doc = document as Document & { prerendering?: boolean };
  return {
    uid: String(uid || '').trim(),
    userAgent: navigator.userAgent || '',
    entryUrl: redactVisitEntryUrl(window.location.href),
    visible: document.visibilityState === 'visible',
    prerender: doc.prerendering === true || Number(nav?.activationStart || 0) > 0,
  };
}

function alreadyStampedToday(todayIso: string): boolean {
  try {
    return localStorage.getItem(THROTTLE_KEY) === todayIso;
  } catch {
    return false; // storage blocked: write it, one extra write is not a problem
  }
}

function rememberStamp(todayIso: string): void {
  try {
    localStorage.setItem(THROTTLE_KEY, todayIso);
  } catch {
    /* storage blocked — the throttle is best-effort by design */
  }
}

/**
 * Record that this person opened the site, unless the load is obviously not a
 * person opening the site.
 *
 * Best-effort in every direction: a failed write, a blocked storage, a missing
 * Firebase app all resolve to "nothing recorded", which the sender reads as
 * "they did not come back". That is the fail-closed direction — an alert stays
 * decayed and the preference centre stays the way back.
 *
 * @returns the verdict, so a caller (and the test) can see WHY nothing happened
 */
export async function recordJobAlertReturnVisit(
  { email, uid }: { email: string | null | undefined; uid: string | null | undefined },
): Promise<string> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'no-window';
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) return 'anonymous-visit';

  const facts = readReturnVisitFacts(String(uid || ''));
  // The same function the sender runs, on the same shape. `atMs` is supplied
  // here because the classifier's first question is "is there a readable
  // instant" and the answer at this point is yes, now.
  const verdict = classifyReturnVisit({ ...facts, atMs: Date.now(), ip: '' });
  if (!verdict.returned) return verdict.verdict;

  const todayIso = new Date().toISOString().slice(0, 10);
  if (alreadyStampedToday(todayIso)) return 'throttled';

  try {
    const [{ getFirestore, doc, setDoc, serverTimestamp }, { getApp }] = await Promise.all([
      import('firebase/firestore'),
      import('./firebase'),
    ]);
    const db = getFirestore(await getApp());
    await setDoc(
      doc(db, 'job_alert_subscribers', normalizedEmail),
      {
        last_site_visit_at: serverTimestamp(),
        last_site_visit_uid: facts.uid,
        last_site_visit_ua: facts.userAgent.slice(0, 400),
        last_site_visit_entry: facts.entryUrl.slice(0, 400),
        last_site_visit_visible: facts.visible,
        last_site_visit_prerender: facts.prerender,
      },
      { merge: true },
    );
    rememberStamp(todayIso);
    return 'ok';
  } catch {
    // Ad blocker, offline, permission error: no stamp, no reactivation. Never
    // surfaced to the user — this is a background fact, not a user action.
    return 'write-failed';
  }
}
