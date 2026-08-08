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
 *   - newsletter side: status `confirmed` ONLY. (send-newsletter.mjs includes
 *     `pending` deliberately for its weekly campaign; a NEW daily channel is
 *     held to the stricter bar — double-opt-in confirmed.)
 *   - job-alert side: root docs not excluded by isJobAlertExcluded().
 *   - anyone whose newsletter status is excluded (unsubscribed/inactive or
 *     address-suppressed) is OUT even if they sit in the job-alert
 *     collection: an explicit broadcast opt-out wins over membership.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - No `last_sent_at` read OR write. The newsletter and job-alert senders
 *     exclude each other through that 36h cooldown; a daily channel that
 *     WROTE it would starve both (they would never fire again), and one that
 *     READ it could never be daily. Parallel channel, own cadence.
 *   - No job cards → no canary surface. scripts/lib/canaryAd.mjs gates the
 *     broadcast of sponsored job ads; this email carries only aggregate
 *     counts, so there is nothing for the canary gate to gate.
 *   - No AI. The briefing paragraph is deterministic, from the day's numbers.
 *
 * CAPACITY. The union (~8.3k) exceeds the cascade's remaining daily quota on
 * most days. The send is capacity-aware: it takes min(recipients, available
 * quota − 10% buffer) and records progress in
 * newsletter_subscribers/_meta_/campaign_sends/{daily-brief-YYYY-MM-DD}, so a
 * same-day rerun RESUMES instead of double-sending. The shortfall is printed;
 * growing provider quotas is an owner decision, not this script's.
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
import { isNewsletterExcluded, isJobAlertExcluded, isAddressSuppressed } from '../services/emailSuppression.mjs';
import { buildNewsletter, sanitizeFirstName, nlNormLocale } from '../services/newsletter-template.mjs';
import { makeUnsubscribeUrl, makePreferencesUrl } from '../services/newsletterUrls.mjs';
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
    jobAlertEligible: 0,
    jobAlertExcluded: 0,
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
    if (status === 'confirmed') {
      stats.newsletterConfirmed++;
      byEmail.set(email, { email, locale: nlNormLocale(row.locale), name: row.name || null, source: 'newsletter', nlDoc: row.doc || null, jaDoc: null });
    } else if (isNewsletterExcluded(status)) {
      stats.newsletterExcluded++;
    }
    // pending and other non-statuses: neither in nor counted as excluded —
    // they can still enter through the job-alert side below (unless excluded).
  }

  for (const row of jobAlertRows) {
    const email = norm(row.email);
    if (!email || !email.includes('@')) continue;
    const nlRow = nlByEmail.get(email);
    const nlStatus = nlRow ? String(nlRow.status || '').trim().toLowerCase() : null;
    // Explicit broadcast opt-out (or a bounced/complained address) wins over
    // job-alert membership.
    if (nlStatus && (isNewsletterExcluded(nlStatus) || isAddressSuppressed(nlStatus))) {
      stats.optOutWins++;
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

async function fetchAlreadySent(db, campaignId) {
  const doc = await db.collection('newsletter_subscribers').doc('_meta_')
    .collection('campaign_sends').doc(campaignId).get();
  return new Set(doc.exists ? doc.data()?.emails || [] : []);
}

async function markSent(db, campaignId, emails) {
  if (emails.length === 0) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  await db.collection('newsletter_subscribers').doc('_meta_')
    .collection('campaign_sends').doc(campaignId)
    .set({ emails: FieldValue.arrayUnion(...emails), updated_at: new Date() }, { merge: true });
}

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

const BRIEF_STRINGS = {
  it: {
    briefing: (b) => {
      const parts = [];
      if (b.blocks.borderWait?.available) {
        const w = b.blocks.borderWait;
        parts.push(w.worst.waitMinutes >= 10
          ? `Stamattina l'attesa più lunga ai valichi è a <strong>${w.worst.name}: ${w.worst.waitMinutes} minuti</strong> (${w.zeroWaitCount} valichi senza coda su ${w.count}).`
          : `Stamattina si passa: ${w.zeroWaitCount} valichi su ${w.count} senza coda, attesa massima ${w.worst.waitMinutes} minuti (${w.worst.name}).`);
      }
      if (b.blocks.fuel?.available && b.blocks.fuel.cheapestItaly[0]) {
        const f = b.blocks.fuel.cheapestItaly[0];
        parts.push(`Benzina: il minimo tra i comuni di confine è <strong>${f.minPriceEur.toFixed(3).replace('.', ',')} €/L a ${f.municipality}</strong>.`);
      }
      if (b.blocks.jobs?.available && Number.isFinite(b.blocks.jobs.yesterdayAdded)) {
        parts.push(`Ieri <strong>${b.blocks.jobs.yesterdayAdded} nuovi annunci</strong> di lavoro in Svizzera.`);
      }
      return parts.map((p) => `<p>${p}</p>`).join('');
    },
    textIntro: 'I numeri di oggi per i frontalieri:',
    readMore: 'Leggi il bollettino completo',
  },
  en: {
    briefing: (b) => {
      const parts = [];
      if (b.blocks.borderWait?.available) {
        const w = b.blocks.borderWait;
        parts.push(w.worst.waitMinutes >= 10
          ? `This morning's longest border wait is at <strong>${w.worst.name}: ${w.worst.waitMinutes} minutes</strong> (${w.zeroWaitCount} of ${w.count} crossings queue-free).`
          : `Smooth crossing this morning: ${w.zeroWaitCount} of ${w.count} crossings queue-free, longest wait ${w.worst.waitMinutes} minutes (${w.worst.name}).`);
      }
      if (b.blocks.fuel?.available && b.blocks.fuel.cheapestItaly[0]) {
        const f = b.blocks.fuel.cheapestItaly[0];
        parts.push(`Fuel: the border-municipality low is <strong>€${f.minPriceEur.toFixed(3)}/L in ${f.municipality}</strong>.`);
      }
      if (b.blocks.jobs?.available && Number.isFinite(b.blocks.jobs.yesterdayAdded)) {
        parts.push(`<strong>${b.blocks.jobs.yesterdayAdded} new Swiss job listings</strong> landed yesterday.`);
      }
      return parts.map((p) => `<p>${p}</p>`).join('');
    },
    textIntro: "Today's numbers for cross-border commuters:",
    readMore: 'Read the full brief',
  },
  de: {
    briefing: (b) => {
      const parts = [];
      if (b.blocks.borderWait?.available) {
        const w = b.blocks.borderWait;
        parts.push(w.worst.waitMinutes >= 10
          ? `Die längste Wartezeit heute Morgen: <strong>${w.worst.name}, ${w.worst.waitMinutes} Minuten</strong> (${w.zeroWaitCount} von ${w.count} Übergängen ohne Warteschlange).`
          : `Heute Morgen läuft es: ${w.zeroWaitCount} von ${w.count} Übergängen ohne Warteschlange, längste Wartezeit ${w.worst.waitMinutes} Minuten (${w.worst.name}).`);
      }
      if (b.blocks.fuel?.available && b.blocks.fuel.cheapestItaly[0]) {
        const f = b.blocks.fuel.cheapestItaly[0];
        parts.push(`Benzin: Tiefstpreis der Grenzgemeinden <strong>${f.minPriceEur.toFixed(3).replace('.', ',')} €/L in ${f.municipality}</strong>.`);
      }
      if (b.blocks.jobs?.available && Number.isFinite(b.blocks.jobs.yesterdayAdded)) {
        parts.push(`Gestern <strong>${b.blocks.jobs.yesterdayAdded} neue Stellenangebote</strong> in der Schweiz.`);
      }
      return parts.map((p) => `<p>${p}</p>`).join('');
    },
    textIntro: 'Die Zahlen von heute für Grenzgänger:',
    readMore: 'Zum vollständigen Bulletin',
  },
  fr: {
    briefing: (b) => {
      const parts = [];
      if (b.blocks.borderWait?.available) {
        const w = b.blocks.borderWait;
        parts.push(w.worst.waitMinutes >= 10
          ? `Ce matin, l'attente la plus longue est à <strong>${w.worst.name} : ${w.worst.waitMinutes} minutes</strong> (${w.zeroWaitCount} passages sans file sur ${w.count}).`
          : `Ça roule ce matin : ${w.zeroWaitCount} passages sur ${w.count} sans file, attente maximale ${w.worst.waitMinutes} minutes (${w.worst.name}).`);
      }
      if (b.blocks.fuel?.available && b.blocks.fuel.cheapestItaly[0]) {
        const f = b.blocks.fuel.cheapestItaly[0];
        parts.push(`Essence : le minimum des communes frontalières est <strong>${f.minPriceEur.toFixed(3).replace('.', ',')} €/L à ${f.municipality}</strong>.`);
      }
      if (b.blocks.jobs?.available && Number.isFinite(b.blocks.jobs.yesterdayAdded)) {
        parts.push(`Hier, <strong>${b.blocks.jobs.yesterdayAdded} nouvelles offres d'emploi</strong> en Suisse.`);
      }
      return parts.map((p) => `<p>${p}</p>`).join('');
    },
    textIntro: "Les chiffres du jour pour les frontaliers :",
    readMore: 'Lire le bulletin complet',
  },
};

/** Build one recipient's email via the shared newsletter template. */
export function buildBriefEmail({ recipient, brief, editionUrls, editionTitles }) {
  const locale = LOCALES.includes(recipient.locale) ? recipient.locale : 'it';
  const s = BRIEF_STRINGS[locale];
  const fx = brief.blocks.exchange;
  const url = editionUrls[locale];
  const title = editionTitles?.[locale] || `Bollettino del frontaliere – ${brief.dateIso}`;
  const unsubscribeUrl = makeUnsubscribeUrl(recipient.email);

  const html = buildNewsletter({
    locale,
    recipientName: sanitizeFirstName(recipient.name),
    preheaderText: title,
    exchangeRate: fx?.available ? { rate: fx.rate, previousRate: fx.prevRate } : undefined,
    aiBriefing: s.briefing(brief),
    totalJobs: brief.blocks.jobs?.available ? brief.blocks.jobs.activeJobs : 0,
    article: { title, excerpt: s.readMore, url },
    unsubscribeUrl,
    preferencesUrl: makePreferencesUrl(recipient.email, locale),
  });

  const textLines = [s.textIntro];
  const w = brief.blocks.borderWait;
  if (w?.available) textLines.push(`- ${w.worst.name}: ${w.worst.waitMinutes} min`);
  if (fx?.available) textLines.push(`- 1 CHF = ${fx.rate} EUR`);
  const fuel = brief.blocks.fuel;
  if (fuel?.available && fuel.cheapestItaly[0]) textLines.push(`- ${fuel.cheapestItaly[0].municipality}: ${fuel.cheapestItaly[0].minPriceEur} EUR/L`);
  const jobs = brief.blocks.jobs;
  if (jobs?.available && Number.isFinite(jobs.yesterdayAdded)) textLines.push(`- +${jobs.yesterdayAdded} nuovi annunci`);
  textLines.push('', `${s.readMore}: ${url}`);

  return { subject: title, html, text: textLines.join('\n'), unsubscribeUrl, locale };
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

  let pool = recipients;
  if (TARGET_EMAIL_RAW) {
    pool = pool.filter((r) => r.email === TARGET_EMAIL_RAW);
    console.log(`🎯 TARGET_EMAIL — pool reduced to ${pool.length}`);
  }

  const alreadySent = await fetchAlreadySent(db, campaignId);
  if (alreadySent.size > 0) {
    pool = pool.filter((r) => !alreadySent.has(r.email));
    console.log(`♻️  resume: ${alreadySent.size} already sent today, ${pool.length} remaining`);
  }

  const { getAvailableCascadeQuota, sendEmailCascade } = await import('./lib/email-cascade.mjs');
  const quota = await getAvailableCascadeQuota();
  const cap = Math.max(0, Math.floor(quota * (1 - QUOTA_BUFFER_RATIO)));
  const batch = pool.slice(0, cap);
  console.log(`📦 capacity: quota ${quota}, cap ${cap} → sending ${batch.length}/${pool.length}${pool.length > batch.length ? ` (${pool.length - batch.length} deferred to a rerun/tomorrow)` : ''}`);

  // Per-user preferred send hour (mailgun/maileroo/resend honor scheduledAt).
  const metaDoc = await db.collection('newsletter_subscribers').doc('_meta_').get();
  const globalHour = metaDoc.exists ? metaDoc.data()?.global_preferred_send_hour_utc ?? null : null;
  const scheduling = perUserSendTimeEnabled();

  const emails = batch.map((recipient) => {
    const built = buildBriefEmail({ recipient, brief, editionUrls, editionTitles });
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
        headers: {
          'Feedback-ID': `daily-brief:${campaignId}:frontaliere-ticino`,
          'List-Unsubscribe': `<${built.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      recipient: { email: recipient.email },
      meta: { type: 'daily-brief', campaignId, scheduledAt },
    };
  });

  if (DRY_RUN) {
    const byLocale = {};
    for (const r of batch) byLocale[r.locale] = (byLocale[r.locale] || 0) + 1;
    console.log('📊 [dry-run] recipients by locale:', byLocale);
    logScheduleDistribution(emails.map((e) => ({ scheduledAt: e.meta.scheduledAt })), { getScheduledAt: (i) => i.scheduledAt, indent: '   ' });
    if (emails[0]) {
      console.log(`📝 [dry-run] sample subject: ${emails[0].payload.subject}`);
      console.log(`📝 [dry-run] sample to: ${emails[0].payload.to[0]}, scheduledAt: ${emails[0].meta.scheduledAt ?? 'immediate'}`);
    }
    console.log(`✅ [dry-run] would send ${emails.length} emails (union ${stats.union}, capacity cap ${cap}). Nothing sent, nothing written.`);
    return;
  }

  const sentEmails = [];
  const result = await sendEmailCascade(emails, {
    concurrency: 3,
    onSent: (item, sendResult) => {
      const email = item.recipient.email;
      sentEmails.push(email);
      return persistDelivery(db, { email, campaignId }, sendResult);
    },
  });
  await markSent(db, campaignId, sentEmails);
  console.log(`\n📊 Done — sent ${result.sent.length}, failed ${result.failed.length}, resume-marked ${sentEmails.length}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ send-daily-brief.mjs failed:', error);
    process.exitCode = 1;
  });
}

export { main };
