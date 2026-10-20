#!/usr/bin/env node

// Read-only automation plan for one deterministic Instagram treatment.

import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { chooseInstagramCreative } from './lib/instagram-creative.mjs';
import { instagramEngagementMechanic, instagramFollowUpAction } from './lib/instagram-engagement.mjs';
import { chooseInstagramReelCreative } from './lib/instagram-reel-creative.mjs';

export const DEFAULT_DATE = new Date().toISOString().slice(0, 10);
export const DEFAULT_KIND = 'article';
export const VALID_KINDS = Object.freeze(['article', 'job', 'border', 'reel']);
export const VALID_REEL_SOURCE_KINDS = Object.freeze(['article', 'job']);

const KIND_LABELS = Object.freeze({
  article: 'articoli',
  job: 'lavoro',
  border: 'valichi',
  reel: 'Reel',
});

function isValidIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  return Number.isFinite(timestamp)
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} needs a value`);
  return value;
}

export function parseArgs(argv = []) {
  const options = {
    date: DEFAULT_DATE,
    kind: DEFAULT_KIND,
    sourceKind: 'article',
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--date') options.date = nextValue(argv, index++, '--date');
    else if (arg.startsWith('--date=')) options.date = arg.slice('--date='.length);
    else if (arg === '--kind') options.kind = nextValue(argv, index++, '--kind');
    else if (arg.startsWith('--kind=')) options.kind = arg.slice('--kind='.length);
    else if (arg === '--source-kind') options.sourceKind = nextValue(argv, index++, '--source-kind');
    else if (arg.startsWith('--source-kind=')) options.sourceKind = arg.slice('--source-kind='.length);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!isValidIsoDate(options.date)) throw new Error('--date must be a valid YYYY-MM-DD date');
  if (!VALID_KINDS.includes(options.kind)) throw new Error(`--kind must be one of: ${VALID_KINDS.join(', ')}`);
  if (!VALID_REEL_SOURCE_KINDS.includes(options.sourceKind)) {
    throw new Error(`--source-kind must be one of: ${VALID_REEL_SOURCE_KINDS.join(', ')}`);
  }
  return options;
}

function contentLabel(kind, sourceKind) {
  if (kind === 'reel') return `Reel sul ${KIND_LABELS[sourceKind]}`;
  return {
    article: 'post sugli articoli',
    job: 'post sul lavoro',
    border: 'post sui valichi',
  }[kind];
}

function promptsFor(creative, { kind, sourceKind }) {
  const label = contentLabel(kind, sourceKind);
  if (creative.primaryMetric === 'comments') {
    return {
      commentPrompt: creative.question || creative.cta,
      storyPrompt: `Sondaggio dopo il ${label}: quale risposta o dubbio vuoi vedere spiegato per primo?`,
      replyTemplate: 'Grazie per averlo scritto. Verifichiamo questo punto con una fonte e lo trasformiamo in una risposta utile per tutti.',
      operatorAction: 'Il worker risponde ai commenti entro 24 ore e mantiene il ciclo automatico nel registro del test.',
    };
  }
  if (creative.primaryMetric === 'saves') {
    return {
      commentPrompt: `Quale passaggio di questo ${label} vuoi ritrovare più facilmente?`,
      storyPrompt: `Quiz dopo il ${label}: quale voce della checklist controlleresti prima?`,
      replyTemplate: 'La voce più richiesta entra nella prossima checklist; nel frattempo trovi il riferimento completo nel link in bio.',
      operatorAction: 'Il worker risponde ai commenti entro 24 ore; Insights misura salvataggi e reach della checklist.',
    };
  }
  return {
    commentPrompt: `Quale dato di questo ${label} condivideresti con una persona che vive tra Italia e Svizzera?`,
    storyPrompt: `Sondaggio dopo il ${label}: lo avevi previsto oppure il dato ti ha sorpreso?`,
    replyTemplate: 'Grazie: il dato è utile proprio quando aiuta una decisione concreta. Lo riprendiamo nel prossimo aggiornamento con fonte e data.',
    operatorAction: 'Il worker gestisce le eventuali domande entro 24 ore; Insights misura condivisioni e reach senza spam.',
  };
}

/** Build a deterministic, read-only brief for the operator who manages the account. */
export function buildInstagramEngagementPlan({ kind = DEFAULT_KIND, sourceKind = 'article', day = DEFAULT_DATE } = {}) {
  if (!VALID_KINDS.includes(kind)) throw new Error(`unknown Instagram engagement plan kind: ${kind}`);
  if (!VALID_REEL_SOURCE_KINDS.includes(sourceKind)) throw new Error(`unknown Reel source kind: ${sourceKind}`);
  if (!isValidIsoDate(day)) throw new Error('day must be a valid YYYY-MM-DD date');

  const creative = kind === 'reel'
    ? chooseInstagramReelCreative({ kind: sourceKind, day })
    : chooseInstagramCreative({ kind, day });
  const prompts = promptsFor(creative, { kind, sourceKind });

  return {
    schemaVersion: 1,
    day,
    kind,
    sourceKind: kind === 'reel' ? sourceKind : null,
    contentLabel: contentLabel(kind, sourceKind),
    creativeId: creative.id,
    creativeBaseId: creative.baseId || (kind === 'reel' ? 'reel' : creative.id.split('-', 1)[0]),
    creativeVariant: creative.variant || (kind === 'reel' ? creative.id : 'baseline'),
    creativeLabel: creative.label,
    creativeObjective: creative.objective,
    primaryMetric: creative.primaryMetric,
    engagementMechanic: instagramEngagementMechanic(creative.primaryMetric),
    hookType: creative.hookType,
    attentionMechanic: creative.attentionMechanic,
    engagementLoop: creative.engagementLoop,
    followUpFormat: creative.followUpFormat,
    primaryAction: creative.primaryMetric === 'comments'
      ? 'comment'
      : creative.primaryMetric === 'shares' ? 'share' : 'save',
    commentPrompt: prompts.commentPrompt,
    storyPrompt: prompts.storyPrompt,
    replyTemplate: prompts.replyTemplate,
    operatorAction: prompts.operatorAction,
    followUpAction: instagramFollowUpAction(creative.followUpFormat),
    automationMode: 'chrome-browser',
    manualOnly: false,
    responseSlaHours: 24,
    followUpWithinHours: 72,
    measurement: {
      diagnosticWindowHours: 24,
      decisionWindowHours: 72,
      primaryMetric: creative.primaryMetric,
      minimumComparableObservations: 3,
      comparisonUnit: 'creativeId + content kind + measurement window',
    },
  };
}

function usage() {
  return [
    'instagram-engagement-plan.mjs — piano automatico per una creatività Instagram',
    '',
    'Usage:',
    '  node scripts/instagram-engagement-plan.mjs --date=2026-10-10 --kind=article',
    '  node scripts/instagram-engagement-plan.mjs --date=2026-10-10 --kind=reel --source-kind=job --json',
    '',
    'Il comando è deterministico e read-only; l’invio automatico è eseguito dal worker del robot.',
  ].join('\n');
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const plan = buildInstagramEngagementPlan({
    kind: options.kind,
    sourceKind: options.sourceKind,
    day: options.date,
  });
  console.log(options.json ? JSON.stringify(plan, null, 2) : [
    `📣 Instagram engagement plan — ${plan.day} · ${plan.contentLabel}`,
    `   Creatività: ${plan.creativeId} · hook ${plan.hookType} · loop ${plan.engagementLoop}`,
    `   Azione primaria: ${plan.primaryAction} · metrica: ${plan.primaryMetric}`,
    `   Comment prompt: ${plan.commentPrompt}`,
    `   Story prompt: ${plan.storyPrompt}`,
    `   Entro 24h: ${plan.operatorAction}`,
    `   Entro 72h: ${plan.followUpAction}`,
    '   Automatico: il worker Chrome gestisce commenti e DM consentiti; le Stories restano nel fallback Graph esplicito.',
  ].join('\n'));
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`❌ Instagram engagement plan: ${error.message}`);
    process.exitCode = 2;
  }
}
