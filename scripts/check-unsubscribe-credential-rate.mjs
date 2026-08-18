#!/usr/bin/env node
/**
 * check-unsubscribe-credential-rate.mjs — the deferred item 3 of #5757
 * (follow-up(#5747): the third item PR #5762/#5763 explicitly left out).
 *
 * THE PROBLEM IT CLOSES
 *
 * #5719 added a `credential` field (`'autologin_code' | 'email_token'`) to the
 * `unsubscribe` events written by the `unsubscribe_link` channel.
 * `email_token` is the expected path; `autologin_code` only fires when the
 * primary scoped token FAILED and an authentic `ac` code saved the click.
 * #5724 is rolling out a TTL/revocation window for `ac` itself (see
 * scripts/check-autologin-refusal-rate.mjs, its Cloud-Logging-reading twin).
 * The day that ships, every unsubscribe currently depending on the
 * `autologin_code` fallback is one policy change away from a real "Link non
 * valido" — the LPD-complaint shape `ac` exists to prevent in the first
 * place (verifyOptOutCredential's docstring). Without this monitor, nobody
 * knows that population's size until the complaint arrives.
 *
 * TWO WRITERS ON THIS CHANNEL, AND THE LINE ABOVE USED TO NAME ONE
 *
 * This header said the field was on EVERY `unsubscribe_link` event, and
 * pointed at functions/src/newsletterSubscriptionManagement.js as though it
 * were the only writer. It was not, and had not been since before #5719
 * merged: services/newsletterSubscribers.ts
 * (`unsubscribeNewsletterSubscriber`, the SPA "Disiscriviti" write App.tsx
 * drives) landed with #5690 at 14:05 on 2026-08-12, four hours and fifty
 * minutes BEFORE #5719 at 18:54, writing the same `event_type: 'unsubscribe'`
 * on the same `source_channel` with no `credential` key at all.
 *
 * Because `missing` is dropped from the rate as pre-deploy residue, those
 * events were not merely uncounted — they were uncountable. Measured
 * read-only against production over the 7 days to 2026-08-18, 209 events:
 * 110 `email_token`, 1 `autologin_code`, 98 `missing`. Splitting `missing` by
 * field signature separates them exactly: 46 with the Cloud Function's
 * `unsubscribe_ip`/`unsubscribe_method` shape, all of them on 08-11 and 08-12
 * and none after — genuine residue, draining out on its own; and 52 with the
 * SPA writer's `user_id`/`metadata`/`source_page` shape, on every single day
 * from 08-13 to 08-18 — a writer, not residue. The monitor was reporting
 * 1/111 = 0,90% while a third of the post-deploy window sat outside its
 * denominator, and App.tsx cannot reach that writer without an `ac`: the 52
 * were the very cohort this file exists to size.
 *
 * The write site is fixed (both writers stamp `credential`, pinned by
 * tests/newsletter-unsubscribe-integrity.test.ts) and the arithmetic now
 * refuses to shrink its own denominator in silence — see
 * `uncredentialed_share` in scripts/lib/unsubscribeCredentialMetrics.mjs.
 *
 * SAME FORM AS THE TWIN, DIFFERENT SOURCE
 *
 * Structure mirrors check-autologin-refusal-rate.mjs on purpose (#5757):
 * read → aggregate → evaluate → persist history → write alert.json → exit
 * 1 so the workflow opens an issue. The one thing that differs is the
 * source: that monitor reads Cloud Logging (a log-based metric was rejected
 * there for the `SiteShellContract` reason spelled out in its header — not
 * reviewable, not testable). Here the data was ALREADY a Firestore event,
 * not a log line, so Cloud Logging is not an option and never was; this
 * reads Firestore directly, the same shape as scripts/lib/newsletter-ab-data.mjs.
 *
 * WHY THIS READS collectionGroup('events') — AND WHY IT ONCE DID NOT
 *
 * This monitor used to read candidates from the TOP-LEVEL
 * `newsletter_subscribers` collection by `unsubscribed_at`, then walk each
 * candidate's own `events` subcollection (N+1). The header justifying that
 * said the composite index `events(event_type ASC, timestamp DESC)` declared
 * in firestore.indexes.json was "NOT deployed", verified 2026-08-14.
 *
 * That conclusion was wrong, and wrong in an instructive way. Re-measured
 * read-only against production on 2026-08-18:
 *
 *   FAIL  event_type== + timestamp>=            (no orderBy)  FAILED_PRECONDITION
 *   OK    same query + .orderBy('timestamp','desc')           459 docs
 *   OK    bare collectionGroup('events') on timestamp alone   docs returned
 *
 * The index IS deployed. What fails is the query with NO explicit order,
 * because Firestore then asks for the (event_type ASC, timestamp ASC)
 * variant, which nothing declares — the same defect that kept the newsletter
 * A/B report dead, fixed the same day in scripts/lib/newsletter-ab-data.mjs.
 * The second claim ("a BARE collectionGroup query on `timestamp` alone" also
 * fails) was wrong too: that is a single-field query served by the
 * `events.timestamp` fieldOverride already in firestore.indexes.json. Only
 * the third claim held — a query scoped to ONE subscriber's own `events`
 * subcollection is COLLECTION scope, which a COLLECTION_GROUP index does not
 * serve.
 *
 * WHAT THE WORKAROUND WAS COSTING
 *
 * Its own header called the gap a KNOWN BLIND SPOT: a subscriber whose
 * CURRENT `unsubscribed_at` has since moved out of the window is never picked
 * up as a candidate, so their in-window unsubscribe events are invisible. On
 * this site that is not a corner case — a login re-subscribes a disiscritto
 * and moves `unsubscribed_at`, which is the documented behaviour behind the
 * 186 resurrected subscribers of #5747.
 *
 * Measured, same window, both paths (production, 2026-08-18, 7 days):
 *
 *   per-subscriber (old)  158 records, 136 candidate docs + 136 subqueries
 *   collectionGroup (new) 206 records, one query
 *   missed by the old path: 48 of 206 (23%), and it saw nothing the new one missed
 *
 * The fallback rate moves 0.63% -> 0.49% (1/158 -> 1/206): the single
 * `autologin_code` event is found either way, so this widens the denominator
 * rather than raising the alarm. All 48 recovered records carry
 * `credential: null`, i.e. exactly the resurrected cohort the blind spot was
 * systematically hiding — the population this monitor exists to size.
 *
 * Usage:
 *   node scripts/check-unsubscribe-credential-rate.mjs               # 7-day window
 *   node scripts/check-unsubscribe-credential-rate.mjs --hours=24    # 24h window
 *   node scripts/check-unsubscribe-credential-rate.mjs --json
 *
 * Exit 1 when an alerting finding is present (the workflow turns that into
 * an issue); exit 0 otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregate,
  evaluate,
  pct,
  FALLBACK_RATE_WARN,
  FALLBACK_RATE_URGENT,
  MIN_SAMPLE,
  CREDENTIAL_LINK_CHANNEL,
} from './lib/unsubscribeCredentialMetrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.resolve(ROOT, 'docs', 'unsubscribe-credential-rate');
const HISTORY_DAYS = 60;
/** Hard cap on candidate subscriber docs read per run — stops a filter
 *  mistake (or an unexpectedly wide window) from turning a daily job into a
 *  scan of the whole `newsletter_subscribers` collection. ~150/week measured
 *  on this channel, so 3000 is generous even for a 30-day dispatch. */
/** How far an event's write `timestamp` may trail its `occurred_at`; see readUnsubscribeLinkEvents. */
const WRITE_LAG_MARGIN_MS = 60 * 60 * 1000;
const EVENT_DOC_CAP = 5000;
const DEFAULT_HOURS = 168; // 7 days — this channel's volume (~20-50 credentialed events/week today) needs the wider window a 24h read would starve.

const args = process.argv.slice(2);
const JSON_ONLY = args.includes('--json');
const HOURS = (() => {
  const a = args.find((x) => x.startsWith('--hours='));
  const n = a ? Number.parseInt(a.slice('--hours='.length), 10) : DEFAULT_HOURS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HOURS;
})();

const log = (...a) => { if (!JSON_ONLY) console.log(...a); };

/* ── Firebase Admin SDK (lazy init, same pattern as send-job-alerts.mjs /
   send-saved-jobs-digest.mjs) ────────────────────────────────────────── */

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

/* ── Firestore read (see header for why this shape, not collectionGroup) ── */

async function readUnsubscribeLinkEvents(db, sinceDate) {
  // `timestamp` is when the event was WRITTEN, `occurred_at` is when it
  // HAPPENED, and the two drift: measured read-only against production on
  // 2026-08-18, up to 919s apart on this channel (and far more on the backfill
  // channels, which this monitor filters out anyway). Widening the query
  // window by a margin and then filtering on `occurred_at` keeps the window
  // semantics byte-identical to the per-subscriber read this replaces.
  const from = new Date(sinceDate.getTime() - WRITE_LAG_MARGIN_MS);
  const snap = await db.collectionGroup('events')
    .where('event_type', '==', 'unsubscribe')
    .where('timestamp', '>=', from)
    // Load-bearing, not cosmetic — see the header. Without it Firestore asks
    // for an (event_type ASC, timestamp ASC) index that nothing declares.
    .orderBy('timestamp', 'desc')
    .limit(EVENT_DOC_CAP)
    .get();

  const records = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    // The credential-verified paths — BOTH of them:
    // functions/src/newsletterSubscriptionManagement.js (`action ===
    // 'unsubscribe'`) and services/newsletterSubscribers.ts
    // (`unsubscribeNewsletterSubscriber`). Writers of `event_type:
    // 'unsubscribe'`-ish events under different `source_channel`s (bulk LPD
    // requests, lost-unsubscribe recovery) are not this monitor's population
    // — see unsubscribeCredentialMetrics.mjs.
    if (data.source_channel !== CREDENTIAL_LINK_CHANNEL) continue;
    const occurredAt = data.occurred_at ? new Date(data.occurred_at) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime()) || occurredAt < sinceDate) continue;
    records.push({ credential: data.credential ?? null, occurredAt });
  }
  // The cap drops the OLDEST events (the query is ordered newest-first), so a
  // saturated read silently shortens the window rather than failing. Say so.
  if (snap.size >= EVENT_DOC_CAP) {
    log(`⚠️  Event cap reached (${EVENT_DOC_CAP}): the oldest part of the window was not read.`);
  }
  return { records, scannedEvents: snap.size };
}

/* ── State ──────────────────────────────────────────────────── */

function loadHistory(outDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(outDir, 'history.json'), 'utf8'));
    return { days: Array.isArray(parsed.days) ? parsed.days : [] };
  } catch {
    return { days: [] };
  }
}

/* ── Report ─────────────────────────────────────────────────── */

function report(agg, verdict, hours, scannedEvents, hadFallbackBefore) {
  const lines = [];
  lines.push(`Finestra: ultime ${hours}h · canale \`${CREDENTIAL_LINK_CHANNEL}\` · ${scannedEvents} eventi \`unsubscribe\` letti (tutti i canali) nella finestra allargata`);
  lines.push('');
  lines.push('| famiglia | conteggio | nel rapporto |');
  lines.push('|---|---:|---|');
  lines.push(`| email_token | ${agg.counts.email_token} | denominatore |`);
  lines.push(`| autologin_code (fallback) | ${agg.counts.autologin_code} | **numeratore** |`);
  lines.push(`| legacy_auth_token (link \`at\`/\`authToken\`) | ${agg.counts.legacy_auth_token} | denominatore |`);
  lines.push(`| missing (nessun campo \`credential\`) | ${agg.counts.missing} | no — vedi \`uncredentialed_share\` |`);
  lines.push('');
  lines.push(`**quota fallback: ${pct(agg.fallbackRate)}** su ${agg.graded} unsubscribe graduati (${agg.total} eventi \`unsubscribe_link\` totali nella finestra).`);
  lines.push(`Fallback \`autologin_code\` osservato prima d'ora: ${hadFallbackBefore ? 'sì' : 'no (baseline a zero)'}.`);
  lines.push('');
  for (const f of verdict.findings) lines.push(`- ${f.alert ? '🔴' : 'ℹ️'} \`${f.code}\` (p${f.priority}) — ${f.message}`);
  return lines.join('\n');
}

function runbook(agg, verdict) {
  return [
    '### Runbook — cosa fare adesso',
    '',
    `1. **Guarda i log** di \`newsletterManageSubscription\` (Cloud Functions) per gli unsubscribe recenti con \`credential: "autologin_code"\`: la stessa email che riceve la newsletter ha un link footer col \`token\` scoped rotto?`,
    '2. **Non è (ancora) un blocco**: `ac` non ha oggi TTL/revoca attive (i tre parametri Remote Config del rollout #5724 sono vuoti) — chi passa dal fallback esce comunque. Il numero qui dice quante persone smetterebbero di poterlo fare IL GIORNO in cui quel rollout si accende.',
    `3. Se la quota resta sopra soglia, verifica il template dell'email newsletter: il link \`/disiscrivi-newsletter/\` porta ancora un \`token\` scoped valido nel footer di OGNI invio (non solo quelli recenti)?`,
    '',
    `Soglie: ≥ ${pct(FALLBACK_RATE_WARN)} → da guardare · ≥ ${pct(FALLBACK_RATE_URGENT)} → il token primario sta fallendo su una fetta larga · baseline = 0 finché nessun \`autologin_code\` è mai stato osservato.`,
    '',
    `Finding: ${verdict.findings.map((f) => f.code).join(', ')}`,
  ].join('\n');
}

/* ── Core (exported for tests — synthetic db + tmp outDir, no production
   writes, matches the sibling monitor's pattern of keeping the
   network/fs shell separate from the pure arithmetic) ────────────── */

export async function runCheck({ db, hours = DEFAULT_HOURS, outDir = DEFAULT_OUT_DIR, now = new Date() } = {}) {
  const sinceDate = new Date(now.getTime() - hours * 3600_000);
  const { records, scannedEvents } = await readUnsubscribeLinkEvents(db, sinceDate);
  log(`📥 ${scannedEvents} eventi \`unsubscribe\` letti, ${records.length} del canale \`unsubscribe_link\` nella finestra.`);

  const agg = aggregate(records);
  const history = loadHistory(outDir);
  const hadFallbackBefore = history.days.some((d) => (d.counts?.autologin_code || 0) > 0);
  const verdict = evaluate(agg, { baselineIsZero: !hadFallbackBefore });

  const today = now.toISOString().slice(0, 10);
  const days = [
    ...history.days.filter((d) => d.date !== today),
    {
      date: today,
      windowHours: hours,
      counts: agg.counts,
      graded: agg.graded,
      fallbackRate: agg.fallbackRate,
      findings: verdict.findings.map((f) => f.code),
    },
  ].slice(-HISTORY_DAYS);

  fs.mkdirSync(outDir, { recursive: true });
  const historyPath = path.join(outDir, 'history.json');
  fs.writeFileSync(historyPath, `${JSON.stringify({ days }, null, 2)}\n`, 'utf8');

  const body = report(agg, verdict, hours, scannedEvents, hadFallbackBefore);
  log(`\n${body}\n`);

  const alertPath = path.join(outDir, 'alert.json');
  let alertWritten = false;
  if (verdict.alert) {
    // The WORST alerting finding names the issue, not the first one found —
    // same reasoning as the sibling monitor.
    const worst = verdict.findings
      .filter((f) => f.alert)
      .sort((a, b) => a.priority - b.priority)[0];
    fs.writeFileSync(alertPath, `${JSON.stringify({
      priority: verdict.priority,
      // Discriminant FIRST: github-issue-creator.mjs dedups on the first 60
      // characters of the title. "[unsub-credential] " (19 chars) plus the
      // longest finding code, `first_fallback_after_zero_baseline` (34
      // chars), is 53 chars — still inside the cut with the colon.
      title: `[unsub-credential] ${worst.code}: quota fallback ac su unsubscribe`,
      body: `${body}\n\n${runbook(agg, verdict)}`,
    }, null, 2)}\n`, 'utf8');
    alertWritten = true;
    log(`🔴 Alert scritto in ${path.relative(ROOT, alertPath)} (priority ${verdict.priority}).`);
  } else if (fs.existsSync(alertPath)) {
    fs.rmSync(alertPath);
  }

  return { agg, verdict, alertWritten, alertPath, historyPath, scannedEvents };
}

/* ── Main ───────────────────────────────────────────────────── */

async function main() {
  log('═══════════════════════════════════════════════════════');
  log('  Unsubscribe credential fallback rate — #5757 item 3');
  log('═══════════════════════════════════════════════════════\n');

  let db;
  try {
    db = await getFirestoreAdmin();
  } catch (err) {
    // Not a pass. Same reasoning as the sibling monitor's missing-token
    // check: a missing credential must not read as a healthy empty window.
    console.error(`❌ Impossibile inizializzare Firestore Admin: ${err?.message || err}`);
    process.exit(1);
  }

  const { verdict, alertWritten } = await runCheck({ db, hours: HOURS });

  if (JSON_ONLY) console.log(JSON.stringify({ verdict, alertWritten }, null, 2));

  process.exit(verdict.alert ? 1 : 0);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-unsubscribe-credential-rate.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`❌ check-unsubscribe-credential-rate fallito: ${err?.message || err}`);
    process.exit(1);
  });
}
