#!/usr/bin/env node
/**
 * check-autologin-refusal-rate.mjs — the rollback trigger for the `ac` expiry
 * rollout (#5724).
 *
 * THE PROBLEM IT CLOSES
 *
 * #5719/#5726 gave the autologin code a lifetime and a revocation watermark,
 * both switched by three Remote Config parameters that are EMPTY today. Empty
 * means the pre-#5719 behaviour exactly, so nothing has changed yet — and
 * nothing can be allowed to change until there is a number that says whether
 * the change is refusing 3 people or 3.000. Today `exchange_auth_code` answers a
 * refusal with a bare 403, indistinguishable in Cloud Logging from the ones
 * anti-phishing scanners produce all day, so the rollback has no trigger and the
 * person deciding at 03:00 decides on a complaint.
 *
 * This reads the structured lines the function now writes, folds them into
 * `lockout / (lockout + accepted)`, compares it to a baseline captured while the
 * three parameters were still empty, and opens an issue carrying the runbook
 * when it crosses a threshold.
 *
 * WHY NOT A GOOGLE CLOUD LOG-BASED METRIC
 *
 * That was the obvious route and it was rejected for a reason worth writing
 * down: a log-based metric plus an alerting policy lives in the Cloud console,
 * outside this repository. It cannot be code-reviewed, cannot be tested, and
 * nothing in CI notices when the log line it counts gets renamed — the exact
 * `SiteShellContract` shape of failure this workspace has already been bitten
 * by, where a contract with no import form passes every guard that follows
 * imports. Here the filter, the arithmetic and the thresholds are three files in
 * the repo, `tests/autologin-refusal-metrics.test.ts` pins the arithmetic, and a
 * rename that breaks the query fails the `no_signal` check the next morning.
 *
 * The read is a plain `logging.googleapis.com/v2/entries:list` call with the
 * project's service account, i.e. the same shape as every GA4/GSC reader in
 * `scripts/lib/`. READ ONLY — this script writes to Google nothing at all.
 *
 * Usage:
 *   node scripts/check-autologin-refusal-rate.mjs              # 24h window
 *   node scripts/check-autologin-refusal-rate.mjs --hours=168  # 7 days
 *   node scripts/check-autologin-refusal-rate.mjs --no-probe   # skip the synthetic probe
 *   node scripts/check-autologin-refusal-rate.mjs --json       # machine output only
 *
 * Exit 1 when an alerting finding is present (the workflow turns that into an
 * issue); exit 0 otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getServiceAccountToken, fetchRetry } from './lib/ga4-service-account.mjs';
import {
  parseExchangeLine,
  entryText,
  aggregate,
  evaluate,
  isPreFlightPolicy,
  policyKey,
  pct,
  LOCKOUT_RATE_WARN,
  LOCKOUT_RATE_URGENT,
  MIN_SAMPLE,
} from './lib/autologinRefusalMetrics.mjs';
import { runAutologinProbe } from './lib/autologinProbe.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, 'docs', 'autologin-refusal');
const HISTORY_PATH = path.join(OUT_DIR, 'history.json');
const ALERT_PATH = path.join(OUT_DIR, 'alert.json');

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'frontaliere-ticino';
const LOGGING_SCOPE = 'https://www.googleapis.com/auth/logging.read';
/** gen-2 functions land under Cloud Run; the service name is the function name
 *  lowercased. Overridable so a region/name change is a flag, not a patch. */
const SERVICE_NAME = process.env.AC_MONITOR_SERVICE || 'newslettermanagesubscription';
/** Rolling window kept in the state file. 60 days covers two full 30-day TTL
 *  cycles, which is the longest thing that can be observed here. */
const HISTORY_DAYS = 60;

const args = process.argv.slice(2);
const JSON_ONLY = args.includes('--json');
const RUN_PROBE = !args.includes('--no-probe');
const HOURS = (() => {
  const a = args.find((x) => x.startsWith('--hours='));
  const n = a ? Number.parseInt(a.slice('--hours='.length), 10) : 24;
  return Number.isFinite(n) && n > 0 ? n : 24;
})();

const log = (...a) => { if (!JSON_ONLY) console.log(...a); };

/* ── Cloud Logging read ─────────────────────────────────────── */

async function readEntries(token, sinceIso) {
  // Both payload shapes, because a gen-2 `console.log` is `textPayload` today
  // but becomes `jsonPayload.message` the moment anything in functions/ imports
  // firebase-functions/logger (see entryText). Filtering on only one would make
  // this monitor silently read zero after an unrelated refactor.
  const filter = [
    `resource.labels.service_name="${SERVICE_NAME}"`,
    `timestamp >= "${sinceIso}"`,
    '(textPayload:"[exchange_auth_code] " OR jsonPayload.message:"[exchange_auth_code] ")',
  ].join(' AND ');

  const entries = [];
  let pageToken;
  // Hard page cap: at ~400 exchanges/day a 7-day window is <3 pages of 1000, so
  // 30 is generous. Its job is to stop a filter mistake from paging a whole
  // project's log history inside a scheduled job.
  for (let page = 0; page < 30; page += 1) {
    const res = await fetchRetry('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resourceNames: [`projects/${PROJECT_ID}`],
        filter,
        orderBy: 'timestamp desc',
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      }),
    }, 2, 60_000);
    if (!res.ok) {
      throw new Error(`entries:list ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    for (const e of body.entries || []) entries.push(e);
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return entries;
}

/* ── State ──────────────────────────────────────────────────── */

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return { baseline: parsed.baseline ?? null, days: Array.isArray(parsed.days) ? parsed.days : [] };
  } catch {
    return { baseline: null, days: [] };
  }
}

/**
 * The baseline is only ever written from a window observed under the EMPTY
 * policy, and it stops moving the moment the policy changes.
 *
 * That asymmetry is the whole point: a baseline that kept updating after the
 * flip would drift toward whatever the new rate is, and "the rate changed after
 * the flip" — the question the owner has to answer — would become unanswerable
 * about a week later, right when the 30-day TTL starts to bite.
 */
function updateBaseline(previous, agg) {
  if (!agg.observedPolicy || !isPreFlightPolicy(agg.observedPolicy)) return previous;
  if (agg.graded < MIN_SAMPLE) return previous;
  const candidate = {
    capturedAt: new Date().toISOString(),
    windowHours: HOURS,
    policy: agg.observedPolicy,
    graded: agg.graded,
    accepted: agg.counts.accepted,
    lockout: agg.counts.lockout,
    lockoutRate: agg.lockoutRate,
    optout: agg.counts.optout,
    noise: agg.counts.noise,
  };
  if (!previous) return candidate;
  // Widen rather than replace: a baseline built from more traffic is a better
  // one, and taking the max of the observed rate keeps it conservative — the
  // post-flip comparison must not be made easier by a quiet day.
  return {
    ...candidate,
    graded: previous.graded + candidate.graded,
    accepted: previous.accepted + candidate.accepted,
    lockout: previous.lockout + candidate.lockout,
    lockoutRate: Math.max(previous.lockoutRate ?? 0, candidate.lockoutRate ?? 0),
    capturedAt: previous.capturedAt,
    lastUpdatedAt: candidate.capturedAt,
  };
}

/* ── Runbook, carried INSIDE the alert ──────────────────────── */

function runbook(agg, verdict) {
  return [
    '### Runbook — cosa fare adesso',
    '',
    '1. **Rollback** (30 secondi, nessun deploy): Firebase console → progetto `frontaliere-ticino` → Remote Config → **svuota** `NEWSLETTER_AC_SCHEME`, `NEWSLETTER_AC_TTL_DAYS`, `NEWSLETTER_AC_LEGACY_SUNSET` e pubblica. Vuoti = comportamento pre-#5719: la scadenza smette di mordere al primo refresh della cache del template (≤5 min), **anche per i codici già rifiutati** — la TTL è applicata in verifica, non incisa nel codice.',
    '2. **Conferma** che ha funzionato: `node scripts/check-autologin-refusal-rate.mjs --hours=1`. `lockout` deve tornare a 0. Se non torna a 0, non era la policy: guarda `auth_code_revoked` (watermark per-iscritto, che il rollback NON tocca).',
    `3. **Non serve rollback** se l'unica famiglia che sale è \`invalid_auth_code\` (scanner) o \`autologin_disabled\` (scelta dell'iscritto): nessuna delle due è causata dai tre parametri e nessuna è nel rapporto. Il numero che decide è **lockout / (lockout + accepted)** = ${pct(agg.lockoutRate)}.`,
    '',
    `Soglie: ≥ ${pct(LOCKOUT_RATE_WARN)} → rollback entro il turno · ≥ ${pct(LOCKOUT_RATE_URGENT)} → rollback ora · baseline pre-flip = 0 per costruzione (con i tre parametri vuoti né \`expired\` né \`revoked\` sono raggiungibili).`,
    '',
    `Finding: ${verdict.findings.map((f) => f.code).join(', ')}`,
  ].join('\n');
}

function report(agg, verdict, baseline, probe) {
  const lines = [];
  lines.push(`Finestra: ultime ${HOURS}h · progetto \`${PROJECT_ID}\` · servizio \`${SERVICE_NAME}\``);
  lines.push('');
  lines.push('| famiglia | conteggio | nel rapporto |');
  lines.push('|---|---:|---|');
  lines.push(`| accepted | ${agg.counts.accepted} | denominatore |`);
  lines.push(`| lockout (expired + revoked) | ${agg.counts.lockout} | **numeratore** |`);
  lines.push(`| optout (autologin_disabled) | ${agg.counts.optout} | no — scelta dell'iscritto |`);
  lines.push(`| clock (not_yet_valid) | ${agg.counts.clock} | no — orologio del minter |`);
  lines.push(`| noise (invalid_auth_code) | ${agg.counts.noise} | no — scanner |`);
  lines.push('');
  lines.push(`**lockout rate: ${pct(agg.lockoutRate)}** su ${agg.graded} scambi graduati.`);
  lines.push(`Baseline pre-flip: ${baseline ? `${pct(baseline.lockoutRate)} su ${baseline.graded} scambi (dal ${String(baseline.capturedAt).slice(0, 10)})` : 'non ancora catturata'}.`);
  // "nessuna riga" is not "post-flip": with no lines there is no policy to read,
  // and printing POST-FLIP there would send the reader to the rollback runbook
  // for what is actually a blind monitor.
  const policyLabel = !agg.observedPolicy
    ? '`n/d` (nessuna riga nella finestra — vedi `no_signal`)'
    : `\`${policyKey(agg.observedPolicy)}\`${isPreFlightPolicy(agg.observedPolicy) ? ' (pre-flip)' : ' (**POST-FLIP**)'}`;
  lines.push(`Policy osservata nei log: ${policyLabel}.`);
  if (agg.ageSamples > 0) {
    lines.push(`Età dei codici accettati: p50 ${agg.ageDaysP50}g · p95 ${agg.ageDaysP95}g su ${agg.ageSamples} campioni datati — è la popolazione che una TTL sotto p95 avrebbe rifiutato.`);
  } else {
    lines.push('Età dei codici accettati: nessun campione datato (tutti legacy — un codice legacy non porta la data di emissione).');
  }
  lines.push('');
  for (const f of verdict.findings) lines.push(`- ${f.alert ? '🔴' : 'ℹ️'} \`${f.code}\` (p${f.priority}) — ${f.message}`);
  if (probe?.length) {
    lines.push('');
    lines.push('Sonda sintetica:');
    for (const p of probe) lines.push(`- ${p.skipped ? '⏭️' : p.passed ? '✅' : '❌'} ${p.label}${p.error ? ` — ${p.error}` : ''}`);
  }
  return lines.join('\n');
}

/* ── Main ───────────────────────────────────────────────────── */

async function main() {
  log('═══════════════════════════════════════════════════════');
  log('  Autologin refusal rate — rollback trigger (#5724)');
  log('═══════════════════════════════════════════════════════\n');

  const token = await getServiceAccountToken([LOGGING_SCOPE], { logInfo: log, logError: console.error });
  if (!token) {
    // Not a pass. Exiting 0 here would make a missing credential look identical
    // to a healthy day — the shape `load-rc-env.mjs` already has and that
    // `bin/rc-env.sh` exists to compensate for. This one says so and fails.
    console.error('❌ Nessun token di service account (GOOGLE_APPLICATION_CREDENTIALS): impossibile leggere Cloud Logging.');
    process.exit(1);
  }

  const sinceIso = new Date(Date.now() - HOURS * 3600_000).toISOString();
  const entries = await readEntries(token, sinceIso);
  log(`📥 ${entries.length} righe lette da Cloud Logging (dal ${sinceIso}).`);

  const records = entries.map((e) => parseExchangeLine(entryText(e))).filter(Boolean);
  log(`🔎 ${records.length} righe riconosciute come \`[exchange_auth_code]\`.`);

  const agg = aggregate(records);
  const history = loadHistory();
  const verdict = evaluate(agg, { baseline: history.baseline });

  let probe = [];
  if (RUN_PROBE) {
    probe = await runAutologinProbe({ secret: process.env.NEWSLETTER_SECRET });
    for (const p of probe) {
      if (!p.passed) {
        verdict.findings.push({
          code: 'probe_failed',
          priority: 1,
          alert: true,
          // A probe failure means mint and verify disagree, so every autologin
          // link in the NEXT send is already dead. It outranks any rate.
          message: `Sonda sintetica fallita: ${p.label} — ${p.error || 'verdetto inatteso'}. Mint e verify non sono d'accordo: i link della prossima spedizione sono già morti.`,
        });
        verdict.alert = true;
        verdict.priority = 1;
      }
    }
  }

  const baseline = updateBaseline(history.baseline, agg);
  const today = new Date().toISOString().slice(0, 10);
  const days = [
    ...history.days.filter((d) => d.date !== today),
    {
      date: today,
      windowHours: HOURS,
      counts: agg.counts,
      byReason: agg.byReason,
      graded: agg.graded,
      lockoutRate: agg.lockoutRate,
      acceptedByScheme: agg.acceptedByScheme,
      ageDaysP50: agg.ageDaysP50,
      ageDaysP95: agg.ageDaysP95,
      observedPolicy: agg.observedPolicy,
      findings: verdict.findings.map((f) => f.code),
    },
  ].slice(-HISTORY_DAYS);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify({ baseline, days }, null, 2)}\n`, 'utf8');

  const body = report(agg, verdict, baseline, probe);
  log(`\n${body}\n`);

  if (verdict.alert) {
    fs.writeFileSync(ALERT_PATH, `${JSON.stringify({
      priority: verdict.priority,
      // Discriminant FIRST: `github-issue-creator.mjs` dedups on the first 60
      // characters of the title, so a suffix would be cut off and every code
      // would collapse onto one canonical issue.
      title: `[autologin-rate] ${verdict.findings.find((f) => f.alert).code}: rifiuti exchange_auth_code`,
      body: `${body}\n\n${runbook(agg, verdict)}`,
    }, null, 2)}\n`, 'utf8');
    log(`🔴 Alert scritto in ${path.relative(ROOT, ALERT_PATH)} (priority ${verdict.priority}).`);
  } else if (fs.existsSync(ALERT_PATH)) {
    fs.rmSync(ALERT_PATH);
  }

  if (JSON_ONLY) console.log(JSON.stringify({ agg, verdict, baseline, probe }, null, 2));

  process.exit(verdict.alert ? 1 : 0);
}

main().catch((err) => {
  console.error(`❌ check-autologin-refusal-rate fallito: ${err?.message || err}`);
  process.exit(1);
});
