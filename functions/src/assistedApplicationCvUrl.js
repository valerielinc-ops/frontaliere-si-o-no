import { getAuth } from 'firebase-admin/auth';
import { ASSISTED_APPLICATIONS_COLLECTION, hasAssistedApplicationConsent } from './assistedApplicationConstants.js';
import { isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';

const SIGNED_URL_TTL_MS = 10 * 60 * 1000;

async function verifyCaller(req) {
  const header = req.get?.('Authorization') || req.get?.('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch {
    return null;
  }
}

/** Mint a temporary read link for the authenticated owner of a paid order. */
export async function handleGetAssistedApplicationCvUrl(req, deps) {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const decoded = await (deps.verifyCaller || verifyCaller)(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const orderId = String(req.body?.orderId || '').trim();
  if (!orderId || orderId.length > 200 || orderId.includes('/')) {
    return { status: 400, body: { ok: false, error: 'invalid_order_id' } };
  }

  const orderSnapshot = await deps.db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId).get();
  if (!orderSnapshot.exists) return { status: 404, body: { ok: false, error: 'order_not_found' } };

  const order = orderSnapshot.data() || {};
  if (order.userId !== decoded.uid) return { status: 403, body: { ok: false, error: 'forbidden' } };
  if (order.paymentStatus !== 'paid' || !hasAssistedApplicationConsent(order)) {
    return { status: 403, body: { ok: false, error: 'order_not_ready' } };
  }

  const key = String(order.cvStorageKey || '');
  if (!isAssistedApplicationCvKey(orderId, key)) {
    return { status: 404, body: { ok: false, error: 'cv_unavailable' } };
  }

  const file = deps.bucket.file(key);
  const [exists] = await file.exists();
  if (!exists) return { status: 404, body: { ok: false, error: 'cv_unavailable' } };

  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
  });
  return { status: 200, body: { ok: true, url } };
}
