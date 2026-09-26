#!/usr/bin/env node
/**
 * jobgate-v3-monitor.mjs — monitor giornaliero del test A/B `jobgate-v3`
 * (workflow .github/workflows/jobgate-experiment-monitor.yml).
 *
 * Ogni giro:
 *  1. legge da Remote Config (sola lettura) ENABLED / ARMS / FORCE;
 *  2. lancia il readout (scripts/analytics/job-gate-experiment-readout.mjs,
 *     robot esclusi) sull'ultima finestra assestata e, dalla durata minima in
 *     poi, anche sull'ultima finestra di settimane intere, che è quella su cui
 *     si decide;
 *  3. valuta piano, allarmi e decisione (scripts/lib/experiment-monitor.mjs,
 *     puro e testato);
 *  4. aggiorna UNA issue di stato a titolo stabile; apre (dedup) o chiude le
 *     issue di allarme quando un allarme compare o rientra;
 *  5. se TUTTE le condizioni sono vere e la promozione ha `--apply` e
 *     `--approve-promotion`, scrive `JOBGATE_EXPERIMENT_FORCE=<vincente>` con
 *     scripts/experiments/jobgate-v3-rc.mjs (etag, niente force) e apre la
 *     issue «promosso». Al giro dopo FORCE è impostato: fase `forced`, nessuna
 *     nuova pubblicazione (idempotente).
 *
 * Uso:
 *   node scripts/experiments/jobgate-v3-monitor.mjs                 # dry-run, niente issue
 *   node scripts/experiments/jobgate-v3-monitor.mjs --issues --apply --approve-promotion # approvazione manuale
 *   node scripts/experiments/jobgate-v3-monitor.mjs --rc-json rc.json \
 *     --status-json status.json [--decision-json decision.json]    # fixture, niente rete
 * Opzioni del piano (default in jobgate-v3-plan.mjs): --mde, --baseline-rate,
 * --daily-persons, --min-days-floor, --max-days, --checkpoint-days,
 * --min-attribution, --since YYYY-MM-DD (solo diagnostica: sposta l'inizio
 * dell'analisi). Altre: --until YYYY-MM-DD, --out <dir> (monitor.md/json).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  JOBGATE_RC_KEYS,
  normalizeJobGateArm,
  parseJobGateEnabled,
  validateJobGateWeights,
} from '../../services/jobGateExperimentCore.mjs';
import { ANALYTICS_PROCESSING_LAG_DAYS, settledWindow } from '../lib/analytics-settled-window.mjs';
import {
  addDaysIso,
  checkpointDays,
  collectAlarms,
  decideAction,
  diffMonitorState,
  estimateDecisionWindowEnd,
  evaluateWindow,
  inclusiveDays,
  planExperiment,
  readMonitorState,
  renderMonitorReport,
} from '../lib/experiment-monitor.mjs';
import { JOBGATE_V3_PLAN } from './jobgate-v3-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READOUT = path.join(HERE, '..', 'analytics', 'job-gate-experiment-readout.mjs');
const RC_SCRIPT = path.join(HERE, 'jobgate-v3-rc.mjs');

const ID = JOBGATE_V3_PLAN.experimentId;
export const MONITOR_LABEL = 'experiment-monitor';
/** Titoli stabili: i primi 60 caratteri sono la chiave di dedup di github-issue-creator. */
export const ISSUE_TITLES = Object.freeze({
  status: `[${ID}] Monitor esperimento: stato giornaliero`,
  srm: `[${ID}] Allarme SRM: allocazione dei bracci diversa dai pesi`,
  guardrail: `[${ID}] Allarme guardrail: braccio peggiore del control`,
  attribution: `[${ID}] Attribuzione incompleta: iscritti dal gate senza braccio`,
  askOwner: `[${ID}] Decisione richiesta: durata massima senza vincente`,
  promoted: `[${ID}] Promosso il braccio vincente: rendere definitivo nel codice`,
});
// `keep-open` + `agent:no-age-out` = FIXER_EXEMPT_LABELS (scripts/lib/classify-issue.mjs):
// la issue di stato è un tracker, e allarmi/decisione chiedono una scelta sul
// test, non una modifica di codice. `attribution` e `promoted` sono lavoro di
// codice e restano instradabili.
const STATUS_LABELS = [MONITOR_LABEL, 'keep-open', 'agent:no-age-out'];
const OWNER_LABELS = [MONITOR_LABEL, 'keep-open'];
const CODE_LABELS = [MONITOR_LABEL];

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: 'boolean', default: false },
      'approve-promotion': { type: 'boolean', default: false },
      issues: { type: 'boolean', default: false },
      'rc-json': { type: 'string' },
      'status-json': { type: 'string' },
      'decision-json': { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      out: { type: 'string' },
      mde: { type: 'string' },
      'baseline-rate': { type: 'string' },
      'daily-persons': { type: 'string' },
      'min-days-floor': { type: 'string' },
      'max-days': { type: 'string' },
      'checkpoint-days': { type: 'string' },
      'min-attribution': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return values;
}

export function mayPublishPromotion({
  apply = false,
  approvePromotion = false,
  eventName,
} = {}) {
  return apply === true
    && approvePromotion === true
    && (!eventName || eventName === 'workflow_dispatch');
}

/** Piano con le sostituzioni da CLI (numeri validati). */
export function resolvePlan(args, base = JOBGATE_V3_PLAN) {
  const num = (flag, key, { integer = false, min = 0, max = Infinity } = {}) => {
    if (args[flag] == null) return base[key];
    const v = Number(args[flag]);
    if (!Number.isFinite(v) || v <= min || v > max || (integer && !Number.isInteger(v))) {
      throw new Error(`--${flag} non valido: ${args[flag]}`);
    }
    return v;
  };
  if (args.since != null && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error(`--since non valido: ${args.since}`);
  return {
    ...base,
    analysisStart: args.since ?? base.analysisStart,
    relativeMde: num('mde', 'relativeMde', { max: 5 }),
    baselineRate: num('baseline-rate', 'baselineRate', { max: 0.99 }),
    dailyGatePersons: num('daily-persons', 'dailyGatePersons'),
    minDaysFloor: num('min-days-floor', 'minDaysFloor', { integer: true }),
    maxDays: num('max-days', 'maxDays', { integer: true }),
    checkpointDays: num('checkpoint-days', 'checkpointDays', { integer: true }),
    // (0, 1]: con 0 o un negativo anche una copertura nulla passerebbe il
    // controllo (e) e un run con --apply promuoverebbe senza attribuzione.
    minAttributionCoverage: num('min-attribution', 'minAttributionCoverage', { min: 0, max: 1 }),
  };
}

/** Stato RC dai tre valori grezzi (stessa lettura del browser). */
export function rcStateFromValues(values) {
  const armsRaw = String(values?.[JOBGATE_RC_KEYS.arms] ?? '');
  const weights = validateJobGateWeights(armsRaw);
  return {
    enabled: parseJobGateEnabled(values?.[JOBGATE_RC_KEYS.enabled]),
    force: normalizeJobGateArm(values?.[JOBGATE_RC_KEYS.force]) || '',
    armsRaw,
    armsValid: weights.valid,
    weights: weights.weights,
  };
}

async function readRcValues() {
  const { getRemoteConfig, fetchRcTemplate } = await import('../lib/remote-config-admin.mjs');
  const template = await fetchRcTemplate(await getRemoteConfig()); // sola lettura
  const out = {};
  for (const key of Object.values(JOBGATE_RC_KEYS)) {
    out[key] = template.parameters?.[key]?.defaultValue?.value ?? '';
  }
  return out;
}

function runReadout({ plan, weights, until, tmpDir, name }) {
  const outFile = path.join(tmpDir, `${name}.json`);
  const args = [
    READOUT,
    '--experiment', plan.experimentId,
    '--control', plan.control,
    '--since', plan.analysisStart,
    '--until', until,
    '--weights', JSON.stringify(weights),
    '--mde', String(plan.relativeMde),
    '--json', outFile,
  ];
  // Il markdown del readout va nel log (stderr), lo stdout resta del monitor.
  execFileSync(process.execPath, args, { stdio: ['ignore', 2, 'inherit'] });
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

/** Argomento pronto da incollare in una shell POSIX. */
function shellQuote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

// ── GitHub (solo con --issues) ───────────────────────────────

function repoFlag() {
  return process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
}

function gh(args) {
  return execFileSync('gh', [...args, ...repoFlag()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function findStatusIssue() {
  const list = JSON.parse(gh(['issue', 'list', '--state', 'open', '--label', MONITOR_LABEL, '--limit', '100', '--json', 'number,title,body']) || '[]');
  return list.find((i) => i.title === ISSUE_TITLES.status) || null;
}

async function syncIssues({ report, state, prevIssue, alarms, decision, applied, runUrl, workflow }) {
  const { commentOnGithubIssue, createGithubIssue, resolveGithubIssue } = await import('../lib/github-issue-creator.mjs');
  const bodyFile = path.join(os.tmpdir(), `jobgate-monitor-status-${process.pid}.md`);
  fs.writeFileSync(bodyFile, report);
  let statusNumber;
  if (prevIssue) {
    gh(['issue', 'edit', String(prevIssue.number), '--body-file', bodyFile]);
    statusNumber = prevIssue.number;
  } else {
    const url = gh(['issue', 'create', '--title', ISSUE_TITLES.status, '--body-file', bodyFile, ...STATUS_LABELS.flatMap((l) => ['--label', l])]);
    statusNumber = Number(/\/issues\/(\d+)/.exec(url)?.[1]) || null;
  }
  const prev = readMonitorState(prevIssue?.body);
  const diff = diffMonitorState(prev, state);
  const statusRef = statusNumber ? `#${statusNumber}` : 'la issue di stato';
  const notes = [];
  if (prev && diff.phaseChanged) notes.push(`Fase: \`${prev.phase}\` → \`${state.phase}\`.`);
  for (const id of diff.newAlarms) {
    const alarm = alarms.find((a) => a.id === id);
    notes.push(`🚨 Nuovo allarme \`${id}\`: ${alarm?.detail ?? ''}`);
    await createGithubIssue({
      title: ISSUE_TITLES[id],
      description: `${alarm?.detail ?? ''}\n\nNessun cambio automatico: il monitor non tocca Remote Config per un allarme. Stato completo e numeri: ${statusRef}.${runUrl ? `\n\nRun: ${runUrl}` : ''}`,
      priority: 2,
      labels: id === 'attribution' ? CODE_LABELS : OWNER_LABELS,
      workflow,
    });
  }
  for (const id of diff.clearedAlarms) {
    notes.push(`✅ Allarme \`${id}\` rientrato.`);
    try {
      resolveGithubIssue(ISSUE_TITLES[id], { workflow, runUrl });
    } catch (e) {
      console.error(`chiusura della issue ${id} non riuscita: ${e.message}`);
    }
  }
  if (diff.firstAskOwner) {
    notes.push('Durata massima raggiunta senza vincente promuovibile: decisione richiesta.');
    await createGithubIssue({
      title: ISSUE_TITLES.askOwner,
      description: `La finestra di decisione ha raggiunto la durata massima senza che tutte le condizioni di promozione fossero vere. Nessun cambio automatico.\n\n${decision.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.id}: ${c.detail}`).join('\n')}\n\nOpzioni: chiudere il test lasciando \`control\` (\`node scripts/experiments/jobgate-v3-rc.mjs --kill --apply\`), forzare un braccio a mano (\`--force-arm <braccio> --apply\`) o prolungare con \`--max-days\` nel workflow. Stato: ${statusRef}.`,
      priority: 2,
      labels: OWNER_LABELS,
      workflow,
    });
  }
  if (decision.action === 'promote' && applied === true) {
    notes.push(`🏁 Promosso \`${decision.winner}\` (Remote Config FORCE pubblicato).`);
    await createGithubIssue({
      title: ISSUE_TITLES.promoted,
      description: [
        `Il monitor ha promosso \`${decision.winner}\`: \`JOBGATE_EXPERIMENT_FORCE=${decision.winner}\` è pubblicato su Remote Config, quindi ogni visitatore vede già quel gate.`,
        '',
        ...decision.checks.map((c) => `- ✅ ${c.id}: ${c.detail}`),
        '',
        'Passi per renderlo definitivo nel codice:',
        `1. In \`components/community/JobBoard.tsx\` rendere il comportamento di \`${decision.winner}\` quello di default e togliere i rami degli altri bracci.`,
        '2. Rimuovere `hooks/useJobGateExperiment.ts`, `services/jobGateExperiment.ts` e il tag `variant` nella scrittura dell\'iscritto (lasciare `services/jobGateExperimentCore.mjs` finché lo usano script e readout).',
        '3. Togliere `JOBGATE_EXPERIMENT_*` da `functions/src/publicConfigKeys.js` e da `REMOTE_CONFIG_DEFAULTS` (`services/firebase.ts`), poi spegnere le chiavi con `node scripts/experiments/jobgate-v3-rc.mjs --kill --apply` DOPO il deploy.',
        '4. Disattivare il workflow `jobgate-experiment-monitor.yml` e aggiungere la voce in `WhatsNewModal.tsx`.',
        '',
        `Numeri completi: ${statusRef}.${runUrl ? `\n\nRun: ${runUrl}` : ''}`,
      ].join('\n'),
      priority: 3,
      labels: CODE_LABELS,
      workflow,
    });
  }
  if (notes.length && statusNumber) commentOnGithubIssue(statusNumber, notes.join('\n'));
  return statusNumber;
}

// ── Main ─────────────────────────────────────────────────────

export async function runMonitor(argv, {
  now = new Date(),
  eventName = process.env.GITHUB_EVENT_NAME,
  publishRc = (args) => execFileSync(process.execPath, args, { stdio: ['ignore', 2, 'inherit'] }),
} = {}) {
  const args = parseCli(argv);
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 34).join('\n'));
    return { exitCode: 0 };
  }
  const plan = resolvePlan(args);
  const rcValues = args['rc-json'] ? JSON.parse(fs.readFileSync(args['rc-json'], 'utf8')) : await readRcValues();
  const rc = rcStateFromValues(rcValues);
  const planned = planExperiment(plan, rc.weights);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobgate-monitor-'));
  try {
    return await monitorOnce({ args, plan, rc, planned, tmpDir, now, eventName, publishRc });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function monitorOnce({ args, plan, rc, planned, tmpDir, now, eventName, publishRc }) {

  const settledEnd = args.until || settledWindow({ days: 1, now, lagDays: ANALYTICS_PROCESSING_LAG_DAYS }).end;
  const available = inclusiveDays(plan.analysisStart, settledEnd);
  // Una promozione non può poggiare sulla property GA4 di ripiego: con
  // --apply e un readout vero serve GA4_PROPERTY_ID esplicito (in CI lo
  // esporta load-rc-env.mjs da SERVER_GA4_PROPERTY_ID).
  if (args.apply && !args['status-json'] && available > 0 && !process.env.GA4_PROPERTY_ID) {
    throw new Error('GA4_PROPERTY_ID mancante: con --apply il monitor non legge GA4 dalla property di ripiego (esegui load-rc-env.mjs o source bin/rc-env.sh)');
  }
  let statusPayload = null;
  if (args['status-json']) statusPayload = JSON.parse(fs.readFileSync(args['status-json'], 'utf8'));
  else if (available > 0) statusPayload = runReadout({ plan, weights: rc.weights, until: settledEnd, tmpDir, name: 'status' });

  const statusEval = statusPayload ? evaluateWindow(statusPayload, plan, planned) : null;
  let decisionEval = null;
  const cpDays = checkpointDays(statusEval?.days ?? 0, plan.checkpointDays);
  if (statusEval && cpDays >= planned.minDays) {
    if (args['decision-json']) {
      decisionEval = evaluateWindow(JSON.parse(fs.readFileSync(args['decision-json'], 'utf8')), plan, planned);
    } else if (cpDays === statusEval.days) {
      decisionEval = statusEval;
    } else {
      const until = addDaysIso(plan.analysisStart, cpDays - 1);
      decisionEval = evaluateWindow(runReadout({ plan, weights: rc.weights, until, tmpDir, name: 'decision' }), plan, planned);
    }
  }

  let decision = decideAction({ rc, decisionEval, plan, planned });
  if (!statusPayload && decision.phase === 'collecting') decision = { ...decision, phase: 'waiting' };
  const active = rc.enabled && !rc.force;
  const alarms = active && statusEval ? collectAlarms(statusEval, plan) : [];
  const estimate = statusEval && active ? estimateDecisionWindowEnd(statusEval, plan, planned) : null;

  let applied = null;
  let publishError = null;
  const promotionApproved = mayPublishPromotion({
    apply: args.apply,
    approvePromotion: args['approve-promotion'],
    eventName,
  });
  if (decision.action === 'promote') {
    const rcArgs = [RC_SCRIPT, '--enabled', 'true', '--arms', JSON.stringify(rc.weights), '--force-arm', decision.winner];
    if (promotionApproved) {
      try {
        publishRc([...rcArgs, '--apply']);
        applied = true;
      } catch (e) {
        applied = false;
        publishError = e;
      }
    } else if (!args.apply && !args['approve-promotion']) {
      console.error(`DRY-RUN: promozione pronta, comando non eseguito: node ${path.relative(process.cwd(), RC_SCRIPT)} ${rcArgs.slice(1).map(shellQuote).join(' ')} --apply --approve-promotion`);
    } else {
      console.error('PROMOZIONE BLOCCATA: servono --apply e --approve-promotion; nei workflow GitHub è ammessa solo con workflow_dispatch.');
    }
  }

  const state = {
    v: 1,
    phase: decision.phase,
    action: decision.action,
    winner: decision.winner,
    alarms: alarms.map((a) => a.id).sort(),
    applied,
    window: statusEval ? `${statusEval.since}..${statusEval.until}` : null,
  };
  const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
  let report = renderMonitorReport({ plan, planned, rc, statusEval, decisionEval, decision, alarms, estimate, statusPayload, state, runUrl, applied });
  if (publishError) report = report.replace('## Azione\n', `## Azione\n\n**Pubblicazione Remote Config FALLITA:** ${String(publishError.message || publishError).slice(0, 300)}\n`);
  process.stdout.write(`${report}\n`);

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'monitor.md'), `${report}\n`);
    fs.writeFileSync(path.join(args.out, 'monitor.json'), `${JSON.stringify({ generatedAt: now.toISOString(), plan, planned, rc, state, decision, alarms, estimate, statusEval, decisionEval }, null, 2)}\n`);
  }

  if (args.issues) {
    const { ensureLabelsExist } = await import('../lib/github-issue-creator.mjs');
    ensureLabelsExist([...new Set([...STATUS_LABELS, ...OWNER_LABELS])]);
    const prevIssue = findStatusIssue();
    await syncIssues({ report, state, prevIssue, alarms, decision, applied, runUrl, workflow: 'jobgate-experiment-monitor' });
  }
  return { exitCode: publishError ? 1 : 0, decision, alarms, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMonitor(process.argv.slice(2))
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((e) => {
      console.error(`jobgate-v3-monitor: ${e?.stack || e}`);
      process.exit(1);
    });
}
