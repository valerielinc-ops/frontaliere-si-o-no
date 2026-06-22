/**
 * adminEmployerInsights.js — ADMIN-only listing of employer traffic insights
 * + the per-company outreach CONTACT (read & edit).
 *
 * The data in `employer_insights/{companyKey}` is PRIVATE (real per-company
 * traffic we email to companies as a paid teaser), so this endpoint is gated by
 * a Firebase ID token + admin email allowlist — mirroring `githubProxy.js`
 * (handleGetAdminGithubToken).
 *
 * GET (list mode) → { ok, insights: [{ companyKey, companyName, totals,
 * generatedAt, insightsUrl, contactEmail, contactEmailInferred, contactName,
 * contactRole, topRole }] } sorted by totals.views desc, with the big
 * `ads` / `trend` arrays stripped to keep the payload lean. The contact fields
 * come from the editable `employer_contacts/{companyKey}` collection (server
 * source of truth; merged into the local data/employer-outreach/contacts.json
 * at send time by send-cold-emails.mjs).
 *
 * POST (edit mode, JSON body { companyKey, email, contactName, topRole }) →
 * upserts `employer_contacts/{companyKey}` so the admin can fix the recipient
 * address / personalization straight from the dashboard. Email is validated;
 * an empty string clears the field.
 *
 * `insightsUrl` is the real tokenized "open as company" link the company
 * receives: https://frontaliereticino.ch/azienda/<companyKey>/?t=<token>
 * token = HMAC-SHA256(NEWSLETTER_SECRET, `employer_insights:${companyKey}`) hex.
 */

import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { getNewsletterSecrets } from './remoteConfigSecrets.js';
// Single source of truth for the stats-page token (no local HMAC copy → no drift).
import { generateInsightsToken } from './employerInsights.js';

const ADMIN_EMAIL_ALLOWLIST = new Set(['valerielinc@gmail.com']);
const BASE_URL = 'https://frontaliereticino.ch';
const INSIGHTS_COLLECTION = 'employer_insights';
const CONTACTS_COLLECTION = 'employer_contacts';

// Pragmatic email shape check (server-side; the SPA also validates). Empty string
// is allowed by the caller (clears the field) and never reaches this regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Build the tokenized "open as company" URL (trailing slash, canonical). */
function buildInsightsUrl(companyKey, secret) {
  const token = generateInsightsToken(companyKey, secret);
  return `${BASE_URL}/azienda/${encodeURIComponent(companyKey)}/?t=${token}`;
}

// ── Admin gate (mirrors githubProxy.js assertAdmin) ─────────────────────────
async function assertAdmin(req) {
  const header = req.get ? req.get('Authorization') : req.headers?.authorization;
  const idToken = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : '';
  if (!idToken) return { ok: false, status: 401, error: 'missing_id_token' };
  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    const email = (decoded.email || '').toLowerCase();
    if (!decoded.email_verified || !ADMIN_EMAIL_ALLOWLIST.has(email)) {
      return { ok: false, status: 403, error: 'not_admin' };
    }
    return { ok: true, adminEmail: email };
  } catch {
    return { ok: false, status: 401, error: 'invalid_id_token' };
  }
}

/** Read every editable contact doc once → Map(companyKey → contact fields). */
async function loadContactsMap(db) {
  const map = new Map();
  const snap = await db.collection(CONTACTS_COLLECTION).get();
  snap.forEach((doc) => {
    const d = doc.data() || {};
    const key = String(d.companyKey || doc.id);
    map.set(key, {
      email: String(d.email || ''),
      emailInferred: String(d.emailInferred || ''),
      contactName: String(d.contactName || ''),
      contactRole: String(d.contactRole || ''),
      topRole: String(d.topRole || ''),
    });
  });
  return map;
}

/** GET → lean per-company insights list merged with the editable contact. */
async function handleList(db, newsletterSecret) {
  const [snap, contacts] = await Promise.all([
    db.collection(INSIGHTS_COLLECTION).get(),
    loadContactsMap(db),
  ]);

  const insights = snap.docs.map((doc) => {
    const d = doc.data() || {};
    const companyKey = String(d.companyKey || doc.id);
    const t = d.totals || {};
    const c = contacts.get(companyKey) || {};
    return {
      companyKey,
      companyName: String(d.companyName || companyKey),
      generatedAt: d.generatedAt ? String(d.generatedAt) : null,
      totals: {
        views: Number(t.views || 0),
        visitors: Number(t.visitors || 0),
        candidates: Number(t.candidates || 0),
        adsCount: Number(t.adsCount || 0),
        lost: Number(t.lost || 0),
        conversionRate: Number(t.conversionRate || 0),
      },
      insightsUrl: buildInsightsUrl(companyKey, newsletterSecret),
      contactEmail: c.email || '',
      contactEmailInferred: c.emailInferred || '',
      contactName: c.contactName || '',
      contactRole: c.contactRole || '',
      topRole: c.topRole || '',
    };
  });

  insights.sort((a, b) => b.totals.views - a.totals.views);
  return { status: 200, body: { ok: true, insights } };
}

/** POST → upsert the editable contact for one company. */
async function handleUpsertContact(db, req, adminEmail) {
  const raw = req.body && typeof req.body === 'object' ? req.body : {};
  const companyKey = String(raw.companyKey || '').trim();
  if (!companyKey) {
    return { status: 400, body: { ok: false, error: 'missing_company_key' } };
  }

  const update = {
    companyKey,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: adminEmail || 'admin',
  };

  // Email handling. A blank input is NOT a clear by default — otherwise an admin
  // tweaking only the name/role would silently wipe the address (the local
  // contacts.json email isn't visible to this GET, so the field always shows
  // blank initially). An intentional clear must set `clearEmail: true`.
  if (raw.clearEmail === true) {
    update.email = '';
    update.clearEmail = true;
  } else {
    const email = String(raw.email || '').trim().toLowerCase();
    if (email) {
      if (!EMAIL_RE.test(email)) {
        return { status: 400, body: { ok: false, error: 'invalid_email' } };
      }
      update.email = email;
      // A manual edit is the authoritative address → drop any inferred guess and
      // any prior clear flag so it never shadows the human-entered value.
      update.emailInferred = '';
      update.clearEmail = false;
    }
    // email empty + no clearEmail → leave the stored email untouched.
  }
  if (raw.contactName !== undefined) update.contactName = String(raw.contactName || '').trim().slice(0, 120);
  if (raw.topRole !== undefined) update.topRole = String(raw.topRole || '').trim().slice(0, 160);

  await db.collection(CONTACTS_COLLECTION).doc(companyKey).set(update, { merge: true });
  return {
    status: 200,
    body: {
      ok: true,
      contact: {
        companyKey,
        contactEmail: update.email,
        contactName: update.contactName,
        topRole: update.topRole,
      },
    },
  };
}

/**
 * Entry point. GET lists insights (+contact); POST upserts a contact.
 * Both modes require the verified admin.
 */
export async function handleAdminEmployerInsights(req) {
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
    return handleUpsertContact(db, req, auth.adminEmail);
  }

  const { newsletterSecret } = await getNewsletterSecrets();
  if (!newsletterSecret) {
    return { status: 503, body: { ok: false, error: 'secret_not_configured' } };
  }
  return handleList(db, newsletterSecret);
}
