#!/usr/bin/env node
/**
 * job-gate-experiment-readout.mjs — lettura dei risultati del test A/B del
 * job gate (`jobgate-v3`) e baseline pre-test. SOLA LETTURA su GA4 Data API,
 * Firestore e Remote Config: nessuna scrittura, nessun publish.
 *
 * Uso:
 *   node scripts/analytics/job-gate-experiment-readout.mjs --since 2026-09-25 \
 *     [--until 2026-10-09] [--experiment jobgate-v3] [--control control] \
 *     [--weights '{"control":50,"challenger":50}'] [--json out.json] [--md out.md]
 *   node scripts/analytics/job-gate-experiment-readout.mjs --baseline --days 14 [--json out.json]
 *
 * Fonti:
 *  - GA4: `experiment_assigned` (persone per braccio → SRM), `job_auth_funnel`
 *    per `customEvent:step` × `customEvent:variant`, `newsletter` subscribe
 *    (segnale secondario). "Persone" = totalUsers.
 *  - Firestore `newsletter_subscribers`: nuovi iscritti con
 *    `variant = <experiment>:<braccio>` (esperimento) oppure `source_cta` del
 *    job gate (baseline). Si leggono solo i campi di stato/tempo (`select`),
 *    mai l'email.
 *  - Pesi: `--weights`, altrimenti env/RC `JOBGATE_EXPERIMENT_ARMS`.
 *
 * I bracci NON sono hard-coded: si scoprono dai dati (GA4 + Firestore + pesi).
 * Tutta la statistica è in scripts/lib/experiment-stats.mjs (pura, testata).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  GA4_READONLY_SCOPE,
  getServiceAccountToken,
  runGa4Report,
} from '../lib/ga4-service-account.mjs';
import { ANALYTICS_PROCESSING_LAG_DAYS, settledWindow } from '../lib/analytics-settled-window.mjs';
import { GA4_REPORT_TIMEZONE } from '../lib/ga4-report-timezone.mjs';
import {
  aggregateSubscribers,
  armFromVariantTag,
  buildBaseline,
  buildExperimentReadout,
  classifySubscriber,
  funnelUsersByArm,
  parseArmWeights,
  parseGa4Rows,
  renderBaselineMarkdown,
  renderExperimentMarkdown,
  sumGa4Metric,
} from '../lib/experiment-stats.mjs';

const JOB_GATE_CTAS = ['job_board_email_unlock', 'job_board_social_unlock', 'job_expired_email_unlock'];
const SUBSCRIBER_FIELDS = [
  'variant', 'status', 'isActive', 'active',
  'confirmed_at', 'confirmedAt',
  'created_at', 'createdAt', 'subscribed_at', 'subscribedAt',
  'consent_given_at', 'consent_ip_recorded_at',
  'source_cta', 'source_channel',
];
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Argomenti ────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    since: { type: 'string' },
    until: { type: 'string' },
    days: { type: 'string' },
    experiment: { type: 'string', default: 'jobgate-v3' },
    control: { type: 'string', default: 'control' },
    weights: { type: 'string' },
    json: { type: 'string' },
    md: { type: 'string' },
    baseline: { type: 'boolean', default: false },
    mde: { type: 'string', default: '0.2' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 14).join('\n'));
  process.exit(0);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(2);
}

function resolveWindow() {
  if (args.days) {
    const days = Number(args.days);
    if (!Number.isInteger(days) || days < 1) fail('--days deve essere un intero >= 1');
    const { start, end } = settledWindow({ days, lagDays: ANALYTICS_PROCESSING_LAG_DAYS });
    return { since: start, until: end };
  }
  if (!args.since || !DATE_RE.test(args.since)) fail('serve --since YYYY-MM-DD (oppure --days N)');
  const until = args.until || settledWindow({ days: 1, lagDays: ANALYTICS_PROCESSING_LAG_DAYS }).end;
  if (!DATE_RE.test(until)) fail('--until deve essere YYYY-MM-DD');
  if (until < args.since) fail(`--until ${until} precede --since ${args.since}`);
  return { since: args.since, until };
}

/** Mezzanotte Europe/Zurich del giorno `YYYY-MM-DD` in epoch ms. */
function zurichMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (ms) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: GA4_REPORT_TIMEZONE, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return wall - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return ms;
}

function parseWeights(raw) {
  try {
    return parseArmWeights(raw);
  } catch (e) {
    return fail(e.message);
  }
}

async function loadWeights(notes) {
  if (args.weights) return { weights: parseWeights(args.weights), source: '--weights' };
  if (process.env.JOBGATE_EXPERIMENT_ARMS) {
    return { weights: parseWeights(process.env.JOBGATE_EXPERIMENT_ARMS), source: 'env JOBGATE_EXPERIMENT_ARMS' };
  }
  try {
    const { getRemoteConfig, fetchRcTemplate } = await import('../lib/remote-config-admin.mjs');
    const template = await fetchRcTemplate(await getRemoteConfig()); // sola lettura: nessun publish
    const raw = template.parameters?.JOBGATE_EXPERIMENT_ARMS?.defaultValue?.value;
    if (raw) return { weights: parseWeights(raw), source: 'Remote Config JOBGATE_EXPERIMENT_ARMS' };
    notes.push('Remote Config non contiene `JOBGATE_EXPERIMENT_ARMS`: SRM calcolato su allocazione uniforme.');
  } catch (e) {
    notes.push(`Lettura Remote Config fallita (${String(e?.message || e).slice(0, 120)}): SRM su allocazione uniforme.`);
  }
  return { weights: null, source: 'uniforme (assunta)' };
}

// ── GA4 ──────────────────────────────────────────────────────

function exact(fieldName, value) {
  return { filter: { fieldName, stringFilter: { value, matchType: 'EXACT' } } };
}

function andFilter(...exprs) {
  return exprs.length === 1 ? exprs[0] : { andGroup: { expressions: exprs } };
}

async function ga4(token, body) {
  return runGa4Report({ token, body: { limit: 10000, ...body } });
}

// ── Firestore ────────────────────────────────────────────────

async function loadSubscriberDocs(query) {
  const snap = await query.select(...SUBSCRIBER_FIELDS).get();
  return snap.docs.map((d) => classifySubscriber(d.data()));
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { since, until } = resolveWindow();
  const startMs = zurichMidnightMs(since);
  // Fine esclusiva = mezzanotte Zurich del giorno DOPO `until` (corretta anche
  // nei giorni di cambio ora, dove un giorno non dura 24h).
  const endExclusiveMs = zurichMidnightMs(new Date(Date.parse(`${until}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10));
  const windowDays = Math.round((endExclusiveMs - startMs) / DAY_MS);
  const nowMs = Date.now();
  const notes = [];
  const experimentId = args.experiment;
  const control = args.control;

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    fail('credenziali mancanti: esporta GOOGLE_APPLICATION_CREDENTIALS (service account) oppure `source bin/rc-env.sh`');
  }
  const token = await getServiceAccountToken([GA4_READONLY_SCOPE], { logInfo: () => {} });
  if (!token) fail('token GA4 non ottenuto (service account)');

  const { getFirestoreDb } = await import('../lib/firestore-admin.mjs');
  const db = await getFirestoreDb('frontaliere-ticino');
  const dateRanges = [{ startDate: since, endDate: until }];

  if (args.baseline) {
    const funnel = await ga4(token, {
      dateRanges,
      dimensions: [{ name: 'customEvent:step' }],
      metrics: [{ name: 'totalUsers' }, { name: 'eventCount' }],
      dimensionFilter: exact('eventName', 'job_auth_funnel'),
    });
    const { byKey } = sumGa4Metric(parseGa4Rows(funnel), { keyDims: ['customEvent:step'] });
    const docs = await loadSubscriberDocs(
      db.collection('newsletter_subscribers').where('source_cta', 'in', JOB_GATE_CTAS),
    );
    const agg = aggregateSubscribers(docs, { keyOf: (s) => s.sourceCta, startMs, endMs: endExclusiveMs, nowMs });
    if (agg.missingCreated) notes.push(`${agg.missingCreated} iscritti job gate senza data di creazione né di consenso esclusi.`);
    if (agg.createdFromConsent) notes.push(`${agg.createdFromConsent} iscritti nella finestra senza \`created_at\`/\`subscribed_at\`: data presa dal timestamp del consenso.`);
    notes.push('`source_cta` è l\'attribuzione registrata sul documento: un iscritto già esistente che passa dal gate può conservare la CTA precedente.');
    notes.push(`GA4 persone = totalUsers per step (non deduplicate fra step); fuso ${GA4_REPORT_TIMEZONE}.`);
    const baseline = buildBaseline({
      gateView: byKey.gate_view || 0,
      authMethodClick: byKey.auth_method_click || 0,
      authSuccess: byKey.auth_success || 0,
      authFail: byKey.auth_fail || 0,
      ctaSubs: agg.byKey,
      ctas: JOB_GATE_CTAS,
    });
    const md = renderBaselineMarkdown(baseline, { since, until, notes });
    emit(md, { mode: 'baseline', since, until, windowDays, baseline, notes });
    return;
  }

  // ── Esperimento ──
  const expFilter = exact('customEvent:experiment_id', experimentId);
  const [assignedRes, funnelRes] = await Promise.all([
    ga4(token, {
      dateRanges,
      dimensions: [{ name: 'customEvent:variant' }],
      metrics: [{ name: 'totalUsers' }],
      dimensionFilter: andFilter(exact('eventName', 'experiment_assigned'), expFilter),
    }),
    ga4(token, {
      dateRanges,
      dimensions: [{ name: 'customEvent:variant' }, { name: 'customEvent:step' }],
      metrics: [{ name: 'totalUsers' }],
      dimensionFilter: andFilter(exact('eventName', 'job_auth_funnel'), expFilter),
    }),
  ]);
  let gaSubscribe = {};
  try {
    const subRes = await ga4(token, {
      dateRanges,
      dimensions: [{ name: 'customEvent:variant' }],
      metrics: [{ name: 'totalUsers' }],
      dimensionFilter: andFilter(exact('eventName', 'newsletter'), exact('customEvent:action', 'subscribe'), expFilter),
    });
    gaSubscribe = sumGa4Metric(parseGa4Rows(subRes), { keyDims: ['customEvent:variant'] }).byKey;
  } catch (e) {
    notes.push(`Evento GA4 \`newsletter\` subscribe per braccio non leggibile (${String(e?.message || e).slice(0, 100)}).`);
  }

  const assigned = sumGa4Metric(parseGa4Rows(assignedRes), { keyDims: ['customEvent:variant'] });
  const funnel = funnelUsersByArm(funnelRes);
  if (assigned.unattributed) notes.push(`${assigned.unattributed} persone con \`experiment_assigned\` senza \`variant\` escluse.`);
  if (funnel.unattributed) notes.push(`${funnel.unattributed} persone-step \`job_auth_funnel\` senza \`variant\`/\`step\` escluse.`);

  const prefix = `${experimentId}:`;
  const docs = await loadSubscriberDocs(
    db.collection('newsletter_subscribers').where('variant', '>=', prefix).where('variant', '<', `${experimentId};`),
  );
  const subsAgg = aggregateSubscribers(docs, {
    keyOf: (s) => armFromVariantTag(s.variant, experimentId),
    startMs,
    endMs: endExclusiveMs,
    nowMs,
  });
  if (subsAgg.outsideWindow) notes.push(`${subsAgg.outsideWindow} iscritti \`${prefix}*\` creati fuori finestra esclusi.`);
  if (subsAgg.missingCreated) notes.push(`${subsAgg.missingCreated} iscritti \`${prefix}*\` senza data di creazione né di consenso esclusi.`);
  if (subsAgg.createdFromConsent) notes.push(`${subsAgg.createdFromConsent} iscritti \`${prefix}*\` senza \`created_at\`/\`subscribed_at\`: data presa dal timestamp del consenso.`);

  const { weights, source: weightsSource } = await loadWeights(notes);
  const arms = [...new Set([
    ...Object.keys(assigned.byKey),
    ...Object.keys(funnel.byArm),
    ...Object.keys(subsAgg.byKey),
    ...Object.keys(weights || {}),
  ])].sort((a, b) => (a === control ? -1 : b === control ? 1 : a.localeCompare(b)));

  const ga = {};
  for (const arm of arms) {
    ga[arm] = {
      assigned: assigned.byKey[arm] || 0,
      gateView: funnel.byArm[arm]?.gate_view || 0,
      authSuccess: funnel.byArm[arm]?.auth_success || 0,
      gaSubscribe: gaSubscribe[arm] || 0,
    };
  }
  notes.push(`Pesi SRM: ${weightsSource}${weights ? ` ${JSON.stringify(weights)}` : ''}.`);
  notes.push('CR primaria = nuovi iscritti Firestore / persone gate_view GA4: le due fonti non sono unite per utente (consent mode e adblock abbassano solo il denominatore GA4).');
  notes.push('Conferma entro 72h calcolata solo sugli iscritti "maturi" (creati da almeno 72h).');
  if (Object.keys(assigned.byKey).length && !Object.keys(funnel.byArm).length) {
    notes.push(`Ci sono persone con \`experiment_assigned\` ma nessun \`job_auth_funnel\` con \`experiment_id=${experimentId}\`: verificare che il client passi \`experiment_id\`/\`variant\` sugli step del gate (al 2026-09-24 tutti i \`job_auth_funnel\` in GA4 hanno \`experiment_id\` = (not set)).`);
  }
  if (!arms.length) notes.push(`Nessun dato per \`${experimentId}\` nella finestra: esperimento non ancora avviato o dimensioni GA4 non ancora popolate.`);

  const readout = buildExperimentReadout({
    arms,
    control,
    ga,
    subs: subsAgg.byKey,
    weights,
    relativeMde: Number(args.mde),
    windowDays,
  });
  const md = renderExperimentMarkdown(readout, { experimentId, since, until, notes });
  emit(md, { mode: 'experiment', experimentId, since, until, windowDays, weights, weightsSource, readout, notes });
}

function emit(markdown, payload) {
  process.stdout.write(`${markdown}\n`);
  const generatedAt = new Date().toISOString();
  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify({ generatedAt, ...payload }, null, 2)}\n`);
    console.error(`JSON scritto in ${args.json}`);
  }
  if (args.md) {
    fs.mkdirSync(path.dirname(path.resolve(args.md)), { recursive: true });
    fs.writeFileSync(args.md, `${markdown}\n`);
    console.error(`Markdown scritto in ${args.md}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`❌ ${e?.stack || e}`);
  process.exit(1);
});
