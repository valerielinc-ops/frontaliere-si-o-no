/**
 * adminEmployerInsights.js — ADMIN-only listing of employer traffic insights.
 *
 * Backs the admin dashboard's "Insights Aziende" section. The data in
 * `employer_insights/{companyKey}` is PRIVATE (real per-company traffic we email
 * to companies as a paid teaser), so this endpoint is gated by a Firebase ID
 * token + admin email allowlist — mirroring `githubProxy.js` (handleGetAdminGithubToken).
 *
 * GET (list mode) → { ok, insights: [{ companyKey, companyName, totals,
 * generatedAt, insightsUrl }] } sorted by totals.views desc, with the big
 * `ads` / `trend` arrays stripped to keep the payload lean.
 *
 * `insightsUrl` is the real tokenized "open as company" link the company
 * receives: https://frontaliereticino.ch/azienda/<companyKey>/?t=<token>
 * token = HMAC-SHA256(NEWSLETTER_SECRET, `employer_insights:${companyKey}`) hex.
 *
 * NOTE: `generateInsightsToken` below MUST stay byte-identical to the same
 * helper in functions/src/employerInsights.js (added in parallel — the
 * per-company stats page verifies the token with it). Dedupe at integration:
 * import it from employerInsights.js once both land.
 */

import { getAuth } from 'firebase-admin/auth';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { getNewsletterSecrets } from './remoteConfigSecrets.js';
// Single source of truth for the stats-page token (no local HMAC copy → no drift).
import { generateInsightsToken } from './employerInsights.js';

const ADMIN_EMAIL_ALLOWLIST = new Set(['valerielinc@gmail.com']);
const BASE_URL = 'https://frontaliereticino.ch';
const INSIGHTS_COLLECTION = 'employer_insights';

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
    return { ok: true };
  } catch {
    return { ok: false, status: 401, error: 'invalid_id_token' };
  }
}

/**
 * List all employer insights (lean) for the verified admin only.
 * GET only. Returns insights sorted by totals.views desc.
 */
export async function handleAdminEmployerInsights(req) {
  if (req.method !== 'GET') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const auth = await assertAdmin(req);
  if (!auth.ok) {
    return { status: auth.status, body: { ok: false, error: auth.error } };
  }

  const { newsletterSecret } = await getNewsletterSecrets();
  if (!newsletterSecret) {
    return { status: 503, body: { ok: false, error: 'secret_not_configured' } };
  }

  const db = getAdminDb();
  const snap = await db.collection(INSIGHTS_COLLECTION).get();

  const insights = snap.docs.map((doc) => {
    const d = doc.data() || {};
    const companyKey = String(d.companyKey || doc.id);
    const t = d.totals || {};
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
    };
  });

  insights.sort((a, b) => b.totals.views - a.totals.views);

  return { status: 200, body: { ok: true, insights } };
}
