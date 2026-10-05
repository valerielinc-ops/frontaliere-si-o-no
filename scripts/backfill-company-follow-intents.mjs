#!/usr/bin/env node
/**
 * One-shot recovery of company follows that confirmed visitors asked for but
 * never received (2026-10-05).
 *
 * Until functions/src/companyFollowIntents.js the anonymous "Segui azienda"
 * intent lived only in the visitor's localStorage, so a confirmation opened on
 * another device created no CompanyAlert. Measured on production 2026-10-05:
 * 35 subscribers carrying `company_follow_followup_pending`, 32 without any
 * company alert.
 *
 * WHAT THE BACKEND STILL KNOWS. The company name is NOT stored on the follow
 * event, but every follow wrote a `subscribe_completed` event with
 * `source_cta: 'company_follow_button'` (or `company_follow_social`) and the
 * `source_page` of the click. The employer is reconstructed from that page
 * only when the page itself names it:
 *   - `/aziende/<slug>/` (any locale prefix)          → the profile slug;
 *   - `/aziende-che-assumono/<town>/<slug>/…`          → the employer segment;
 *   - `/<listing>/(azienda|company|unternehmen|entreprise)-<slug>/` → the hub;
 *   - a job detail page whose slug CONTAINS the canonical key of the
 *     subscriber's `job_company` (the company the follow prompt recorded).
 * A follow clicked on a generic listing or a page that does not name the
 * subscriber's `job_company` is reported as `unresolved` and never guessed.
 *
 * WHO. Only confirmed subscribers (status confirmed/active/subscribed WITH a
 * confirmation proof), not unsubscribed, opted out, bounced or complained,
 * with a Firebase Auth user (the alert must carry the uid the visitor signs
 * in with), and only for a company with NO alert at all — an inactive one is
 * an explicit unfollow and stays binding.
 *
 * HOW. With --apply each reconstructed follow is written as a server intent
 * (`newsletter_subscribers/{email}/company_follow_intents/backfill_<key>`,
 * dated at the original click) and handed to the SAME fulfilment the
 * confirmation endpoint runs, so the alert is byte-identical to a live one.
 * Re-running is idempotent: the intent id is deterministic and a fulfilled
 * intent is never re-read.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/backfill-company-follow-intents.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/backfill-company-follow-intents.mjs --apply
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  COMPANY_FOLLOW_INTENTS_SUBCOLLECTION,
  companyFollowBlockReason,
  fulfillCompanyFollowIntents,
  toMillis,
} from '../functions/src/companyFollowIntents.js';
import { companyFollowGroupKey, normalizeCompanyAlertKey } from '../functions/src/newsletterSubscriptionManagement.js';
import { hasConfirmationProof } from '../functions/src/lib/subscriberConsent.js';

export const FOLLOW_EVENT_CTAS = new Set(['company_follow_button', 'company_follow_social']);
const COMPANY_FOLLOW_CHANNELS = ['company_follow_button', 'company_follow_unified'];
const CONFIRMED_STATUSES = new Set(['confirmed', 'active', 'subscribed']);
const HUB_PREFIXES = ['azienda-', 'company-', 'unternehmen-', 'entreprise-'];
const PAGE_LOCALES = new Set(['en', 'de', 'fr']);

export function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

/** Site locale of a page path (`/en/...` → en, unprefixed → it). */
export function pageLocale(sourcePage) {
  const first = String(sourcePage || '').split('/').filter(Boolean)[0];
  return PAGE_LOCALES.has(first) ? first : 'it';
}

/**
 * The employer a follow click named, from the page it was clicked on.
 * @returns {{ key: string, basis: string, jobSlug: string|null } | null}
 */
export function companyKeyFromFollowPage({ sourcePage, jobCompany, normalizeKey = normalizeCompanyAlertKey }) {
  const segments = String(sourcePage || '').split('?')[0].split('/').filter(Boolean);
  if (segments.length > 0 && PAGE_LOCALES.has(segments[0])) segments.shift();
  if (segments.length === 0) return null;

  if (segments[0] === 'aziende' && segments[1]) {
    const key = normalizeKey(segments[1]);
    return key ? { key, basis: 'employer_profile', jobSlug: null } : null;
  }
  if (segments[0] === 'aziende-che-assumono' && segments[2]) {
    const key = normalizeKey(segments[2]);
    return key ? { key, basis: 'employer_weekly', jobSlug: null } : null;
  }
  if (segments.length === 2) {
    const leaf = segments[1];
    const prefix = HUB_PREFIXES.find((p) => leaf.startsWith(p));
    if (prefix) {
      const key = normalizeKey(leaf.slice(prefix.length));
      return key ? { key, basis: 'company_hub', jobSlug: null } : null;
    }
    // A job detail page: accept the recorded company only when the page slug
    // names it, i.e. the click and the recorded employer are the same one.
    const companyKey = normalizeKey(String(jobCompany || ''));
    const rawCompanySlug = String(jobCompany || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    // Whole hyphen-delimited tokens only: a bare substring would let a short
    // key (`ab`) "match" an unrelated slug (`laboratory-job`).
    const namesToken = (slug) => Boolean(slug) && `-${leaf}-`.includes(`-${slug}-`);
    if (companyKey && (namesToken(companyKey) || namesToken(rawCompanySlug))) {
      return { key: companyKey, basis: 'job_page_company_match', jobSlug: leaf };
    }
  }
  return null;
}

/**
 * Decide one subscriber. Pure: the caller supplies the documents.
 * @returns {{ eligible: boolean, reason?: string, follows: Array<object>, unresolved: number, wouldCreate: string[], alreadyHas: string[] }}
 */
export function planSubscriberBackfill({
  subscriber, events, alerts, hasAuthUser,
  normalizeKey = normalizeCompanyAlertKey,
  groupKey = companyFollowGroupKey,
}) {
  const plan = { eligible: false, follows: [], unresolved: 0, wouldCreate: [], alreadyHas: [] };
  const followEvents = (events || []).filter((e) => FOLLOW_EVENT_CTAS.has(String(e?.source_cta || '')));
  if (followEvents.length === 0) return { ...plan, reason: 'no_follow_event' };

  // One follow per follow group (coop + coop-genossenschaft are ONE follow).
  const byKey = new Map();
  for (const event of followEvents) {
    const resolved = companyKeyFromFollowPage({
      sourcePage: event.source_page,
      jobCompany: subscriber?.job_company,
      normalizeKey,
    });
    if (!resolved) { plan.unresolved += 1; continue; }
    const clickedMs = toMillis(event.timestamp) ?? toMillis(event.occurred_at);
    const previous = byKey.get(groupKey(resolved.key));
    if (!previous || (clickedMs ?? 0) > (previous.clickedMs ?? 0)) {
      byKey.set(groupKey(resolved.key), {
        ...resolved,
        clickedMs,
        sourcePage: String(event.source_page || '').slice(0, 500) || null,
        locale: pageLocale(event.source_page),
      });
    }
  }
  plan.follows = [...byKey.values()];

  const status = String(subscriber?.status || '').trim().toLowerCase();
  if (!CONFIRMED_STATUSES.has(status) || !hasConfirmationProof(subscriber || {})) return { ...plan, reason: 'not_confirmed' };
  const blocked = companyFollowBlockReason(subscriber);
  if (blocked) return { ...plan, reason: blocked };
  if (plan.follows.length === 0) return { ...plan, reason: 'unresolved_company' };
  if (!hasAuthUser) return { ...plan, reason: 'no_auth_user' };

  const groupsWithAlert = new Set((alerts || [])
    .map((a) => a?.specificCompanyKey).filter(Boolean).map((k) => groupKey(String(k))));
  for (const follow of plan.follows) {
    if (groupsWithAlert.has(groupKey(follow.key))) plan.alreadyHas.push(follow.key);
    else plan.wouldCreate.push(follow.key);
  }
  if (plan.wouldCreate.length === 0) return { ...plan, reason: 'already_has_alert' };
  return { ...plan, eligible: true };
}

let _admin = null;
async function getAdmin() {
  if (_admin) return _admin;
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    }
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    initializeApp({ credential: cert(cred), projectId: cred.project_id });
  }
  _admin = { db: getFirestore(), auth: getAuth() };
  return _admin;
}

async function loadCandidates(db) {
  const ids = new Map();
  const add = (snap) => snap.forEach((doc) => { if (!ids.has(doc.id)) ids.set(doc.id, doc.data() || {}); });
  add(await db.collection('newsletter_subscribers').where('company_follow_followup_pending', '==', true).get());
  add(await db.collection('newsletter_subscribers').where('source_channel', 'in', COMPANY_FOLLOW_CHANNELS).get());
  return ids;
}

export async function runBackfill({
  db: injectedDb = null,
  auth: injectedAuth = null,
  apply = process.argv.includes('--apply'),
  log = (...args) => console.log(...args),
} = {}) {
  const admin = injectedDb ? { db: injectedDb, auth: injectedAuth } : await getAdmin();
  const { db, auth } = admin;
  const { FieldValue, Timestamp } = await import('firebase-admin/firestore');
  log(apply ? '🛠️  company follow backfill — APPLY' : '🔎 company follow backfill — dry run (pass --apply to write)');

  const candidates = await loadCandidates(db);
  const counts = {
    candidates: candidates.size, eligibleSubscribers: 0, alertsPlanned: 0, alertsCreated: 0, alreadyFollowing: 0,
    skippedFollows: 0, unresolvedFollowEvents: 0, failed: 0, reasons: {},
  };
  const bump = (reason) => { counts.reasons[reason] = (counts.reasons[reason] || 0) + 1; };

  for (const [email, subscriber] of candidates) {
    const ref = db.collection('newsletter_subscribers').doc(email);
    const eventsSnap = await ref.collection('events').get();
    const events = [];
    eventsSnap.forEach((doc) => events.push(doc.data() || {}));
    const alertsSnap = await db.collection('job_alert_subscribers').doc(email).collection('alerts').get();
    const alerts = [];
    alertsSnap.forEach((doc) => alerts.push(doc.data() || {}));
    let uid = null;
    try { uid = (await auth.getUserByEmail(email)).uid; } catch { uid = null; }

    const plan = planSubscriberBackfill({ subscriber, events, alerts, hasAuthUser: Boolean(uid) });
    counts.unresolvedFollowEvents += plan.unresolved;
    if (!plan.eligible) {
      bump(plan.reason);
      if (plan.reason !== 'no_follow_event') {
        log(`   skip ${maskEmail(email)}: ${plan.reason} (follows=${plan.follows.map((f) => f.key).join(',') || '-'}, unresolved=${plan.unresolved})`);
      }
      continue;
    }
    counts.eligibleSubscribers += 1;
    counts.alertsPlanned += plan.wouldCreate.length;
    log(`   ${apply ? 'apply' : 'would create'} ${maskEmail(email)}: ${plan.wouldCreate.join(', ')}`
      + (plan.alreadyHas.length ? ` (already: ${plan.alreadyHas.join(', ')})` : ''));
    if (!apply) continue;

    try {
      for (const follow of plan.follows.filter((f) => plan.wouldCreate.includes(f.key))) {
        const intentRef = ref.collection(COMPANY_FOLLOW_INTENTS_SUBCOLLECTION).doc(`backfill_${follow.key}`.slice(0, 200));
        const existing = await intentRef.get();
        if (existing.exists) continue;
        await intentRef.set({
          company_key: follow.key,
          company: subscriber.job_company && normalizeCompanyAlertKey(subscriber.job_company) === follow.key
            ? String(subscriber.job_company).slice(0, 200)
            : null,
          locale: follow.locale,
          source_job_slug: follow.jobSlug,
          source_job_url: null,
          source_job_title: null,
          source_page: follow.sourcePage,
          status: 'pending',
          created_at: follow.clickedMs != null ? Timestamp.fromMillis(follow.clickedMs) : FieldValue.serverTimestamp(),
          backfill_basis: follow.basis,
          backfilled_at: FieldValue.serverTimestamp(),
        });
      }
      const outcome = await fulfillCompanyFollowIntents({
        db,
        email,
        uid,
        normalizeKey: normalizeCompanyAlertKey,
        groupKey: companyFollowGroupKey,
        via: 'backfill',
        ttlMs: Number.POSITIVE_INFINITY,
        skipIfAnyAlertForKey: true,
      });
      counts.alertsCreated += outcome.created;
      counts.alreadyFollowing += outcome.existing;
      counts.skippedFollows += outcome.skipped + outcome.expired;
      if (outcome.pending > 0) counts.failed += outcome.pending;
    } catch (error) {
      counts.failed += 1;
      log(`   ⚠️  failed for ${maskEmail(email)} (${error?.message || error})`);
    }
  }

  log('');
  log(` candidates (pending marker or company-follow channel): ${counts.candidates}`);
  log(` eligible confirmed subscribers: ${counts.eligibleSubscribers}`);
  log(apply ? ` alerts created: ${counts.alertsCreated} (planned ${counts.alertsPlanned})` : ` alerts that would be created: ${counts.alertsPlanned}`);
  if (apply) log(` already following at write time: ${counts.alreadyFollowing}; skipped: ${counts.skippedFollows}; failed: ${counts.failed}`);
  log(` follow clicks with no reconstructible employer: ${counts.unresolvedFollowEvents}`);
  log(` subscriber skip reasons: ${JSON.stringify(counts.reasons)}`);
  return counts;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runBackfill().then(() => process.exit(0)).catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
