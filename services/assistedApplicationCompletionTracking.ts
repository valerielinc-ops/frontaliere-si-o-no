import {
  shouldSuppressAssistedApplicationEvent,
  trackAssistedApplicationEvent,
  type AssistedApplicationEventContext,
} from './assistedApplicationExperiment';

const STORAGE_PREFIX = 'frontaliere_assisted_completion_v1:';
const completedInThisPage = new Set<string>();

/**
 * Best-effort browser deduplication of the paid-order funnel signal. This is
 * not an authoritative purchase ledger: another browser has its own storage.
 */
export function trackAssistedApplicationCompletionOnce(
  orderId: string,
  context: AssistedApplicationEventContext,
): boolean {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId || typeof window === 'undefined' || shouldSuppressAssistedApplicationEvent()) return false;
  if (completedInThisPage.has(normalizedOrderId)) return false;
  const storageKey = `${STORAGE_PREFIX}${normalizedOrderId}`;
  try {
    if (window.localStorage.getItem(storageKey) === '1') {
      completedInThisPage.add(normalizedOrderId);
      return false;
    }
  } catch {
    // Disabled/full storage still leaves the page-local deduplication intact.
  }

  trackAssistedApplicationEvent('checkout_completed', context);
  completedInThisPage.add(normalizedOrderId);
  try {
    window.localStorage.setItem(storageKey, '1');
  } catch {
    // Analytics must never prevent access to an already-paid order.
  }
  return true;
}
