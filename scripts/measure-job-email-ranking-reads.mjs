#!/usr/bin/env node
/**
 * measure-job-email-ranking-reads.mjs — letture Firestore e tempo degli input
 * di ordinamento dei due invii con annunci, prima (baseline, ramo CTR) e dopo
 * (HEAD, variante affinity). Sola lettura sulla produzione.
 *
 * Cosa misura, per percorso d'invio:
 *  - newsletter, baseline: `loadNewsletterRankingStats(db, { sinceDay })` del
 *    codice di `--baseline-ref` (default origin/main), la query su
 *    `job_email_ranking_stats` della finestra di 60 giorni fatta a ogni invio;
 *  - newsletter, HEAD: `loadJobEmailAffinityProfiles` sui destinatari
 *    confermati (una lettura di profilo per persona, getAll a lotti);
 *  - job alert, baseline: `embeddedAlertRankingStats(alert)` del codice di
 *    `--baseline-ref`, una funzione pura sull'alert gia' caricato dal sender:
 *    si esegue su un campione di alert reali con un Firestore che conta ogni
 *    accesso, e il tempo per alert si moltiplica per gli alert attivi;
 *  - job alert, HEAD: `loadJobEmailAffinityProfiles` sugli iscritti attivi.
 *
 * Le chiamate si contano avvolgendo `db` (query.get e getAll), il tempo con
 * performance.now(). Le liste dei destinatari si leggono prima e fuori dalla
 * misura. L'output e' solo aggregato: nessuna email, pseudonimo o id.
 *
 *   source bin/rc-env.sh   # NEWSLETTER_SECRET, dalla root del workspace
 *   node scripts/measure-job-email-ranking-reads.mjs \
 *     --out scripts/measurements/job-email-ranking-reads-2026-10-05.json
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadJobEmailAffinityProfiles } from '../functions/src/lib/jobEmailAffinityStore.js';
import { RANKING_PERSONALIZATION_OPT_OUT_FIELD } from '../functions/src/lib/jobEmailAffinity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALERT_SAMPLE = 200;
const WINDOW_DAYS = 60;

/** `db` che conta le chiamate (query.get, getAll) e i documenti restituiti. */
export function countingDb(db) {
  const counts = { calls: 0, docs: 0 };
  const wrapQuery = (query) => new Proxy(query, {
    get(target, prop) {
      if (prop === 'where' || prop === 'orderBy' || prop === 'limit' || prop === 'select') {
        return (...args) => wrapQuery(target[prop](...args));
      }
      if (prop === 'get') {
        return async (...args) => {
          counts.calls += 1;
          const snapshot = await target.get(...args);
          counts.docs += snapshot?.size ?? snapshot?.docs?.length ?? 0;
          return snapshot;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'collection' || prop === 'collectionGroup') return (...args) => wrapQuery(target[prop](...args));
      if (prop === 'getAll') {
        return async (...refs) => {
          counts.calls += 1;
          const snapshots = await target.getAll(...refs);
          counts.docs += snapshots.length;
          return snapshots;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, counts };
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, elapsedMs: Math.round(performance.now() - start) };
}

/** Il codice di `ref` per i due punti della baseline, senza toccare il worktree. */
async function loadBaseline(ref) {
  const sha = execFileSync('git', ['rev-parse', ref], { cwd: ROOT }).toString().trim();
  const dir = path.join(ROOT, `.measure-baseline-${sha.slice(0, 12)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const archive = execFileSync('git', ['archive', sha, 'functions/src/lib'], { cwd: ROOT, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  const store = await import(pathToFileURL(path.join(dir, 'functions/src/lib/jobEmailRankingStore.js')).href);
  const sender = execFileSync('git', ['show', `${sha}:scripts/send-job-alerts.mjs`], { cwd: ROOT, maxBuffer: 1 << 30 }).toString();
  const match = sender.match(/function embeddedAlertRankingStats\(alert\) \{[\s\S]*?\n\}/);
  if (!match || typeof store.loadNewsletterRankingStats !== 'function') {
    throw new Error(`baseline ${ref}: loadNewsletterRankingStats o embeddedAlertRankingStats non trovati`);
  }
  // eslint-disable-next-line no-new-func
  const embeddedAlertRankingStats = new Function(`${match[0]}\nreturn embeddedAlertRankingStats;`)();
  return { sha, dir, loadNewsletterRankingStats: store.loadNewsletterRankingStats, embeddedAlertRankingStats };
}

async function recipients(db, collection, status) {
  const snapshot = await db.collection(collection).where('status', '==', status).select(RANKING_PERSONALIZATION_OPT_OUT_FIELD).get();
  return snapshot.docs.map((doc) => ({ email: doc.id, optOut: doc.get(RANKING_PERSONALIZATION_OPT_OUT_FIELD) === true }));
}

export function summarizeLoader(result, counts, elapsedMs) {
  return {
    firestore_calls: counts.calls,
    docs_read: counts.docs,
    recipients: result.stats.recipients,
    opted_out: result.stats.opted_out,
    profiles_found: result.stats.found,
    failed: result.stats.failed,
    elapsed_ms: elapsedMs,
  };
}

export async function measure({ db, secret, baselineRef = 'origin/main', now = new Date() }) {
  if (!secret) throw new Error('NEWSLETTER_SECRET mancante: senza, lo pseudonimo dei profili non si calcola');
  const baseline = await loadBaseline(baselineRef);
  try {
    const newsletterRecipients = await recipients(db, 'newsletter_subscribers', 'confirmed');
    const jobAlertRecipients = await recipients(db, 'job_alert_subscribers', 'active');
    const activeAlerts = (await db.collectionGroup('alerts').where('active', '==', true).count().get()).data().count;
    const alertSample = (await db.collectionGroup('alerts').where('active', '==', true).select('ranking_stats').limit(ALERT_SAMPLE).get()).docs.map((doc) => doc.data());

    // Newsletter, baseline: la query delle statistiche per annuncio.
    const sinceDay = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const nlBase = countingDb(db);
    const nlBaseRun = await timed(() => baseline.loadNewsletterRankingStats(nlBase.db, { sinceDay }));
    // Newsletter, HEAD: un profilo per destinatario.
    const nlHead = countingDb(db);
    const nlHeadRun = await timed(() => loadJobEmailAffinityProfiles(nlHead.db, newsletterRecipients, { secret }));

    // Job alert, baseline: funzione pura sull'alert caricato; un db che conta ogni accesso.
    const jaBase = countingDb(db);
    const jaBaseRun = await timed(async () => {
      let jobs = 0;
      for (const alert of alertSample) jobs += baseline.embeddedAlertRankingStats(alert).size;
      return jobs;
    });
    const perAlertMs = alertSample.length ? jaBaseRun.elapsedMs / alertSample.length : 0;
    // Job alert, HEAD: un profilo per iscritto attivo.
    const jaHead = countingDb(db);
    const jaHeadRun = await timed(() => loadJobEmailAffinityProfiles(jaHead.db, jobAlertRecipients, { secret }));

    return {
      _what: 'Letture Firestore e tempo degli input di ordinamento dei due invii con annunci: baseline (ramo CTR) contro HEAD (variante affinity). Solo aggregati.',
      _how: 'node scripts/measure-job-email-ranking-reads.mjs --out <file> (sola lettura, produzione; NEWSLETTER_SECRET da Remote Config)',
      generated_at: now.toISOString(),
      baseline_ref: baselineRef,
      baseline_sha: baseline.sha,
      newsletter: {
        baseline: {
          function: 'loadNewsletterRankingStats (job_email_ranking_stats, finestra 60 giorni)',
          firestore_calls: nlBase.counts.calls,
          docs_read: nlBase.counts.docs,
          jobs_with_stats: nlBaseRun.value.size,
          elapsed_ms: nlBaseRun.elapsedMs,
        },
        head: { function: 'loadJobEmailAffinityProfiles', ...summarizeLoader(nlHeadRun.value, nlHead.counts, nlHeadRun.elapsedMs) },
      },
      job_alert: {
        baseline: {
          function: 'embeddedAlertRankingStats (pura, sull\'alert gia\' caricato)',
          firestore_calls: jaBase.counts.calls,
          docs_read: jaBase.counts.docs,
          alerts_sampled: alertSample.length,
          active_alerts: activeAlerts,
          elapsed_ms_sample: jaBaseRun.elapsedMs,
          elapsed_ms_per_send_estimated: Math.round(perAlertMs * activeAlerts),
        },
        head: { function: 'loadJobEmailAffinityProfiles', ...summarizeLoader(jaHeadRun.value, jaHead.counts, jaHeadRun.elapsedMs) },
      },
      notes: [
        'Le liste dei destinatari (newsletter confirmed, job alert active) e il campione di alert sono letti prima e fuori dalla misura: nei sender sono gia\' caricati per l\'invio.',
        'Job alert baseline: la funzione non tocca Firestore; il tempo per invio e\' il tempo medio per alert del campione per gli alert attivi.',
        'Job alert HEAD: l\'opposizione si legge dal documento newsletter; qui gli iscritti job alert sono letti senza quel flag, quindi il conteggio e\' un tetto superiore.',
      ],
    };
  } finally {
    fs.rmSync(baseline.dir, { recursive: true, force: true });
  }
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex > -1 ? process.argv[outIndex + 1] : null;
  const refIndex = process.argv.indexOf('--baseline-ref');
  const baselineRef = refIndex > -1 ? process.argv[refIndex + 1] : 'origin/main';
  const { getFirestoreDb } = await import('./lib/firestore-admin.mjs');
  const db = await getFirestoreDb();
  const report = await measure({ db, secret: process.env.NEWSLETTER_SECRET, baselineRef });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (/@/.test(json)) throw new Error('il report contiene un indirizzo email: non lo scrivo');
  if (out) fs.writeFileSync(path.resolve(out), json);
  console.log(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
