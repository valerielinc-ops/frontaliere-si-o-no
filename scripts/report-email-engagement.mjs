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
 * ── An instrument has to stay falsifiable, and this one twice did not ──────
 *
 * A counter that cannot rise is not a green light, it is a broken gauge, and
 * both halves of this report had one (#6317, fixed 2026-09-05):
 *
 *   - `unmeasurable` was gated on a hard-coded date. It only counted messages
 *     older than 2026-08-21T06:00Z while the window is the trailing 7 days, so
 *     from 2026-08-28 it read 0 for every possible input. It is now the defect's
 *     own signature instead — see `zeroEngagementCohorts`.
 *   - the RATE baseline was "the most recent snapshot", which is whatever ran
 *     last and is therefore falsifiable by anyone who runs the script. It was:
 *     the scheduled run of 2026-08-31T10:05 no longer exists, overwritten by a
 *     hand run 3 hours later under the same calendar-date document id. See
 *     `pickBaseline`.
 *
 * The rule both fixes follow: prefer a predicate the defect itself must
 * satisfy over a constant that happens to be true today.
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
import { campaignIdFromTags } from '../functions/src/lib/mailerooRef.js';

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
 * A cohort smaller than this is not evidence: a handful of sends with nobody
 * opening happens by chance on every one-off channel. The lowest real rate
 * this report has measured on a cohort of that size is 7,4% (maileroo|winback,
 * 7 opens on 95 sends), and at that rate 30 sends with zero opens lands around
 * one week in ten — so 30 is a floor for SUSPICION, not for the alarm. The
 * alarm stays MAX_UNMEASURABLE: several small broken cohorts sum past it, one
 * unlucky small cohort does not.
 */
export const ZERO_ENGAGEMENT_MIN_SENDS = 30;

/**
 * The signature of a sender whose engagement is being thrown away.
 *
 * A message the webhook cannot attribute can never show an open — there is
 * nothing to attribute the open TO. So the defect does not look like a low
 * rate, it looks like a whole provider×type cohort with real volume and
 * LITERALLY zero opens and zero clicks. That is exactly how the August 2026
 * defect read: `welcome` via Maileroo, 560 sends, 0,00% open, while the same
 * type read 46,43% via Mailgun in the same window.
 *
 * This REPLACES a hard-coded `WRITER_FIX_LANDED_AT = 2026-08-21T06:00:00Z`
 * cutoff, which only counted a message as unmeasurable if it was seen BEFORE
 * that instant. The cutoff was right for exactly one week and then died: the
 * report's window is the trailing 7 days, so from 2026-08-28 onward no message
 * in any window could be older than the cutoff and `unmeasurable` could not
 * return anything but 0. It read green because the predicate was dead, not
 * because the defect was gone — and a NEW sender shipping via Maileroo without
 * `maileroo_refs` would have been invisible to the one counter this report
 * exists to carry. Measured 2026-09-05 on the same input, a cohort of 30 sends
 * with zero engagement dated today: the cutoff returns 0, this rule returns 30.
 * Date the identical cohort 2026-08-20 and the cutoff returns 30 — it was
 * tracking the calendar, not the senders.
 *
 * The per-send-day history shows what the rule is meant to see: from 2026-08-15
 * to 2026-08-20 the Maileroo lifecycle cohorts read exactly 0,00% open on ~200
 * sends a day (onboarding_drip) and ~85 a day (welcome), then jumped to ~70% on
 * 2026-08-21 when #6195 landed. Six consecutive days of a 200-message cohort at
 * zero — this rule would have named it on day one. #6317.
 *
 * Provider-agnostic on purpose. The August defect was Maileroo-specific
 * because of its recipient-less webhooks, but "engagement recorded for nobody"
 * is not a Maileroo property, and checking every provider is less code than
 * checking one.
 */
export function zeroEngagementCohorts(byPair, minSends = ZERO_ENGAGEMENT_MIN_SENDS) {
  return Object.entries(byPair || {})
    .filter(([, c]) => c.sent >= minSends && c.opened === 0 && c.clicked === 0)
    .map(([name, c]) => ({ name, sent: c.sent }))
    .sort((a, b) => b.sent - a.sent);
}

/**
 * Recover the campaign from a raw provider event.
 *
 * The array/object half is NOT reimplemented here: it delegates to
 * `campaignIdFromTags`, the same rule the webhooks read tags with, so a fix to
 * the shape handling reaches this report too. What is added on top is
 * provider-specific and belongs to the READ side only: Mailgun echoes bare tag
 * VALUES (the name is lost to `o:tag`), Mailtrap carries `custom_variables`,
 * Mailjet a `custom_id`. Those are shapes this report meets in stored history,
 * not shapes anything of ours sends.
 */
export function campaignFromMetadata(md) {
  if (!md || typeof md !== 'object') return '';
  const tags = md.tags || md.data?.tags;
  const named = campaignIdFromTags(tags);
  if (named) return named;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (typeof t === 'string' && !TAG_NOISE.has(t) && !LOCALES.has(t)) return t;
    }
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
  let unattributed = 0, orphanEngagement = 0;

  for (const m of messages) {
    if (!(m.sent > 0 || m.delivered > 0)) {
      if (m.open > 0 || m.click > 0) orphanEngagement++;
      continue;
    }
    if (m.emailType === 'unattributed') unattributed += 1;

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
  // Cohort-level, so it has to run after every message is folded in.
  const unmeasurableCohorts = zeroEngagementCohorts(byPair);
  const unmeasurable = unmeasurableCohorts.reduce((n, c) => n + c.sent, 0);

  return { totals, byProvider, byType, byPair, unmeasurable, unmeasurableCohorts, unattributed, orphanEngagement };
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

/**
 * job_alert is sent by a tier-cascade (send-job-alerts.mjs sorts recipients
 * by engagement, then fixed daily quotas per provider decide who lands where)
 * so a provider's job_alert-inclusive rate reflects which tier populated its
 * quota this week, not provider health — the same confound the report's
 * "PER PROVIDER" note already calls out for cross-provider comparison, just
 * along the time axis instead. Fold byPair down to per-provider totals with
 * job_alert excluded so the provider-scope regression check compares only
 * the non-cascade-ordered types (byPair is already computed by
 * aggregateMessages and otherwise unused here).
 */
/**
 * Pick the snapshot this window may honestly be compared against.
 *
 * "The most recent snapshot" is not a baseline — it is whatever ran last, and
 * that is falsifiable by anyone who runs the script. It already happened: the
 * scheduled run of 2026-08-31T10:05 (19'596 invii, the numbers posted on
 * #6317) is not in Firestore. The document `engagement_snapshots/2026-08-31`
 * holds a hand run from 13:34 the same day (16'875 invii) instead, because the
 * id was the calendar date and the write merged into it. Every [rate] alert on
 * that issue was therefore measured against a baseline nobody could identify.
 *
 * Two predicates, both cheap:
 *
 *   - same `window_days`, because a 30-day window and a 7-day one do not
 *     measure the same population and their rates are not each other's
 *     baseline;
 *   - old enough that the two windows are essentially disjoint. Half a window
 *     is the tolerance: it rejects the same-day ad-hoc run (whose window is
 *     ~95% the current one, so any "drop" is noise on the remaining 5%) while
 *     surviving the hours of cron lag that move a weekly run around.
 *
 * Filtered in JS on the last few documents rather than in the query: an
 * equality on `window_days` next to `orderBy('generated_at')` is the second
 * field Firestore would want a composite index for, and there are never enough
 * snapshots for the difference to matter.
 */
export function pickBaseline(snapshots, windowDays, generatedAt, minAgeFraction = 0.5) {
  const cutoff = Date.parse(generatedAt) - windowDays * 24 * 60 * 60 * 1000 * minAgeFraction;
  return (snapshots || [])
    .filter((s) => s && s.window_days === windowDays && Date.parse(s.generated_at) <= cutoff)
    .sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at))[0] || null;
}

function providerRatesExcludingJobAlert(byPair) {
  const out = {};
  for (const [key, cell] of Object.entries(byPair || {})) {
    const sep = key.indexOf('|');
    const provider = key.slice(0, sep), emailType = key.slice(sep + 1);
    if (emailType === 'job_alert') continue;
    const bucket = (out[provider] ||= { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 });
    bucket.sent += cell.sent;
    bucket.delivered += cell.delivered;
    bucket.opened += cell.opened;
    bucket.clicked += cell.clicked;
    bucket.bounced += cell.bounced;
  }
  return out;
}

export function detectRegressions(current, previous, rules = REGRESSION_RULES) {
  const out = [];
  const rateOf = (c, k) => pct(c[k], c.sent);

  if (current.integrity.unmeasurable > rules.MAX_UNMEASURABLE) {
    out.push({
      kind: 'integrity',
      metric: 'unmeasurable',
      detail: `${current.integrity.unmeasurable} messaggi con engagement scartato (soglia ${rules.MAX_UNMEASURABLE}). `
        + `Cohorte a zero aperture E zero click: ${(current.integrity.unmeasurableCohorts || []).map((c) => `${c.name} (${c.sent})`).join(', ') || 'n/d'}. `
        + 'Un sender sta inviando senza scrivere i maileroo_refs che il webhook usa per attribuire: '
        + 'vedi functions/src/lib/mailerooRef.js.',
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

  const groups = [
    ['type', current.byType, previous.byType],
    ['provider', providerRatesExcludingJobAlert(current.byPair), providerRatesExcludingJobAlert(previous.byPair)],
    ['pair', current.byPair, previous.byPair],
  ];
  for (const [scope, curGroup, prevGroupRaw] of groups) {
    const prevGroup = prevGroupRaw || {};
    for (const [name, cur] of Object.entries(curGroup || {})) {
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
      unmeasurableCohorts: agg.unmeasurableCohorts,
      unattributed: agg.unattributed,
      orphanEngagement: agg.orphanEngagement,
    },
  };

  const metaRef = db.collection('newsletter_subscribers').doc('_meta_').collection(SNAPSHOT_COLLECTION);
  let previous = null;
  try {
    const prevSnap = await metaRef.orderBy('generated_at', 'desc').limit(10).get();
    const candidates = prevSnap.docs.map((d) => d.data());
    previous = pickBaseline(candidates, DAYS, snapshot.generated_at);
    if (!previous && candidates.length) {
      // Say why out loud. A silent `previous = null` reads exactly like "no
      // regressions" in the report and in the issue body the workflow opens.
      console.warn(`⚠️  ${candidates.length} snapshot letti, nessuno confrontabile con una finestra di ${DAYS} giorni `
        + `chiusa il ${snapshot.generated_at}: servono window_days === ${DAYS} e generated_at anteriore di almeno `
        + `${DAYS / 2} giorni. Nessun confronto sui tassi in questa run.`);
    }
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
  console.log(`  engagement scartato (unmeasurable): ${agg.unmeasurable}`
    + (agg.unmeasurableCohorts.length ? `  [${agg.unmeasurableCohorts.map((c) => `${c.name}=${c.sent}`).join(', ')}]` : ''));
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
      // One document per RUN, not per day, and no merge. With the calendar
      // date as id a second run the same day overwrote the week's snapshot —
      // and `{ merge: true }` made the survivor a union of two windows, since
      // a byPair/byType key present only in the older run lived on inside the
      // newer one's totals. Both were live defects, see `pickBaseline`.
      await metaRef.doc(snapshot.generated_at).set(snapshot);
      console.log(`\n💾 Snapshot salvato: _meta_/${SNAPSHOT_COLLECTION}/${snapshot.generated_at}`);
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
