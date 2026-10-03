#!/usr/bin/env node
/**
 * check-employer-insights-freshness.mjs — l'osservatore di freschezza della
 * collection Firestore `employer_insights`.
 *
 * ─── Il buco che tappa ───────────────────────────────────────────────────
 *
 * `employer-insights-refresh.yml` riscrive ogni giorno le dashboard dei
 * datori. Dal 2026-09-22 al 2026-10-03 dodici run consecutive si sono fermate
 * PRIMA della scrittura (un cancello di accettazione una tantum cablato
 * davanti alla scrittura ricorrente): la run era rossa, ma nessuno diceva la
 * cosa che conta per il prodotto, cioè che i datori leggevano numeri fermi.
 * Un rosso racconta che uno step è fallito; questo controllo racconta DA
 * QUANTO il dato non viene riscritto, qualunque sia lo step che lo ferma.
 *
 * ─── Cosa misura ─────────────────────────────────────────────────────────
 *
 * Ogni root scritta da `writeEmployerInsightsDocuments` porta `updatedAt`
 * (server timestamp, vedi `employerInsightsRootData`). Il rollback di una
 * scrittura fallita ripristina le root col loro `updatedAt` precedente, quindi
 * il massimo di `updatedAt` è l'ultima scrittura RIUSCITA. Si legge con una
 * sola query `orderBy('updatedAt','desc').limit(1)`: un documento letto per
 * run, non la collection.
 *
 * ─── Fail-closed ─────────────────────────────────────────────────────────
 *
 * Nessuna root con `updatedAt` leggibile NON è «fresco»: è una issue. Un
 * errore di lettura (credenziali, rete) fa uscire lo script con codice 1 e non
 * chiude niente: l'assenza di misura non è una guarigione.
 *
 * Uso:
 *   node scripts/ci/check-employer-insights-freshness.mjs [--dry-run] [--max-age-days=<n>]
 *   --dry-run: legge e stampa il verdetto, non apre né chiude issue.
 */

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { buildScheda } from '../lib/monitor-scheda.mjs';

export const EMPLOYER_INSIGHTS_COLLECTION = 'employer_insights';
export const MAX_AGE_DAYS = 3;
export const STABLE_ISSUE_TITLE = 'Employer Insights: scrittura quotidiana ferma da oltre 3 giorni';
export const WORKFLOW_NAME = 'Refresh Employer Insights';
const DAY_MS = 24 * 60 * 60 * 1000;
// Un orologio del runner leggermente indietro rispetto al server timestamp di
// Firestore non è un dato dal futuro.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const COMMAND = 'node scripts/ci/check-employer-insights-freshness.mjs --dry-run';

/** Firestore Timestamp, Date o stringa ISO → Date valida, altrimenti null. */
export function toDate(value) {
  if (value == null) return null;
  const date = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
  return date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Il verdetto di freschezza. Puro.
 *
 * @param {{ latestUpdatedAt: unknown, now?: Date, maxAgeDays?: number }} input
 * @returns {{ stale: boolean, measurable: boolean, latestUpdatedAt: string|null, ageDays: number|null, maxAgeDays: number, reason: string }}
 */
export function evaluateFreshness({ latestUpdatedAt, now = new Date(), maxAgeDays = MAX_AGE_DAYS }) {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error('maxAgeDays must be a finite positive number');
  const latest = toDate(latestUpdatedAt);
  if (!latest) {
    return {
      stale: true,
      measurable: false,
      latestUpdatedAt: null,
      ageDays: null,
      maxAgeDays,
      reason: `nessuna root di ${EMPLOYER_INSIGHTS_COLLECTION} porta un updatedAt leggibile`,
    };
  }
  const ageMs = now.getTime() - latest.getTime();
  if (ageMs < -CLOCK_SKEW_MS) {
    return {
      stale: true,
      measurable: false,
      latestUpdatedAt: latest.toISOString(),
      ageDays: null,
      maxAgeDays,
      reason: `l'ultimo updatedAt (${latest.toISOString()}) è nel futuro rispetto al controllo`,
    };
  }
  const ageDays = Math.max(0, ageMs) / DAY_MS;
  const stale = ageDays > maxAgeDays;
  return {
    stale,
    measurable: true,
    latestUpdatedAt: latest.toISOString(),
    ageDays: Number(ageDays.toFixed(2)),
    maxAgeDays,
    reason: stale
      ? `ultima scrittura riuscita ${ageDays.toFixed(1)} giorni fa (soglia ${maxAgeDays})`
      : `ultima scrittura riuscita ${ageDays.toFixed(1)} giorni fa (entro la soglia di ${maxAgeDays})`,
  };
}

/** Corpo della issue: puro, esportato per tests/monitor-scheda-openers.test.ts. */
export function buildIssueBody(verdict, { runUrl = '' } = {}) {
  const measured = verdict.ageDays === null ? 'non misurabile' : `${verdict.ageDays} giorni`;
  return [
    '## Employer Insights: le dashboard dei datori leggono dati fermi',
    '',
    `**Ultima scrittura riuscita:** ${verdict.latestUpdatedAt || 'non misurabile'}`,
    `**Età:** ${measured} (soglia ${verdict.maxAgeDays})`,
    `**Dettaglio:** ${verdict.reason}`,
    ...(runUrl ? [`**Run che ha misurato:** ${runUrl}`] : []),
    '',
    '_Fonte: scripts/ci/check-employer-insights-freshness.mjs, eseguito a ogni run di .github/workflows/employer-insights-refresh.yml anche quando uno step precedente fallisce._',
    '',
    buildScheda({
      causa: [
        `(ipotesi, da confermare.) Uno step di \`${WORKFLOW_NAME}\` fallisce prima di`,
        '`Write exactly the validated payload with rollback guard`, oppure la scrittura parte e',
        'viene annullata dal rollback. Il nome dello step rosso nelle ultime run dice quale dei due.',
      ],
      fix: [
        'Leggere lo step fallito delle ultime run e correggere quello: la soglia di questo',
        'controllo non si alza per far tacere la issue. | **REPO**: sito',
      ],
      metrica: `prima=${measured} dall'ultima scrittura atteso=<=${verdict.maxAgeDays} giorni`,
      comando: COMMAND,
      note: [
        'Il comando legge una sola root (la più recente per `updatedAt`) e stampa il verdetto senza',
        'aprire né chiudere issue. Vuole `GOOGLE_APPLICATION_CREDENTIALS` del progetto.',
      ],
      osservatore: [
        '`.github/workflows/employer-insights-refresh.yml`, step `Alert when the last successful',
        'write is stale`: rivaluta a ogni run, commenta finché il dato resta fermo e chiude la issue',
        'alla prima run che trova una scrittura entro la soglia.',
      ],
      fallimento: `\`${STABLE_ISSUE_TITLE}\``,
    }),
  ].join('\n');
}

async function defaultReadLatestUpdatedAt() {
  const { getFirestoreDb } = await import('../lib/firestore-admin.mjs');
  const db = await getFirestoreDb();
  const snapshot = await db
    .collection(EMPLOYER_INSIGHTS_COLLECTION)
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get();
  return snapshot.empty ? null : snapshot.docs[0].data()?.updatedAt ?? null;
}

async function defaultCreateIssue({ title, description }) {
  const { createGithubIssue } = await import('../lib/github-issue-creator.mjs');
  return createGithubIssue({
    title,
    description,
    priority: 2,
    labels: ['Bug'],
    workflow: WORKFLOW_NAME,
    exactTitle: true,
  });
}

async function defaultResolveIssue({ title, runUrl }) {
  const { resolveGithubIssue } = await import('../lib/github-issue-creator.mjs');
  return resolveGithubIssue(title, { workflow: WORKFLOW_NAME, runUrl, exactTitle: true });
}

/**
 * Orchestrazione, con I/O iniettabile per i test.
 * Stantio (o non misurabile) → apre/commenta la issue dal titolo stabile.
 * Fresco → chiude la issue aperta, se c'è.
 */
export async function runFreshnessCheck({
  now = new Date(),
  maxAgeDays = MAX_AGE_DAYS,
  dryRun = false,
  runUrl = process.env.RUN_URL || '',
  readLatestUpdatedAtImpl = defaultReadLatestUpdatedAt,
  createIssueImpl = defaultCreateIssue,
  resolveIssueImpl = defaultResolveIssue,
} = {}) {
  const latestUpdatedAt = await readLatestUpdatedAtImpl();
  const verdict = evaluateFreshness({ latestUpdatedAt, now, maxAgeDays });
  if (dryRun) return { verdict, action: 'dry-run' };
  if (verdict.stale) {
    await createIssueImpl({ title: STABLE_ISSUE_TITLE, description: buildIssueBody(verdict, { runUrl }) });
    return { verdict, action: 'issue-opened' };
  }
  await resolveIssueImpl({ title: STABLE_ISSUE_TITLE, runUrl });
  return { verdict, action: 'resolved-if-open' };
}

function parseArgs(argv) {
  const options = { dryRun: false, maxAgeDays: MAX_AGE_DAYS };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--max-age-days=')) options.maxAgeDays = Number(arg.slice('--max-age-days='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const { verdict, action } = await runFreshnessCheck(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ ...verdict, action }));
    if (verdict.stale) console.log(`::warning title=${STABLE_ISSUE_TITLE}::${verdict.reason}`);
  } catch (error) {
    console.error(`::error::employer insights freshness check failed: ${error?.message || error}`);
    process.exit(1);
  }
}
