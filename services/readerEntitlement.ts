/**
 * readerEntitlement — client-side "does this signed-in reader have an active
 * no-ads subscription" signal (#3655, part 2/2 of #2961).
 *
 * Two deliberately-split halves:
 *  1. hasActiveReaderNoAdsEntitlement() — synchronous, dependency-free
 *     localStorage read, mirroring services/newsletterCtaState.ts's style.
 *     This is what BOTH Auto Ads injection points actually gate on
 *     (components/shared/AdSenseBanner.tsx's lazy-load effect +
 *     build-plugins/constants.ts's ADSENSE_LOADER_CONTENT static snippet) —
 *     importing it eagerly never bloats a chunk.
 *  2. subscribeReaderEntitlement(uid) — async, Firestore-backed. Mounted
 *     ONCE near the app root (App.tsx, keyed off authUser?.uid), NOT per ad
 *     slot. Listens to reader_subscriptions/{uid} and keeps the localStorage
 *     flag in sync, including flipping it back to false on cancellation.
 *
 * Per AGENTS.md Non-Negotiable #7: this NEVER disables Auto Ads globally or
 * per-route — it is a purely per-visitor client-state check, opt-in only for
 * the one signed-in, paying reader whose subscription is active.
 */

export const READER_NOADS_ACTIVE_KEY = 'reader_noads_active';

/** Sub-statuses treated as "still ad-free" (past_due keeps a dunning grace window). */
const ACTIVE_ENTITLEMENT_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Synchronous, dependency-free check consumed by both Auto Ads injection
 * points. Fails closed (ads stay ON) if localStorage is unavailable.
 */
export function hasActiveReaderNoAdsEntitlement(): boolean {
  try {
    return localStorage.getItem(READER_NOADS_ACTIVE_KEY) === 'true';
  } catch {
    return false;
  }
}

// Tiny in-memory listener set so a UI surface that cares about the entitlement
// flipping (SubscribePage — subscribe vs. manage-subscription button) can react
// once the async Firestore snapshot resolves after a Stripe redirect round-trip,
// without re-subscribing to Firestore itself (that stays app-root-only, see
// subscribeReaderEntitlement below). Not used by the Auto Ads gates themselves —
// those only ever need the synchronous point-in-time read above.
const entitlementListeners = new Set<(active: boolean) => void>();

/** Subscribe to in-tab entitlement flag changes. Returns an unsubscribe function. */
export function onReaderEntitlementChange(cb: (active: boolean) => void): () => void {
  entitlementListeners.add(cb);
  return () => {
    entitlementListeners.delete(cb);
  };
}

function setEntitlementFlag(active: boolean): void {
  try {
    if (active) localStorage.setItem(READER_NOADS_ACTIVE_KEY, 'true');
    else localStorage.removeItem(READER_NOADS_ACTIVE_KEY);
  } catch {
    // localStorage unavailable — nothing to sync; Auto Ads stays on (fail-safe).
  }
  for (const cb of entitlementListeners) cb(active);
}

/**
 * Mount once near the app root, keyed off the authenticated user's uid.
 * Returns an unsubscribe function. A falsy uid (signed-out visitor) clears
 * the local flag immediately (a signed-out visitor can never have an active
 * entitlement) and returns a no-op unsubscribe.
 */
export async function subscribeReaderEntitlement(
  uid: string | null | undefined,
): Promise<() => void> {
  if (!uid) {
    setEntitlementFlag(false);
    return () => {};
  }

  const [{ getFirestore, doc, onSnapshot }, { getApp }] = await Promise.all([
    import('firebase/firestore'),
    import('@/services/firebase'),
  ]);
  const firestore = getFirestore(await getApp());
  const ref = doc(firestore, 'reader_subscriptions', uid);

  const unsubscribe = onSnapshot(
    ref,
    (snap) => {
      const status = snap.exists() ? (snap.data() as { status?: string } | undefined)?.status : undefined;
      setEntitlementFlag(!!status && ACTIVE_ENTITLEMENT_STATUSES.has(status));
    },
    () => {
      // Read failure (offline / rules) — fail safe: leave the previously
      // cached flag in place rather than flipping ads on/off on a transient
      // blip. The next successful snapshot reconciles it either way.
    },
  );

  return unsubscribe;
}
