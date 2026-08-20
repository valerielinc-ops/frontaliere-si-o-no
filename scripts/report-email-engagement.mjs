#!/usr/bin/env node

/**
 * report-email-engagement.mjs — weekly open/click rates per provider and per
 * email type, plus the three measurement-integrity counters that say whether
 * those rates can be trusted at all.
 *
 * ── Why it exists ──────────────────────────────────────────────────────────
 *
 * The August 2026 audit of this data found that the headline numbers were
 * wrong in two directions at once, and nothing in the repo would have said so:
 *
 *   1. 7.876 messages in 20 days had their engagement DISCARDED — every
 *      Maileroo send that was not a job alert or the weekly newsletter, because
 *      only those two senders wrote the lookup record Maileroo's recipient-less
 *      open/click webhooks need. `welcome` read 0,00% via Maileroo and 46,43%
 *      via Mailgun in the same window.
 *   2. 7.945 messages could not be told apart by campaign, because the webhook
 *      filed them under a raw provider message id instead of their campaign.
 *
 * Both are fixed (see functions/src/lib/mailerooRef.js). This report is the
 * instrument that keeps them fixed: `unmeasurable`, `unattributed` and
 * `provider_missing` are expected to sit at ~0 now, so any climb is the
 * regression itself, visible before anyone reads a rate off a broken denominator.
 *
 * ── What it measures, and the two traps it avoids ──────────────────────────
 *
 * DENOMINATOR = `send`, uniformly. Mailjet emits no `delivered` event at all,
 * so a delivered-based rate is not comparable across providers (measured: 0 of
 * 3.988 Mailjet sends carried one, against 99,4% for Maileroo).
 *
 * UNIT = the message, not the event. Opens repeat — a rate over raw events
 * counts the same reader many times. Messages are deduplicated on `message_id`.
 *
 * The `events` subcollection also carries app-written lifecycle rows
 * (`confirm`, `subscribe_completed`, `welcome_email_sent`) that are not emails
 * at all; they are excluded, or every denominator inherits them.
 *
 * ── A rate difference between providers is NOT a provider difference ───────
 *
 * scripts/send-job-alerts.mjs sorts recipients by engagement tier before
 * sending, and the cascade consumes providers in fixed quota order (Mailgun
 * 100/day, Mailjet 200/day, then Maileroo). The small-quota providers therefore
 * receive the most engaged ~300 recipients of each day, by construction. The
 * report prints the warning next to the provider table rather than pretending
 * the comparison is clean. scripts/send-newsletter.mjs does NOT sort that way,
 * so newsletter_weekly is the one provider comparison that means something.
 *
 * Usage:
 *   node scripts/report-email-engagement.mjs [--days 7] [--out report.json]
 *                                            [--no-snapshot] [--fail-on-regression]
 */

import fs from 'node:fs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';

const args = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hasFlag = (flag) => args.includes(flag);

const DAYS = Number(argValue('--days', '7')) || 7;
const OUT_PATH = argValue('--out', null);
const WRITE_SNAPSHOT = !hasFlag('--no-snapshot');
const FAIL_ON_REGRESSION = hasFlag('--fail-on-regression');

const PAGE = 3000;
const SNAPSHOT_COLLECTION = 'engagement_snapshots';

/** Delivery-funnel events. Everything else in `events` is app lifecycle, not email. */
const FUNNEL = new Set(['send', 'delivered', 'open', 'click', 'bounce', 'complaint', 'unsubscribe', 'suppressed', 'failed']);
const LOCALES = new Set(['it', 'en', 'de', 'fr', 'cs', 'pl', 'es', 'pt']);
const TAG_NOISE = new Set(['lifecycle', 'transactional', 'marketing', 'newsletter', 'job']);

/**
 * Only these two Maileroo email types had a lookup record before the
 * 2026-08-20 fix. Kept as an explicit list because it is what `unmeasurable`
 * counts against: once every sender writes the ref, no type belongs here and
 * the counter stays at 0. It is NOT a config knob — do not add types to silence
 * the counter, that is the regression it exists to catch.
 */
const MAILEROO_HISTORICALLY_TRACKED = new Set(['job_alert', 'newsletter_weekly']);

export function campaignFromMetadata(md) {
  if (!md || typeof md !== 'object') return '';
  const tags = md.tags || md.data?.tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t && typeof t === 'object' && (t.name === 'campaign_id' || t.name === 'campaign')) return String(t.value || '');
    }
    for (const t of tags) {
      if (typeof t === 'string' && !TAG_NOISE.has(t) && !LOCALES.has(t)) return t;
    }
  } else if (tags && typeof tags === 'object') {
    if (tags.campaign_id) return String(tags.campaign_id);
  }
  const cv = md.custom_variables || md.data?.custom_variables;
  if (cv && typeof cv === 'object' && cv.campaign_id) return String(cv.campaign_id);
  if (md.custom_id) return String(md.custom_id);
  return '';
}

/** A campaign_id that is really a provider message id — the attribution defect. */
export function looksLikeMessageId(c) {
  const s = String(c || '');
  if (!s) return true;
  if (s.startsWith('unknown:')) return true;
  return s.includes('@') || /^[0-9a-f]{16,}$/i.test(s);
}

export function classifyEmailType(parent, campaignId) {
  if (parent === 'job_alert_subscribers') return 'job_alert';
  const c = String(campaignId || '');
  if (!c) return 'unknown';
  if (c.startsWith('weekly_')) return 'newsletter_weekly';
  if (c.startsWith('daily-brief-')) return 'daily_brief';
  if (c.startsWith('saved-jobs-digest-')) return 'saved_jobs_digest';
  if (c.startsWith('welcome')) return 'welcome';
  if (c.startsWith('onboarding_drip')) return 'onboarding_drip';
  if (c.startsWith('winback')) return 'winback';
  if (c.startsWith('sunset')) return 'sunset';
  if (c.startsWith('confirm')) return 'confirmation';
  if (c.startsWith('company_alert')) return 'company_alert';
  if (c === 'calculator_paywall' || c === 'lamal_ssn_tool') return 'transactional_tool';
  if (looksLikeMessageId(c)) return 'unattributed';
  return c.slice(0, 40);
}

const pct = (n, d) => (d > 0 ? (100 * n / d) : null);
const fmtPct = (v) => (v === null ? '   n/a' : (v.toFixed(2) + '%').padStart(7));
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

/** Scan the events collection group and fold it into one record per message. */
async function collectMessages(db, since) {
  const msgs = new Map();
  const counters = { scanned: 0, lifecycleSkipped: 0, providerMissing: 0, recoveredCampaign: 0 };
  let lastDoc = null;

  for (;;) {
    let q = db.collectionGroup('events').where('timestamp', '>=', since).orderBy('timestamp').limit(PAGE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const v = doc.data();
      counters.scanned++;
      if (!FUNNEL.has(v.event_type)) { counters.lifecycleSkipped++; continue; }

      const parent = doc.ref.parent.parent?.parent?.id || 'unknown_parent';
      let provider = v.provider;
      if (!provider) {
        counters.providerMissing++;
        provider = parent === 'job_alert_subscribers' ? 'resend' : 'unknown';
      }

      let campaign = v.campaign_id || '';
      if (parent !== 'job_alert_subscribers' && looksLikeMessageId(campaign)) {
        const recovered = campaignFromMetadata(v.metadata);
        if (recovered) { campaign = recovered; counters.recoveredCampaign++; }
      }

      const emailType = classifyEmailType(parent, campaign);
      const email = v.email || doc.ref.parent.parent?.id || '';
      const key = v.message_id ? 'm:' + v.message_id
        : 'f:' + parent + '::' + email + '::' + (campaign || v.alert_id || '?');

      let m = msgs.get(key);
      if (!m) { m = { provider, emailType, sent: 0, delivered: 0, open: 0, click: 0, bounce: 0 }; msgs.set(key, m); }
      if (m.provider === 'unknown' && provider !== 'unknown') m.provider = provider;
      if ((m.emailType === 'unknown' || m.emailType === 'unattributed')
        && emailType !== 'unknown' && emailType !== 'unattributed') m.emailType = emailType;

      if (v.event_type === 'send') m.sent++;
      else if (v.event_type === 'delivered') m.delivered++;
      else if (v.event_type === 'open') m.open++;
      else if (v.event_type === 'click') m.click++;
      else if (v.event_type === 'bounce') m.bounce++;
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }
  return { msgs, counters };
}

/** Fold per-message records into the cells the snapshot stores. */
export function aggregateMessages(messages) {
  const cell = () => ({ sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 });
  const byProvider = {}, byType = {}, byPair = {};
  const totals = cell();
  let unmeasurable = 0, unattributed = 0, orphanEngagement = 0;

  for (const m of messages) {
    if (!(m.sent > 0 || m.delivered > 0)) {
      if (m.open > 0 || m.click > 0) orphanEngagement++;
      continue;
    }
    if (m.emailType === 'unattributed') unattributed += 1;
    const measurable = !(m.provider === 'maileroo' && !MAILEROO_HISTORICALLY_TRACKED.has(m.emailType));
    if (!measurable) { unmeasurable += 1; }

    for (const bucket of [
      (byProvider[m.provider] ||= cell()),
      (byType[m.emailType] ||= cell()),
      (byPair[m.provider + '|' + m.emailType] ||= cell()),
      totals,
    ]) {
      if (m.sent > 0) bucket.sent++;
      if (m.delivered > 0) bucket.delivered++;
      if (m.open > 0) bucket.opened++;
      if (m.click > 0) bucket.clicked++;
      if (m.bounce > 0) bucket.bounced++;
    }
  }
  return { totals, byProvider, byType, byPair, unmeasurable, unattributed, orphanEngagement };
}

/**
 * Compare this week against the previous snapshot.
 *
 * Two families, deliberately different in shape:
 *
 *   - RATES degrade gradually and are noisy, so a cell is only judged when it
 *     carries at least MIN_SENDS messages, and only a relative drop beyond
 *     RATE_DROP_PCT counts. Absolute percentage points would fire constantly on
 *     the small lifecycle channels and never on the big ones.
 *   - INTEGRITY counters are supposed to be zero. They are judged against a
 *     flat allowance, because "a few hundred messages lost their attribution"
 *     is never noise — it is the defect coming back.
 */
export const REGRESSION_RULES = {
  MIN_SENDS: 300,
  RATE_DROP_PCT: 20,
  MAX_UNMEASURABLE: 100,
  MAX_UNATTRIBUTED: 100,
  MAX_PROVIDER_MISSING_PCT: 1,
};

export function detectRegressions(current, previous, rules = REGRESSION_RULES) {
  const out = [];
  const rateOf = (c, k) => pct(c[k], c.sent);

  if (current.integrity.unmeasurable > rules.MAX_UNMEASURABLE) {
    out.push({
      kind: 'integrity',
      metric: 'unmeasurable',
      detail: `${current.integrity.unmeasurable} messaggi con engagement scartato (soglia ${rules.MAX_UNMEASURABLE}). `
        + 'Un sender sta inviando via Maileroo senza scrivere maileroo_refs: vedi functions/src/lib/mailerooRef.js.',
    });
  }
  if (current.integrity.unattributed > rules.MAX_UNATTRIBUTED) {
    out.push({
      kind: 'integrity',
      metric: 'unattributed',
      detail: `${current.integrity.unattributed} messaggi archiviati sotto un message-id invece del campaign_id (soglia ${rules.MAX_UNATTRIBUTED}).`,
    });
  }
  const missingPct = pct(current.integrity.providerMissing, current.integrity.scanned);
  if (missingPct !== null && missingPct > rules.MAX_PROVIDER_MISSING_PCT) {
    out.push({
      kind: 'integrity',
      metric: 'provider_missing',
      detail: `${missingPct.toFixed(2)}% degli eventi non porta il campo provider (soglia ${rules.MAX_PROVIDER_MISSING_PCT}%).`,
    });
  }

  if (!previous) return out;

  for (const [scope, curGroup] of [['type', current.byType], ['provider', current.byProvider]]) {
    const prevGroup = (scope === 'type' ? previous.byType : previous.byProvider) || {};
    for (const [name, cur] of Object.entries(curGroup)) {
      const prev = prevGroup[name];
      if (!prev) continue;
      if (cur.sent < rules.MIN_SENDS || prev.sent < rules.MIN_SENDS) continue;
      for (const metric of ['opened', 'clicked']) {
        const curRate = rateOf(cur, metric), prevRate = rateOf(prev, metric);
        if (curRate === null || prevRate === null || prevRate === 0) continue;
        const dropPct = 100 * (prevRate - curRate) / prevRate;
        if (dropPct > rules.RATE_DROP_PCT) {
          out.push({
            kind: 'rate',
            metric: `${scope}:${name}:${metric === 'opened' ? 'open' : 'click'}`,
            detail: `${prevRate.toFixed(2)}% → ${curRate.toFixed(2)}% (${dropPct.toFixed(1)}% relativo, su ${cur.sent} invii)`,
          });
        }
      }
    }
  }
  return out;
}

function renderTable(title, group, note = '') {
  const lines = [`\n=== ${title} ===`];
  if (note) lines.push(note);
  lines.push(pad('', 24) + rpad('invii', 8) + rpad('aperture', 10) + rpad('click', 8) + rpad('OPEN%', 9) + rpad('CLICK%', 9));
  const rows = Object.entries(group).sort((a, b) => b[1].sent - a[1].sent);
  for (const [name, c] of rows) {
    lines.push(pad(name, 24) + rpad(c.sent, 8) + rpad(c.opened, 10) + rpad(c.clicked, 8)
      + rpad(fmtPct(pct(c.opened, c.sent)), 9) + rpad(fmtPct(pct(c.clicked, c.sent)), 9));
  }
  return lines.join('\n');
}

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const db = await getFirestoreDb();

  console.log(`📬 Email engagement — finestra ${DAYS} giorni (da ${since.toISOString()})`);

  const { msgs, counters } = await collectMessages(db, since);
  const agg = aggregateMessages([...msgs.values()]);

  const snapshot = {
    generated_at: new Date().toISOString(),
    window_days: DAYS,
    since: since.toISOString(),
    totals: agg.totals,
    byProvider: agg.byProvider,
    byType: agg.byType,
    byPair: agg.byPair,
    integrity: {
      scanned: counters.scanned,
      lifecycleSkipped: counters.lifecycleSkipped,
      providerMissing: counters.providerMissing,
      recoveredCampaign: counters.recoveredCampaign,
      unmeasurable: agg.unmeasurable,
      unattributed: agg.unattributed,
      orphanEngagement: agg.orphanEngagement,
    },
  };

  const metaRef = db.collection('newsletter_subscribers').doc('_meta_').collection(SNAPSHOT_COLLECTION);
  let previous = null;
  try {
    const prevSnap = await metaRef.orderBy('generated_at', 'desc').limit(1).get();
    if (!prevSnap.empty) previous = prevSnap.docs[0].data();
  } catch (e) {
    console.warn('⚠️  Nessuno snapshot precedente leggibile:', e?.message || e);
  }

  const regressions = detectRegressions(snapshot, previous);

  const t = agg.totals;
  console.log(`\nMessaggi distinti: ${msgs.size} · invii ${t.sent} · aperture ${t.opened} · click ${t.clicked}`);
  console.log(`Tasso complessivo: open ${fmtPct(pct(t.opened, t.sent)).trim()} · click ${fmtPct(pct(t.clicked, t.sent)).trim()}`);
  console.log(renderTable('PER EMAIL_TYPE', agg.byType));
  console.log(renderTable('PER PROVIDER', agg.byProvider,
    '(Il confronto fra provider sui job alert NON misura i provider: send-job-alerts.mjs\n'
    + ' ordina per tier di engagement e la cascata consuma le quote in ordine fisso, quindi\n'
    + ' i provider piccoli ricevono per costruzione i destinatari piu attivi. Solo\n'
    + ' newsletter_weekly, che non e ordinata, regge il confronto.)'));

  console.log('\n=== INTEGRITA DELLA MISURA (attesi ~0) ===');
  console.log(`  engagement scartato (unmeasurable): ${agg.unmeasurable}`);
  console.log(`  attribuzione persa (unattributed):  ${agg.unattributed}`);
  console.log(`  eventi senza provider:              ${counters.providerMissing} su ${counters.scanned}`);
  console.log(`  aperture senza invio in finestra:   ${agg.orphanEngagement}  (normale: email spedite prima della finestra)`);

  if (regressions.length) {
    console.log('\n🔴 REGRESSIONI RILEVATE');
    for (const r of regressions) console.log(`  [${r.kind}] ${r.metric} — ${r.detail}`);
  } else {
    console.log('\n✅ Nessuna regressione rispetto allo snapshot precedente.');
  }

  if (WRITE_SNAPSHOT) {
    try {
      await metaRef.doc(snapshot.generated_at.slice(0, 10)).set(snapshot, { merge: true });
      console.log(`\n💾 Snapshot salvato: _meta_/${SNAPSHOT_COLLECTION}/${snapshot.generated_at.slice(0, 10)}`);
    } catch (e) {
      console.warn('⚠️  Salvataggio snapshot fallito:', e?.message || e);
    }
  }

  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, JSON.stringify({ snapshot, previous_at: previous?.generated_at || null, regressions }, null, 2));
    console.log(`📄 JSON scritto in ${OUT_PATH}`);
  }

  if (FAIL_ON_REGRESSION && regressions.length) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('report-email-engagement.mjs');
if (invokedDirectly) {
  main().catch((e) => {
    console.error('❌ report-email-engagement failed:', e?.stack || e);
    process.exit(1);
  });
}
