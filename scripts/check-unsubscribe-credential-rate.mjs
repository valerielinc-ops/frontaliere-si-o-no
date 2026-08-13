#!/usr/bin/env node
/**
 * check-unsubscribe-credential-rate.mjs — the deferred item 3 of #5757
 * (follow-up(#5747): the third item PR #5762/#5763 explicitly left out).
 *
 * THE PROBLEM IT CLOSES
 *
 * #5719 added a `credential` field (`'autologin_code' | 'email_token'`) to
 * every `unsubscribe` event written by the `unsubscribe_link` channel
 * (functions/src/newsletterSubscriptionManagement.js). `email_token` is the
 * expected path; `autologin_code` only fires when the primary scoped token
 * FAILED and an authentic `ac` code saved the click. #5724 is rolling out a
 * TTL/revocation window for `ac` itself (see
 * scripts/check-autologin-refusal-rate.mjs, its Cloud-Logging-reading twin).
 * The day that ships, every unsubscribe currently depending on the
 * `autologin_code` fallback is one policy change away from a real "Link non
 * valido" — the LPD-complaint shape `ac` exists to prevent in the first
 * place (verifyOptOutCredential's docstring). Without this monitor, nobody
 * knows that population's size until the complaint arrives.
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
 * WHY THIS DOES NOT USE A collectionGroup('events') QUERY
 *
 * The obvious read is `db.collectionGroup('events').where('event_type',
 * '==', 'unsubscribe').where('timestamp', '>=', since)` — and
 * `firestore.indexes.json` even declares the composite index that would
 * need (`event_type ASC, timestamp DESC`, COLLECTION_GROUP scope). Verified
 * read-only against production (2026-08-14): that index is NOT deployed —
 * the query fails `FAILED_PRECONDITION: query requires an index`, and so
 * does a BARE collectionGroup('events') query on `timestamp` alone, and so
 * does a query scoped to a single subscriber's OWN `events` subcollection
 * once it combines the `event_type` equality filter with an `orderBy`.
 * Deploying the missing index is a write to project infrastructure, which
 * this monitor — read-only by design, like its twin — does not make.
 *
 * The workaround costs nothing extra and needs no index: `unsubscribed_at`
 * range queries on the TOP-LEVEL `newsletter_subscribers` collection are
 * plain single-field queries (auto-indexed, verified working), and an
 * EQUALITY-ONLY (no orderBy) query against one subscriber's own `events`
 * subcollection also needs no explicit index (verified working). So this
 * reads candidates via the first, then reads each candidate's own
 * `unsubscribe` events via the second, filtering client-side for the
 * window and for `source_channel === 'unsubscribe_link'`. N+1, but N is
 * capped (SUBSCRIBER_DOC_CAP) and bounded by `unsubscribed_at` volume,
 * which this channel measures at ~150/week — a few seconds of reads, not a
 * scan.
 *
 * KNOWN BLIND SPOT: a subscriber whose CURRENT `unsubscribed_at` falls
 * outside the window (e.g. they unsubscribed via `unsubscribe_link` inside
 * the window, then took some OTHER action that moved `unsubscribed_at`
 * again, in or out of range) will not be picked up as a candidate. Accepted
 * for the same reason the twin accepts its dominant-policy heuristic: the
 * alternative is the missing collectionGroup index, which is out of this
 * monitor's authority to fix.
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
const SUBSCRIBER_DOC_CAP = 3000;
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
  const snap = await db.collection('newsletter_subscribers')
    .where('unsubscribed_at', '>=', sinceDate)
    .limit(SUBSCRIBER_DOC_CAP)
    .get();

  const records = [];
  for (const doc of snap.docs) {
    const evSnap = await doc.ref.collection('events').where('event_type', '==', 'unsubscribe').get();
    for (const evDoc of evSnap.docs) {
      const data = evDoc.data() || {};
      // Only the credential-verified path (functions/src/newsletterSubscriptionManagement.js,
      // action === 'unsubscribe') ever sets `credential`. Other writers of
      // `event_type: 'unsubscribe'`-ish events under different
      // `source_channel`s (bulk LPD requests, lost-unsubscribe recovery) are
      // not this monitor's population — see unsubscribeCredentialMetrics.mjs.
      if (data.source_channel !== CREDENTIAL_LINK_CHANNEL) continue;
      const occurredAt = data.occurred_at ? new Date(data.occurred_at) : null;
      // The parent doc's `unsubscribed_at >= sinceDate` filter is a superset
      // (a subscriber can carry OLDER unsubscribe_link events too, e.g. a
      // resubscribe/unsubscribe cycle) — re-check the window on the event
      // itself.
      if (!occurredAt || Number.isNaN(occurredAt.getTime()) || occurredAt < sinceDate) continue;
      records.push({ credential: data.credential ?? null, occurredAt });
    }
  }
  return { records, candidateDocs: snap.size };
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

function report(agg, verdict, hours, candidateDocs, hadFallbackBefore) {
  const lines = [];
  lines.push(`Finestra: ultime ${hours}h · canale \`${CREDENTIAL_LINK_CHANNEL}\` · ${candidateDocs} iscritti candidati (\`unsubscribed_at\` nella finestra)`);
  lines.push('');
  lines.push('| famiglia | conteggio | nel rapporto |');
  lines.push('|---|---:|---|');
  lines.push(`| email_token | ${agg.counts.email_token} | denominatore |`);
  lines.push(`| autologin_code (fallback) | ${agg.counts.autologin_code} | **numeratore** |`);
  lines.push(`| missing (pre-#5719 o canale diverso) | ${agg.counts.missing} | no |`);
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
  const { records, candidateDocs } = await readUnsubscribeLinkEvents(db, sinceDate);
  log(`📥 ${candidateDocs} iscritti candidati, ${records.length} eventi \`unsubscribe_link\` nella finestra.`);

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

  const body = report(agg, verdict, hours, candidateDocs, hadFallbackBefore);
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

  return { agg, verdict, alertWritten, alertPath, historyPath, candidateDocs };
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
