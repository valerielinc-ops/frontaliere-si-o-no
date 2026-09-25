/**
 * redazioneAdminCore.js — ADMIN-only superadmin view + editor for the
 * editorial team ("redazione").
 *
 * Two article catalogs exist and never overlapped before this: the
 * AI-generated catalog (`data/blog-articles-data.ts`, static, bundled
 * client-side, byline driven by the static `data/authors.ts` persona
 * registry) and the real-journalist catalog (`journalist_articles`
 * Firestore collection, gated by `firestore.rules` to each author's own
 * uid). This function gives the admin (Valerie, see `assertAdmin`) a
 * single GET that lists real-journalist articles across ALL authors
 * (Admin SDK bypasses the per-uid rule) plus the current admin overrides
 * for the AI-persona registry, and a POST that writes those overrides.
 *
 * There are deliberately TWO different override collections rather than
 * one, because they patch two semantically different things:
 *   - `author_profiles/{slug}`         — persona bio/photo/social patch.
 *   - `article_author_overrides/{id}`  — per-article author reassignment
 *     for the AI catalog only. Reassigning a `journalist_articles` entry
 *     would mean changing which real Firebase Auth uid owns that draft's
 *     write access — a different, riskier operation not requested here —
 *     so real-journalist articles are listed but not reassignable via
 *     this endpoint.
 *
 * Both overrides are applied client-side at runtime (see
 * services/authorProfileService.ts) on top of the static registries —
 * they do NOT retroactively rewrite already-built static HTML/JSON-LD for
 * SSG pages; that stays in sync at the next scheduled rebuild, same as
 * any other `data/*.ts` edit.
 *
 * GET  → { ok, journalistArticles, authorProfiles, articleAuthorOverrides }
 * POST → body { action: 'updateProfile', slug, patch } or
 *         { action: 'reassignArticle', articleId, authorSlug, authorName }
 */

import { getAdminDb } from './newsletterResendWebhookCore.js';
import { assertAdmin } from './adminEmployerInsights.js';

const AUTHOR_PROFILES_COLLECTION = 'author_profiles';
const ARTICLE_AUTHOR_OVERRIDES_COLLECTION = 'article_author_overrides';
const JOURNALIST_ARTICLES_COLLECTION = 'journalist_articles';

const ACTIONS = new Set(['updateProfile', 'reassignArticle']);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROFILE_STRING_FIELDS = ['name', 'role', 'bio', 'photoPath', 'email'];
const SOCIAL_STRING_FIELDS = ['linkedin', 'twitter', 'mastodon', 'wikidataId'];

/** GET → real-journalist articles (all authors) + both override collections, as-is. */
async function handleList(db) {
  const [journalistSnap, profilesSnap, overridesSnap] = await Promise.all([
    db.collection(JOURNALIST_ARTICLES_COLLECTION).get(),
    db.collection(AUTHOR_PROFILES_COLLECTION).get(),
    db.collection(ARTICLE_AUTHOR_OVERRIDES_COLLECTION).get(),
  ]);

  const journalistArticles = journalistSnap.docs.map((doc) => {
    const d = doc.data() || {};
    return {
      id: doc.id,
      authorUid: String(d.authorUid || ''),
      authorName: String(d.authorName || ''),
      authorEmail: String(d.authorEmail || ''),
      category: String(d.category || ''),
      title: String(d.content?.it?.title || ''),
      status: String(d.status || ''),
      createdAt: d.createdAt ? String(d.createdAt) : null,
      updatedAt: d.updatedAt ? String(d.updatedAt) : null,
      publishedAt: d.publishedAt ? String(d.publishedAt) : null,
      publishedUrls: d.publishedUrls || null,
    };
  });

  const authorProfiles = {};
  for (const doc of profilesSnap.docs) authorProfiles[doc.id] = doc.data() || {};

  const articleAuthorOverrides = {};
  for (const doc of overridesSnap.docs) articleAuthorOverrides[doc.id] = doc.data() || {};

  return { status: 200, body: { ok: true, journalistArticles, authorProfiles, articleAuthorOverrides } };
}

function sanitizeProfilePatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const patch = {};
  for (const field of PROFILE_STRING_FIELDS) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== 'string') return null;
    patch[field] = raw[field].trim();
  }
  if (raw.social !== undefined) {
    if (typeof raw.social !== 'object' || raw.social === null) return null;
    const social = {};
    for (const field of SOCIAL_STRING_FIELDS) {
      if (raw.social[field] === undefined) continue;
      if (typeof raw.social[field] !== 'string') return null;
      social[field] = raw.social[field].trim();
    }
    patch.social = social;
  }
  return Object.keys(patch).length ? patch : null;
}

async function handleUpdateProfile(db, raw, adminEmail) {
  const slug = String(raw.slug || '').trim().toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) {
    return { status: 400, body: { ok: false, error: 'invalid_input' } };
  }
  const patch = sanitizeProfilePatch(raw.patch);
  if (!patch) {
    return { status: 400, body: { ok: false, error: 'invalid_input' } };
  }
  await db.collection(AUTHOR_PROFILES_COLLECTION).doc(slug).set(
    { ...patch, updatedAt: new Date().toISOString(), updatedBy: adminEmail },
    { merge: true },
  );
  return { status: 200, body: { ok: true } };
}

async function handleReassignArticle(db, raw, adminEmail) {
  const articleId = String(raw.articleId || '').trim();
  const authorSlug = String(raw.authorSlug || '').trim().toLowerCase();
  const authorName = String(raw.authorName || '').trim();
  if (!articleId || !authorSlug || !SLUG_RE.test(authorSlug) || !authorName) {
    return { status: 400, body: { ok: false, error: 'invalid_input' } };
  }
  await db.collection(ARTICLE_AUTHOR_OVERRIDES_COLLECTION).doc(articleId).set(
    { authorSlug, authorName, updatedAt: new Date().toISOString(), updatedBy: adminEmail },
    { merge: true },
  );
  return { status: 200, body: { ok: true } };
}

async function handleMutate(db, req, adminEmail) {
  const raw = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(raw.action || '').trim();
  if (!ACTIONS.has(action)) {
    return { status: 400, body: { ok: false, error: 'invalid_input' } };
  }
  if (action === 'updateProfile') return handleUpdateProfile(db, raw, adminEmail);
  return handleReassignArticle(db, raw, adminEmail);
}

/**
 * Entry point. GET lists both catalogs + current overrides; POST mutates
 * a persona profile override or an AI-catalog article reassignment. Both
 * modes require the verified admin (assertAdmin).
 */
export async function handleRedazioneAdmin(req) {
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
