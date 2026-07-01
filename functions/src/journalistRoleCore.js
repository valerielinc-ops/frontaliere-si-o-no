/**
 * journalistRoleCore.js — ADMIN-only grant/revoke of the "journalist" role.
 *
 * The role itself lives in `journalists/{uid}` — a Firestore-doc-backed
 * permission (doc exists + `active: true` grants access to the gated publish
 * dashboard). `firestore.rules` allows the client to READ its own doc only;
 * ALL writes go through this Cloud Function (Admin SDK), gated by
 * `assertAdmin` (same allowlist as `adminEmployerInsights.js` /
 * `adminSendColdEmail.js` — reused here, not duplicated).
 *
 * GET (list mode, no body) → { ok, journalists: [{ uid, email, displayName,
 * active, grantedAt, grantedBy }] } — every doc in `journalists`, newest
 * grant unspecified order (dashboard sorts client-side if needed).
 *
 * POST (mutate mode, JSON body { action: 'grant' | 'revoke', email }) →
 * resolves the Firebase Auth user by email (they must have signed into the
 * site at least once — we grant by uid, not by email alone) then:
 *   - grant  → upserts `journalists/{uid}` with active:true + audit fields.
 *   - revoke → sets active:false + revokedAt; a no-op (still `ok:true`) if
 *     the doc never existed, since there is nothing to revoke.
 */

import { getAuth } from 'firebase-admin/auth';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { assertAdmin } from './adminEmployerInsights.js';

const JOURNALISTS_COLLECTION = 'journalists';
const ACTIONS = new Set(['grant', 'revoke']);

// Pragmatic email shape check (server-side), same style as adminEmployerInsights.js.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** GET → list every journalist doc as-is (uid = doc id). */
async function handleList(db) {
  const snap = await db.collection(JOURNALISTS_COLLECTION).get();
  const journalists = snap.docs.map((doc) => {
    const d = doc.data() || {};
    return {
      uid: doc.id,
      email: String(d.email || ''),
      displayName: String(d.displayName || ''),
      active: d.active === true,
      grantedAt: d.grantedAt ? String(d.grantedAt) : null,
      grantedBy: d.grantedBy ? String(d.grantedBy) : null,
    };
  });
  return { status: 200, body: { ok: true, journalists } };
}

/** POST → grant or revoke the journalist role for the Auth user with this email. */
async function handleMutate(db, req, adminEmail) {
  const raw = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(raw.action || '').trim();
  const email = String(raw.email || '').trim().toLowerCase();

  if (!ACTIONS.has(action) || !email || !EMAIL_RE.test(email)) {
    return { status: 400, body: { ok: false, error: 'invalid_input' } };
  }

  let authUser;
  try {
    authUser = await getAuth().getUserByEmail(email);
  } catch {
    // No such Firebase Auth user — they must sign into the site once before
    // being grantable (we key the role doc by uid, not by email).
    return { status: 404, body: { ok: false, error: 'user_not_found' } };
  }

  const docRef = db.collection(JOURNALISTS_COLLECTION).doc(authUser.uid);

  if (action === 'grant') {
    await docRef.set(
      {
        email,
        displayName: authUser.displayName || email,
        active: true,
        grantedAt: new Date().toISOString(),
        grantedBy: adminEmail,
      },
      { merge: true },
    );
    return { status: 200, body: { ok: true } };
  }

  // revoke — idempotent: nothing to do if the doc was never created.
  const docSnap = await docRef.get();
  if (docSnap.exists) {
    await docRef.update({
      active: false,
      revokedAt: new Date().toISOString(),
    });
  }
  return { status: 200, body: { ok: true } };
}

/**
 * Entry point. GET lists journalists; POST grants/revokes the role.
 * Both modes require the verified admin (assertAdmin).
 */
export async function handleManageJournalistRole(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const auth = await assertAdmin(req);
  if (!auth.ok) {
    return { status: auth.status, body: { ok: false, error: auth.error } };
  }

  const db = getAdminDb();

  if (method === 'POST') {
    return handleMutate(db, req, auth.adminEmail);
  }

  return handleList(db);
}
