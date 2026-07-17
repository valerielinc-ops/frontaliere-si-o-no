/**
 * Shared loader for a publisher's prepaid location-credits (pay-first
 * funnel) — single source for the `orders` query + active/prepaid filter,
 * used by PublisherPublishPage (plan/form phase gating) and
 * PublisherDashboardPage (unused-credits banner). Single equality `where`
 * (no composite index needed); status/prepaid filtered client-side,
 * matching the sponsored/azienda split the CF derives from `orders.plan`.
 */
import { getApp } from '@/services/firebase';
import {
  sumRemainingUnits,
  maxClaimableUnits,
  type PrepaidOrderCredit,
} from '@/services/publisherPricing';
import type { PublisherTier } from '@/services/publisherTypes';

export interface PublisherCredits {
  /** Total residual units across all active prepaid orders. `null` = azienda unlimited. */
  remainingUnits: number | null;
  /**
   * Largest residual on a single order — the max distinct locations ONE ad
   * can carry (attachPublisherJob assigns each ad whole to one order).
   * `null` = azienda unlimited.
   */
  maxClaimableUnits: number | null;
  /** Purchased tier; `null` = no active prepaid credit. */
  tier: PublisherTier | null;
}

export async function loadPublisherCredits(uid: string): Promise<PublisherCredits> {
  const { getFirestore, collection, query, where, getDocs } = await import('firebase/firestore');
  const db = getFirestore(await getApp());
  const snap = await getDocs(query(collection(db, 'orders'), where('publisherUid', '==', uid)));
  const active: PrepaidOrderCredit[] = [];
  let sawAzienda = false;
  snap.forEach(docSnap => {
    const d = docSnap.data() as Record<string, unknown>;
    if (d.status !== 'active' || d.prepaid !== true) return;
    const isAzienda = d.plan === 'azienda';
    if (isAzienda) sawAzienda = true;
    active.push({
      plan: isAzienda ? 'azienda' : undefined,
      unitsPurchased: typeof d.unitsPurchased === 'number' ? d.unitsPurchased : null,
      unitsUsed: typeof d.unitsUsed === 'number' ? d.unitsUsed : 0,
    });
  });
  if (active.length === 0) return { remainingUnits: 0, maxClaimableUnits: 0, tier: null };
  return {
    remainingUnits: sumRemainingUnits(active),
    maxClaimableUnits: maxClaimableUnits(active),
    tier: sawAzienda ? 'azienda' : 'sponsored',
  };
}
