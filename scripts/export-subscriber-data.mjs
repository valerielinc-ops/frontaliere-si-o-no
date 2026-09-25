#!/usr/bin/env node
/**
 * export-subscriber-data.mjs — estrae tutto ciò che conserviamo su un indirizzo
 * email e produce un documento consegnabile all'interessato (art. 25 LPD).
 *
 * SOLA LETTURA. Non scrive mai su Firestore. Rispondere a una richiesta di
 * accesso non deve poter modificare i dati che la richiesta contesta.
 *
 * La formattazione vive in scripts/lib/subscriberExport.mjs ed è pura: qui
 * dentro c'è solo l'I/O.
 *
 * Uso:
 *   node scripts/export-subscriber-data.mjs <email>
 *   node scripts/export-subscriber-data.mjs <email> --out ~/export.md
 *   node scripts/export-subscriber-data.mjs <email> --json
 *
 * Variabili d'ambiente:
 *   GOOGLE_APPLICATION_CREDENTIALS — service account con accesso a Firestore
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSubscriberExport } from './lib/subscriberExport.mjs';

const COLLECTION_NEWSLETTER = 'newsletter_subscribers';
const COLLECTION_JOB_ALERT = 'job_alert_subscribers';

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
  };
  return { email: (positional[0] || '').trim().toLowerCase(), out: flag('out'), json: flag('json') === true };
}

/**
 * Rifiuta di scrivere l'estrazione dentro il repository: contiene dati
 * personali e il repo è pubblico. Un `git add -A` distratto basterebbe.
 */
function assertOutsideRepo(outPath) {
  let repoRoot;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  } catch {
    return; // fuori da un repo: nessun rischio da prevenire
  }
  const resolved = path.resolve(outPath);
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    console.error(
      `\n✗ Rifiuto di scrivere dentro il repository (${repoRoot}).\n` +
      "  L'estrazione contiene dati personali e questo repo è pubblico.\n" +
      '  Scegli un percorso fuori dal repo, per esempio ~/export.md\n',
    );
    process.exit(2);
  }
}

async function getDb() {
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath && fs.existsSync(credPath)) {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      initializeApp(cred.project_id ? { credential: cert(cred) } : { credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    } else {
      initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    }
  }
  return getFirestore();
}

/** Legge una sottocollezione senza far esplodere l'export se non esiste. */
async function readSub(ref, name) {
  try {
    const snap = await ref.collection(name).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`  (avviso: lettura di ${name} fallita: ${err?.message || err})`);
    return [];
  }
}

async function main() {
  const { email, out, json } = parseArgs(process.argv);
  if (!email || !email.includes('@')) {
    console.error('Uso: node scripts/export-subscriber-data.mjs <email> [--out <percorso>] [--json]');
    process.exit(1);
  }
  if (typeof out === 'string') assertOutsideRepo(out);

  const db = await getDb();

  const nlRef = db.collection(COLLECTION_NEWSLETTER).doc(email);
  const nlSnap = await nlRef.get();
  const subscriber = nlSnap.exists ? nlSnap.data() : null;
  const events = nlSnap.exists ? await readSub(nlRef, 'events') : [];
  const deliveries = nlSnap.exists ? await readSub(nlRef, 'campaign_deliveries') : [];

  const jaRef = db.collection(COLLECTION_JOB_ALERT).doc(email);
  const jaSnap = await jaRef.get();
  const jobAlert = jaSnap.exists ? jaSnap.data() : null;
  const alerts = jaSnap.exists ? await readSub(jaRef, 'alerts') : [];

  if (json) {
    const payload = { email, subscriber, events, deliveries, jobAlert, alerts };
    const text = JSON.stringify(payload, null, 2);
    if (typeof out === 'string') fs.writeFileSync(out, text);
    else console.log(text);
  } else {
    const markdown = buildSubscriberExport(
      { email, subscriber, events, deliveries, jobAlert, alerts },
      { generatedAt: new Date().toISOString() },
    );
    if (typeof out === 'string') fs.writeFileSync(out, markdown);
    else console.log(markdown);
  }

  if (typeof out === 'string') {
    console.error(`\n✓ Estrazione scritta in ${out}`);
    console.error('  Contiene dati personali: consegnala all\'interessato e non lasciarla in giro.');
  }
}

main().catch((err) => {
  console.error('Errore:', err?.message || err);
  process.exit(1);
});
