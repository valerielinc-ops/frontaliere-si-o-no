#!/usr/bin/env node
/**
 * send-daily-brief.mjs — the daily "Bollettino del Frontaliere" email: the
 * SAME payload the corpus publishes as the day's edition
 * (`dist/api/daily-brief.json`, one dated article per day), sent to a
 * DEDUPLICATED union of the two subscriber collections.
 *
 * THE LIST IS ONE LIST, NOT TWO. `job_alert_subscribers` and
 * `newsletter_subscribers` are the same people almost entirely (measured
 * 2026-08: 6.854 of 6.864 job-alert addresses also sit in the newsletter
 * collection — summing the two overstates by ~45%). This script unions them
 * by lowercased email:
 *   - newsletter side: status `confirmed` AND the recorded proof of the
 *     double-opt-in click. (This was the stricter bar of a NEW channel until
 *     #5686; the weekly newsletter now shares the same proof gate, from the
 *     same module. It stays stricter only in the `confirmed`-only admission
 *     below, which is about this channel's cadence, not about consent.)
 *   - job-alert side: root docs not excluded by isJobAlertExcluded().
 *   - anyone whose newsletter document records an exclusion — the status
 *     (unsubscribed/inactive or address-suppressed) OR the opt-out stamp in
 *     either spelling — is OUT even if they sit in the job-alert collection:
 *     an explicit broadcast opt-out wins over membership. That rule is now
 *     the system's, not this channel's: #5688 gave the alert senders their
 *     own reading of it (isCrossChannelStop, services/emailSuppression.mjs).
 *   - anyone whose newsletter doc carries NO confirmation stamp is OUT of
 *     every channel, job alert included — see hasConfirmationProof() (#5677).
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - No `last_sent_at` WRITE. The newsletter and job-alert senders exclude
 *     each other through that 36h cooldown; a daily channel that WROTE it
 *     would starve both (they would never fire again). It is READ, but only as
 *     a same-UTC-day calendar check (#5415 §3.3): those two channels reach a
 *     given person about once a week, so "not twice in one day" costs the
 *     brief roughly a day in seven, while a 36h cooldown would cost it every
 *     other day. Parallel channel, own cadence, own `daily_brief_*` fields.
 *   - No job cards → no canary surface. scripts/lib/canaryAd.mjs gates the
 *     broadcast of sponsored job ads; this email carries only aggregate
 *     counts, so there is nothing for the canary gate to gate.
 *   - No AI. The briefing paragraph is deterministic, from the day's numbers.
 *
 * CAPACITY. The union (~8.3k) exceeds the cascade's remaining daily quota on
 * most days. The send is capacity-aware: it takes min(recipients, available
 * quota − 10% buffer) and records progress in
 * newsletter_subscribers/_meta_/campaign_sends/{daily-brief-YYYY-MM-DD} (plus
 * `--2`, `--3`… chunks past 4k addresses — see scripts/lib/campaignResumeLog.mjs),
 * flushed DURING the run, so a same-day rerun RESUMES instead of double-sending
 * and a crash mid-run does not replay what it already delivered. The shortfall
 * is printed; growing provider quotas is an owner decision, not this script's.
 *
 * ORDERING. The edition must already be on the API surface (slugs.json knows
 * the id) so the email links a live page. On a real run a missing edition is
 * a hard refusal (exit 0, retry later); on --dry-run it degrades to a
 * placeholder URL so the recipient count can be measured before phase 4 goes
 * live.
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS, NEWSLETTER_SECRET (signed unsub URLs),
 *      ENABLE_DAILY_BRIEF ('true' to arm — the workflow sets it explicitly,
 *      same convention as ENABLE_JOB_ALERTS), TARGET_EMAIL (single-address
 *      test), TODAY_ISO (pin the day). Flags: --dry-run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewsletterExcluded, isJobAlertExcluded } from '../services/emailSuppression.mjs';
import { isNewsletterOptOutBinding } from '../services/newsletterOptOut.mjs';
import { hasConfirmationProof } from '../services/subscriberConsent.mjs';
import { sanitizeFirstName, nlNormLocale } from '../services/newsletter-template.mjs';
import { buildDailyBriefEmail } from '../services/daily-brief-template.mjs';
import { makeOneClickUnsubscribeUrl, makePreferencesUrl } from '../services/newsletterUrls.mjs';
import { createResumeWriter, fetchAlreadySent, resumeChunkState } from './lib/campaignResumeLog.mjs';
import {
  blockedByAnotherChannelToday,
  engagedSinceLastSend,
  estimateDailyVolume,
  isDueToday,
  isOptOutLink,
  nextCadenceState,
  openedSinceLastSend,
  passesBlockGate,
} from './lib/dailyBriefCadence.mjs';
import { resolveEffectivePreferredHour, computeScheduledSendAt, perUserSendTimeEnabled, logScheduleDistribution } from './lib/send-schedule.mjs';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';
import { ARTICLES_API_BASE as API_BASE } from './lib/articles-api-base.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <alerts@frontaliereticino.ch>';
const DRY_RUN = process.argv.includes('--dry-run');
const QUOTA_BUFFER_RATIO = 0.1; // same 10% headroom as send-job-alerts.mjs
const LOCALES = ['it', 'en', 'de', 'fr'];

/** Localized blog hub paths — the same table pull-articles-api.mjs pins. */
const BLOG_HUB = {
  it: '/articoli-frontaliere/',
  en: '/en/cross-border-articles/',
  de: '/de/grenzgaenger-artikel/',
  fr: '/fr/articles-frontalier/',
};

const TARGET_EMAIL_RAW = (process.env.TARGET_EMAIL || '').trim().toLowerCase();

// ── Firebase Admin (lazy init, same pattern as send-saved-jobs-digest.mjs) ──

let _db = null;
export function __setFirestoreAdminForTest(fakeDb) {
  _db = fakeDb;
}
async function getFirestoreAdmin() {
  if (_db) return _db;
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    }
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    if (cred.project_id) {
      initializeApp({ credential: cert(cred) });
    } else {
      const { applicationDefault } = await import('firebase-admin/app');
      initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    }
  }
  _db = getFirestore();
  return _db;
}

// ── The day's payload, from the corpus API surface ─────────────────────────

async function fetchJson(name) {
  const res = await fetch(`${API_BASE}/${name}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${API_BASE}/${name} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch and validate the payload + the edition's per-locale URLs.
 * @returns {{ brief, editionUrls, refusal }} — refusal is a human reason when
 * the send must not happen (real mode); dry-run degrades URL-side refusals.
 */
export async function loadDayPayload(todayIso, { dryRun = false, fetchImpl = fetchJson } = {}) {
  const manifest = await fetchImpl('manifest.json');
  if (!Number.isFinite(manifest?.counts?.dailyBriefBlocks) || manifest.counts.dailyBriefBlocks < 2) {
    return { refusal: `manifest.counts.dailyBriefBlocks=${manifest?.counts?.dailyBriefBlocks ?? 'absent'} — no usable brief on the surface` };
  }
  const brief = await fetchImpl('daily-brief.json');
  if (brief?.dateIso !== todayIso) {
    return { refusal: `daily-brief.json is for ${brief?.dateIso}, today is ${todayIso} — stale` };
  }
  if (!Number.isFinite(brief?.counts?.availableBlocks) || brief.counts.availableBlocks < 2) {
    return { refusal: `only ${brief?.counts?.availableBlocks ?? 0} available blocks — too thin` };
  }
  const editionId = `bollettino-frontaliere-${todayIso}`;
  const slugs = await fetchImpl('slugs.json');
  const slugMap = slugs?.blog?.[editionId];
  if (!slugMap) {
    if (!dryRun) return { refusal: `edition ${editionId} not in slugs.json — not published yet, retry later` };
    console.warn(`⚠️ [dry-run] edition ${editionId} not on the surface yet — using placeholder URLs`);
  }
  const editionUrls = {};
  for (const locale of LOCALES) {
    const slug = slugMap?.[locale] || slugMap?.it || editionId;
    editionUrls[locale] = `${BASE_URL}${BLOG_HUB[locale]}${slug}/`;
  }
  return { brief, editionUrls, refusal: null };
}

// ── Recipients: the deduplicated union ─────────────────────────────────────

/**
 * The consent gate — one definition, in services/subscriberConsent.mjs, where
 * every sender can reach it. It lived here until #5686 found the weekly
 * newsletter mailing every unconfirmed row for want of the same check; a rule
 * that two senders must agree on cannot live inside one of them.
 *
 * Re-exported so `tests/daily-brief-recipients.test.ts` keeps asserting it
 * against the sender that consumes it, not only against the module.
 */
export { hasConfirmationProof };

/**
 * Pure dedup: union the two collections' rows by lowercased email.
 * @param {Array<{email: string, status?: string, locale?: string, name?: string, doc?: object}>} newsletterRows
 * @param {Array<{email: string, status?: string, doc?: object}>} jobAlertRows
 * @returns {{ recipients: Array, stats: object }}
 */
export function dedupeRecipients(newsletterRows, jobAlertRows) {
  const byEmail = new Map();
  const stats = {
    newsletterSeen: newsletterRows.length,
    jobAlertSeen: jobAlertRows.length,
    newsletterConfirmed: 0,
    newsletterExcluded: 0,
    // Rows held back for want of a confirmation stamp — split by what the
    // `status` field claimed, because the two halves are different defects and
    // the run log has to keep them apart: `status: 'confirmed'` with no stamp
    // is fabricated consent (a recovery procedure wrote it), while `pending`
    // with no stamp is a signup that never completed.
    unconfirmedClaimedConfirmed: 0,
    unconfirmedPending: 0,
    jobAlertEligible: 0,
    jobAlertExcluded: 0,
    jobAlertBlockedUnconfirmed: 0,
    optOutWins: 0,
    union: 0,
    overlap: 0,
  };

  const norm = (e) => String(e || '').trim().toLowerCase();
  const nlByEmail = new Map();
  for (const row of newsletterRows) {
    const email = norm(row.email);
    if (!email || !email.includes('@')) continue;
    nlByEmail.set(email, row);
  }

  for (const [email, row] of nlByEmail) {
    const status = String(row.status || '').trim().toLowerCase();
    // Status AND stamp. `status` is one last-writer-wins field: #5672's
    // resurrection ring overwrote it on 186 documents, 49 of which received
    // that day's brief — this channel is where that was measured. The stamp
    // survives it, in whichever of the two spellings the writer used (#5673),
    // and since #5711 it is append-only — so the shared predicate, never a bare
    // presence check, because only a strictly later re-opt-in lifts it.
    if (isNewsletterExcluded(status) || isNewsletterOptOutBinding(row.doc || row)) {
      stats.newsletterExcluded++;
      continue;
    }
    // NO STAMP → OUT OF EVERY CHANNEL. Not "neutral", not "let the job-alert
    // side decide": an address that never completed the double opt-in is not
    // reachable by this email, and the job-alert loop below re-checks the same
    // predicate so membership in job_alert_subscribers cannot route around it.
    if (!hasConfirmationProof(row)) {
      if (status === 'confirmed') stats.unconfirmedClaimedConfirmed++;
      else stats.unconfirmedPending++;
      continue;
    }
    if (status === 'confirmed') {
      stats.newsletterConfirmed++;
      byEmail.set(email, { email, locale: nlNormLocale(row.locale), name: row.name || null, source: 'newsletter', nlDoc: row.doc || null, jaDoc: null });
    }
    // `pending` WITH the stamp falls through deliberately: it is not admitted
    // from the newsletter side (that side stays confirmed-only) but it does
    // not block the job-alert side either — it is a confirmed subscriber whose
    // status was flipped by the deliverability re-probe, not a missing consent.
  }

  for (const row of jobAlertRows) {
    const email = norm(row.email);
    if (!email || !email.includes('@')) continue;
    const nlRow = nlByEmail.get(email);
    const nlStatus = nlRow ? String(nlRow.status || '').trim().toLowerCase() : null;
    // Explicit broadcast opt-out (or a bounced/complained address) wins over
    // job-alert membership. isNewsletterExcluded already contains every status
    // isAddressSuppressed does, so the second call this line used to make was
    // dead; what was genuinely missing is the stamp, same as the newsletter
    // side above. `nlRow` is null for an address with no newsletter document at
    // all, and the predicate reads that as "nothing recorded" — which is right:
    // job-alert membership is its own basis, and there is no opt-out to honour.
    if (isNewsletterExcluded(nlStatus) || isNewsletterOptOutBinding(nlRow?.doc || nlRow)) {
      stats.optOutWins++;
      continue;
    }
    // The consent gate, restated on this side — this is the hole #5677 was
    // filed for. A newsletter doc that exists but carries no confirmation
    // stamp keeps the address out, however eligible the job alert is; only an
    // address with NO newsletter doc at all enters on job-alert membership
    // alone (job alerts have no double opt-in: the doc exists because the user
    // created the alert).
    if (nlRow && !hasConfirmationProof(nlRow)) {
      stats.jobAlertBlockedUnconfirmed++;
      continue;
    }
    if (isJobAlertExcluded(row.status)) {
      stats.jobAlertExcluded++;
      continue;
    }
    stats.jobAlertEligible++;
    if (byEmail.has(email)) {
      stats.overlap++;
      byEmail.get(email).jaDoc = row.doc || null;
    } else {
      byEmail.set(email, {
        email,
        locale: nlNormLocale(nlRow?.locale || row.locale),
        name: nlRow?.name || null,
        source: 'job-alert',
        nlDoc: nlRow?.doc || null,
        jaDoc: row.doc || null,
      });
    }
  }

  // Deterministic order: confirmed newsletter members first (double-opt-in,
  // engaged), then job-alert-only; alphabetical within each group — so a
  // capacity cut is stable across reruns and the resume set stays coherent.
  const recipients = [...byEmail.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'newsletter' ? -1 : 1;
    return a.email.localeCompare(b.email);
  });
  stats.union = recipients.length;
  return { recipients, stats };
}

async function fetchRecipients(db) {
  const nlSnap = await db.collection('newsletter_subscribers').get();
  const newsletterRows = [];
  for (const doc of nlSnap.docs) {
    if (doc.id === '_meta_') continue;
    const d = doc.data() || {};
    newsletterRows.push({
      email: d.email || doc.id,
      status: d.status,
      locale: d.language || d.locale || 'it',
      name: d.first_name || d.name || null,
      doc: d,
    });
  }

  // listDocuments, not .get(): job_alert_subscribers roots can be "virtual"
  // parents (only the alerts subcollection was ever written) and a collection
  // get() would silently miss them.
  const jaRefs = await db.collection('job_alert_subscribers').listDocuments();
  const jobAlertRows = [];
  for (let i = 0; i < jaRefs.length; i += 200) {
    const chunk = jaRefs.slice(i, i + 200);
    const snaps = await db.getAll(...chunk);
    for (const snap of snaps) {
      const d = snap.exists ? snap.data() || {} : {};
      jobAlertRows.push({ email: snap.ref.id, status: d.status, locale: d.language || d.locale || null, doc: d });
    }
  }
  return { newsletterRows, jobAlertRows };
}

// ── Campaign resume (same-day rerun must not double-send) ──────────────────

/**
 * The resume log lives in scripts/lib/campaignResumeLog.mjs, shared with the
 * weekly newsletter: both channels had grown their own copy of the same read /
 * arrayUnion / filter, and both copies carried the same two defects — one array
 * in one 1 MiB document, and marking only at the end of a run, so a crash
 * halfway through re-sent to everyone already served (#5415 §3.6).
 *
 * `emails` is this channel's field name in campaign documents already on disk;
 * the newsletter's is `sentEmails`. Unifying the spelling would orphan whatever
 * campaign is in flight when this ships.
 */
const RESUME_LOG = { campaignId: null, field: 'emails' };

async function persistDelivery(db, { email, campaignId }, sendResult) {
  try {
    const deliveryDocId = buildDeliveryDocId(campaignId, email);
    await db.collection('newsletter_subscribers').doc(email)
      .collection('campaign_deliveries').doc(deliveryDocId).set({
        email,
        campaign_id: campaignId,
        message_id: sendResult?.messageId || null,
        provider: sendResult?.provider || null,
        scheduled_for: sendResult?.scheduledFor ?? null,
        sent_at: new Date(),
      }, { merge: true });
  } catch (e) {
    console.warn('⚠️ daily-brief delivery persist failed:', e?.message);
  }
}

// ── Email body ─────────────────────────────────────────────────────────────

/**
 * Build one recipient's bulletin.
 *
 * The dress lives in services/daily-brief-template.mjs and is the bulletin's
 * own, not the weekly newsletter's. Until #5415 this function called
 * `buildNewsletter()`, which parametrises none of its own chrome: recipients
 * got the weekly masthead, the weekly issue counter (identical on consecutive
 * days), "ecco cosa succede ai tuoi soldi QUESTA SETTIMANA" over daily numbers,
 * the weekly's hardcoded 2.8% / CHF 467 placeholder metrics, and a <title>
 * reading "Frontaliere Weekly". Only the subject differed.
 */
export function buildBriefEmail({ recipient, brief, editionUrls, editionTitles, cadenceDays }) {
  const locale = LOCALES.includes(recipient.locale) ? recipient.locale : 'it';
  const editionTitle = editionTitles?.[locale] || `Bollettino del frontaliere \u2013 ${brief.dateIso}`;
  // RFC 8058 target, not the SPA page: functions/src/lib/newsletterUrls.js
  // documents makeUnsubscribeUrl as "NOT a valid List-Unsubscribe header
  // target", and the brief was the one sender of the three still pointing at it.
  const unsubscribeUrl = makeOneClickUnsubscribeUrl(recipient.email);
  const preferencesUrl = makePreferencesUrl(recipient.email, locale);

  const { html, text } = buildDailyBriefEmail({
    locale,
    brief,
    editionUrl: editionUrls[locale],
    editionTitle,
    recipientName: sanitizeFirstName(recipient.name),
    cadenceDays,
    unsubscribeUrl,
    preferencesUrl,
  });

  return { subject: editionTitle, html, text, unsubscribeUrl, preferencesUrl, locale };
}

/**
 * The email headers, aligned with what send-newsletter.mjs already sends.
 *
 * The brief was the only one of the three senders whose `List-Unsubscribe`
 * pointed at `makeUnsubscribeUrl` — the SPA page that
 * functions/src/lib/newsletterUrls.js documents, in as many words, as "NOT a
 * valid List-Unsubscribe header target" (#5415 §2c). Gmail and Yahoo require
 * RFC 8058 one-click from bulk senders, and this channel's first mass send
 * would have been its first impression on both.
 */
export function buildBriefHeaders({ email, campaignId, unsubscribeUrl }) {
  const mailto = `mailto:alerts@frontaliereticino.ch`
    + `?subject=${encodeURIComponent('Unsubscribe Bollettino del Frontaliere')}`
    + `&body=${encodeURIComponent(`Please unsubscribe ${email} from the daily brief.`)}`;
  const emailKey = Buffer.from(String(email).toLowerCase()).toString('hex').slice(0, 24);
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>, <${mailto}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'List-ID': 'Bollettino del Frontaliere <daily.frontaliereticino.ch>',
    'Feedback-ID': `daily-brief:${campaignId}:frontaliere-ticino`,
    'X-Entity-Ref-ID': `${campaignId}-${emailKey}`,
    'X-Campaign-Id': campaignId,
    'X-Auto-Response-Suppress': 'OOF, AutoReply',
  };
}

// ── Cadence ────────────────────────────────────────────────────────────────

/**
 * The fields the cadence engine reads for one recipient.
 *
 * The `daily_brief_*` state has one home — `newsletter_subscribers/{email}` —
 * but the engagement timestamps it seeds from are written by the webhooks onto
 * whichever collection the send went through, so the job-alert doc is the
 * fallback. Without it, the ~10 addresses that are job-alert-only would look
 * like people who have never engaged with anything and seed straight to weekly.
 */
export function cadenceStateOf(recipient) {
  const nl = recipient.nlDoc || {};
  const ja = recipient.jaDoc || {};
  return {
    daily_brief_tier: nl.daily_brief_tier,
    daily_brief_last_sent_at: nl.daily_brief_last_sent_at,
    daily_brief_sends_since_engagement: nl.daily_brief_sends_since_engagement,
    daily_brief_frequency_override: nl.daily_brief_frequency_override,
    daily_brief_last_send_provider: nl.daily_brief_last_send_provider,
    last_click_at: nl.last_click_at ?? ja.last_click_at ?? null,
    last_open_at: nl.last_open_at ?? ja.last_open_at ?? null,
    // The URL travels WITH the timestamp or the pair is useless: a bare
    // `last_click_at` cannot tell a read from an unsubscribe, and the cadence
    // engine promotes on it (#5674). Both halves come from the same document,
    // so the fallback to the job-alert doc has to move them together.
    last_clicked_url: nl.last_click_at != null
      ? (nl.last_clicked_url ?? null)
      : (ja.last_clicked_url ?? null),
    daily_brief_last_human_click_at: nl.daily_brief_last_human_click_at ?? null,
    // The ceiling the accepted formula sets (#5679). Absent on almost every
    // document until #5678 backfills it, and `consentCeilingDays` reads the
    // absence as weekly — so forwarding the field costs nothing and forwarding
    // `undefined` is what the tolerant default is for.
    consent_max_frequency_days: nl.consent_max_frequency_days ?? null,
  };
}

/**
 * Split the eligible union into "gets today's edition" and "does not, and why".
 *
 * Order matters and is load-bearing. The cadence gate runs BEFORE the capacity
 * cut, never after (#5415 §3.8): a recipient dropped for capacity has not been
 * sent an email they ignored, so counting that as a silent send would demote
 * people for our quota. It also means the cut now falls on a list that is
 * already ~40% smaller, which is what stops the alphabetical tail from starving.
 *
 * Pure — `nowMs`, `todayIso` and the click attribution come in as arguments.
 */
export function applyCadence(recipients, { brief, todayIso, nowMs, briefClickAtByEmail = null }) {
  const due = [];
  const stats = {
    evaluated: recipients.length,
    off: 0, notDue: 0, thinEdition: 0, crossChannel: 0,
    crossChannelBy: {}, tierPopulation: {}, dueByTier: {},
  };
  const availableBlocks = brief?.counts?.availableBlocks;

  for (const recipient of recipients) {
    const state = cadenceStateOf(recipient);
    const verdict = isDueToday(state, todayIso, nowMs);

    if (verdict.tierDays == null) { stats.off++; continue; }
    stats.tierPopulation[verdict.tierDays] = (stats.tierPopulation[verdict.tierDays] || 0) + 1;
    if (!verdict.due) { stats.notDue++; continue; }

    if (!passesBlockGate(availableBlocks, verdict.tierDays)) { stats.thinEdition++; continue; }

    const cross = blockedByAnotherChannelToday({ nlDoc: recipient.nlDoc, jaDoc: recipient.jaDoc, todayIso });
    if (cross.blocked) {
      stats.crossChannel++;
      stats.crossChannelBy[cross.channel] = (stats.crossChannelBy[cross.channel] || 0) + 1;
      continue;
    }

    stats.dueByTier[verdict.tierDays] = (stats.dueByTier[verdict.tierDays] || 0) + 1;
    due.push({
      ...recipient,
      cadence: verdict,
      state,
      engaged: engagedSinceLastSend({ sub: state, briefClickAtMs: briefClickAtByEmail?.get(recipient.email) ?? null }),
      opened: openedSinceLastSend(state),
    });
  }

  // Tier-first ordering so that, if capacity still bites, it bites the people
  // who asked for the least — not whoever sorts last alphabetically.
  due.sort((a, b) => a.cadence.tierDays - b.cadence.tierDays || a.email.localeCompare(b.email));
  return { due, stats };
}

/**
 * Clicks attributable to the BRIEF, not to the weekly (#5415 §3.2a): a
 * `clicked_at` on a `campaign_deliveries` doc whose `campaign_id` starts with
 * `daily-brief-`. Without that filter, a click on the weekly newsletter would
 * promote someone's BRIEF cadence.
 *
 * A collection-group query on `clicked_at` needs an index that may not exist in
 * this project. Rather than fail the send over telemetry, this degrades to the
 * subscriber-level `last_click_at` and says so — the sender prints which mode it
 * ran in, and the index to create if the precise one is wanted.
 */
async function fetchBriefClicks(db, sinceMs) {
  try {
    const snap = await db.collectionGroup('campaign_deliveries')
      .where('clicked_at', '>=', new Date(sinceMs))
      .get();
    const byEmail = new Map();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (!String(data.campaign_id || '').startsWith('daily-brief-')) continue;
      const email = String(data.email || '').toLowerCase();
      const clickedAt = data.clicked_at?.toMillis?.() ?? new Date(data.clicked_at).getTime();
      if (!email || !Number.isFinite(clickedAt)) continue;
      // A click on the way out is not engagement (#5674). `clicked_at` and
      // `last_clicked_url` are written by the same webhook in the same update,
      // so the URL here describes the timestamp here — and letting it through
      // promotes, immediately, exactly the person who was trying to leave.
      if (isOptOutLink(data.last_clicked_url)) continue;
      // Four of the five providers write their events to a doc id that differs
      // from the send path's (scripts/report-send-hour-impact.mjs), so the same
      // click can appear twice: keep the latest, as newsletter-ab-data.mjs does.
      if (!byEmail.has(email) || byEmail.get(email) < clickedAt) byEmail.set(email, clickedAt);
    }
    return { byEmail, mode: 'brief-attributed' };
  } catch (error) {
    console.warn(
      `⚠️ brief click attribution unavailable (${error?.message}) — falling back to subscriber-level last_click_at.\n`
      + '   A click on the weekly will therefore count as engagement with the brief.\n'
      + '   To get the precise signal, add a collection-group index on campaign_deliveries.clicked_at.',
    );
    return { byEmail: null, mode: 'subscriber-level' };
  }
}

/** Persist the recipient's new cadence state next to their delivery record. */
async function persistCadence(db, { email, state, engaged, opened, provider, sentAtIso }) {
  try {
    await db.collection('newsletter_subscribers').doc(email).set(
      nextCadenceState({ sub: state, engaged, opened, sentAtIso, provider }),
      { merge: true },
    );
  } catch (e) {
    console.warn('⚠️ daily-brief cadence persist failed:', e?.message);
  }
}


// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!DRY_RUN && process.env.ENABLE_DAILY_BRIEF !== 'true') {
    console.log('🚫 ENABLE_DAILY_BRIEF is not "true" — refusing a real send (dry-run works without it).');
    return;
  }

  const todayIso = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);
  const campaignId = `daily-brief-${todayIso}`;
  console.log(`📮 Daily brief email — ${todayIso}, mode: ${DRY_RUN ? 'DRY RUN' : 'SEND'}`);

  const { brief, editionUrls, refusal } = await loadDayPayload(todayIso, { dryRun: DRY_RUN });
  if (refusal) {
    console.log(`🚫 no send today: ${refusal}`);
    return;
  }
  // The subject IS the edition title, per locale, from the API meta surface.
  const editionTitles = {};
  for (const locale of LOCALES) {
    try {
      const meta = await fetchJson(`meta-${locale}.json`);
      const t = meta?.[`blog.article.bollettino-frontaliere-${todayIso}.title`];
      if (t) editionTitles[locale] = t;
    } catch { /* fall back to the generic title in buildBriefEmail */ }
  }

  const db = await getFirestoreAdmin();
  const { newsletterRows, jobAlertRows } = await fetchRecipients(db);
  const { recipients, stats } = dedupeRecipients(newsletterRows, jobAlertRows);
  console.log(
    `👥 dedup: newsletter ${stats.newsletterSeen} (confirmed ${stats.newsletterConfirmed}) ∪ job-alert ${stats.jobAlertSeen} (eligible ${stats.jobAlertEligible})` +
    ` → UNION ${stats.union} (overlap ${stats.overlap}, opt-out wins ${stats.optOutWins})`,
  );
  // Printed unconditionally, including when it is zero: this is the LPD-facing
  // number (#5677) and a silent gate is how the previous one stayed open.
  console.log(
    `🔒 double opt-in: trattenuti ${stats.unconfirmedClaimedConfirmed + stats.unconfirmedPending}` +
    ` senza timbro di conferma (status 'confirmed' senza prova: ${stats.unconfirmedClaimedConfirmed},` +
    ` non confermati: ${stats.unconfirmedPending}) — di cui ${stats.jobAlertBlockedUnconfirmed} avevano un job alert che li avrebbe fatti entrare`,
  );

  const nowMs = Date.now();
  let pool = recipients;
  if (TARGET_EMAIL_RAW) {
    pool = pool.filter((r) => r.email === TARGET_EMAIL_RAW);
    console.log(`\u{1F3AF} TARGET_EMAIL \u2014 pool reduced to ${pool.length}`);
  }

  // Attribution first: the cadence gate below needs to know who clicked THIS
  // channel, not just who clicked something of ours.
  const { byEmail: briefClickAtByEmail, mode: attributionMode } = await fetchBriefClicks(db, nowMs - 30 * 24 * 60 * 60 * 1000);

  // Cadence BEFORE capacity (§3.8). A recipient cut for quota was never sent
  // anything to ignore, so the cut must not reach the demotion counters.
  const { due, stats: cadenceStats } = applyCadence(pool, { brief, todayIso, nowMs, briefClickAtByEmail });
  console.log(
    `\u{1F503} cadence (${attributionMode}): ${cadenceStats.evaluated} eligible \u2192 ${due.length} due today`
    + ` (not due ${cadenceStats.notDue}, channel off ${cadenceStats.off}, thin edition ${cadenceStats.thinEdition},`
    + ` already emailed today by another channel ${cadenceStats.crossChannel}${Object.keys(cadenceStats.crossChannelBy).length ? ` ${JSON.stringify(cadenceStats.crossChannelBy)}` : ''})`,
  );
  console.log(`   tier population: ${JSON.stringify(cadenceStats.tierPopulation)} \u2192 steady-state \u2248 ${estimateDailyVolume(cadenceStats.tierPopulation)}/day`);
  console.log(`   due by tier:     ${JSON.stringify(cadenceStats.dueByTier)}`);
  pool = due;

  RESUME_LOG.campaignId = campaignId;
  const { sent: alreadySent, chunkSizes } = await fetchAlreadySent(db, RESUME_LOG);
  if (alreadySent.size > 0) {
    pool = pool.filter((r) => !alreadySent.has(r.email));
    console.log(`\u267B\uFE0F  resume: ${alreadySent.size} already sent today, ${pool.length} remaining`);
  }

  const { getAvailableCascadeQuota, sendEmailCascade } = await import('./lib/email-cascade.mjs');
  const quota = await getAvailableCascadeQuota();
  const cap = Math.max(0, Math.floor(quota * (1 - QUOTA_BUFFER_RATIO)));
  const batch = pool.slice(0, cap);
  console.log(`\u{1F4E6} capacity: quota ${quota}, cap ${cap} \u2192 sending ${batch.length}/${pool.length}${pool.length > batch.length ? ` (${pool.length - batch.length} deferred to a rerun/tomorrow)` : ''}`);

  // Per-user preferred send hour (mailgun/maileroo/resend honor scheduledAt).
  const metaDoc = await db.collection('newsletter_subscribers').doc('_meta_').get();
  const globalHour = metaDoc.exists ? metaDoc.data()?.global_preferred_send_hour_utc ?? null : null;
  const scheduling = perUserSendTimeEnabled();

  const emails = batch.map((recipient) => {
    const built = buildBriefEmail({ recipient, brief, editionUrls, editionTitles, cadenceDays: recipient.cadence.tierDays });
    let scheduledAt = null;
    if (scheduling) {
      const { hourUtc } = resolveEffectivePreferredHour({
        subscriberDoc: recipient.nlDoc,
        fallbackDoc: recipient.jaDoc,
        globalHour,
      });
      if (hourUtc != null) {
        const iso = computeScheduledSendAt({ preferredHourUtc: hourUtc, email: recipient.email });
        // A daily edition must land on ITS day: computeScheduledSendAt rolls a
        // passed slot to tomorrow, which for this channel would deliver today's
        // numbers after tomorrow's edition. Passed slot → immediate instead.
        if (iso && iso.slice(0, 10) === todayIso) scheduledAt = iso;
      }
    }
    return {
      payload: {
        from: FROM_EMAIL,
        to: [recipient.email],
        subject: built.subject,
        html: built.html,
        text: built.text,
        ...(scheduledAt ? { scheduledAt } : {}),
        tags: [
          { name: 'type', value: 'daily-brief' },
          { name: 'campaign_id', value: campaignId },
        ],
        headers: buildBriefHeaders({ email: recipient.email, campaignId, unsubscribeUrl: built.unsubscribeUrl }),
      },
      recipient: { email: recipient.email, state: recipient.state, engaged: recipient.engaged, opened: recipient.opened },
      meta: { type: 'daily-brief', campaignId, scheduledAt, tierDays: recipient.cadence.tierDays },
    };
  });

  if (DRY_RUN) {
    const byLocale = {};
    for (const r of batch) byLocale[r.locale] = (byLocale[r.locale] || 0) + 1;
    console.log('\u{1F4CA} [dry-run] recipients by locale:', byLocale);
    logScheduleDistribution(emails.map((e) => ({ scheduledAt: e.meta.scheduledAt })), { getScheduledAt: (i) => i.scheduledAt, indent: '   ' });
    if (emails[0]) {
      console.log(`\u{1F4DD} [dry-run] sample subject: ${emails[0].payload.subject}`);
      console.log(`\u{1F4DD} [dry-run] sample to: ${emails[0].payload.to[0]}, tier ${emails[0].meta.tierDays}d, scheduledAt: ${emails[0].meta.scheduledAt ?? 'immediate'}`);
      console.log(`\u{1F4DD} [dry-run] List-Unsubscribe: ${emails[0].payload.headers['List-Unsubscribe']}`);
    }
    const starved = cadenceStats.evaluated - cadenceStats.off - due.length;
    console.log(
      `\u2705 [dry-run] would send ${emails.length} emails (eligible ${stats.union}, due ${due.length}, capacity cap ${cap}).`
      + ` Deferred to a later day: ${starved}. Steady-state estimate ${estimateDailyVolume(cadenceStats.tierPopulation)}/day vs cap ${cap}.`
      + ' Nothing sent, nothing written.',
    );
    return;
  }

  // Flushed during the run rather than once at the end: a crash mid-run used to
  // leave the whole day unmarked, so the retry re-sent to everyone already
  // served (§3.6).
  const resume = createResumeWriter(db, RESUME_LOG, resumeChunkState(chunkSizes));

  const sentAtIso = new Date().toISOString();
  const result = await sendEmailCascade(emails, {
    concurrency: 3,
    onSent: async (item, sendResult) => {
      const { email, state, engaged, opened } = item.recipient;
      await persistDelivery(db, { email, campaignId }, sendResult);
      await persistCadence(db, { email, state, engaged, opened, provider: sendResult?.provider || null, sentAtIso });
      await resume.record(email);
    },
  });
  await resume.flush();
  console.log(`\n📊 Done — sent ${result.sent.length}, failed ${result.failed.length}, resume-marked ${resume.count()}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ send-daily-brief.mjs failed:', error);
    process.exitCode = 1;
  });
}

export { main };
