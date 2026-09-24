#!/usr/bin/env node
/**
 * check-auth-signup-subscribers.mjs — osservatore contro la recidiva del buco
 * iscrizioni-da-login del 12-15 settembre 2026.
 *
 * COSA E' SUCCESSO
 *
 * #8341 (merge 12/09 01:48Z, regole Firestore 01:49Z, sito 06:13Z) ha separato
 * per scelta il login dall'iscrizione: da quel momento un login Google/LinkedIn
 * scriveva solo uno stub di profilo in `newsletter_subscribers/{email}`, senza
 * `status` ne' base di consenso. #8754 (merge 15/09 23:10Z; regole 23:11Z,
 * functions 23:14Z, sito 16/09 17:52Z) ha rimesso il login dentro la relazione
 * di comunicazione con i termini di registrazione. In mezzo, le creazioni
 * `auth_*` per `created_at` sono state 3/1/1/1 al giorno contro 60-80, e nessun
 * monitor lo ha detto. Il dettaglio e la lettura di questa misura stanno in
 * scripts/lib/authSignupSubscriberMetrics.mjs.
 *
 * COSA MISURA
 *
 * Nella finestra (default 24h che terminano ora, o a `--until`):
 *   - documenti `newsletter_subscribers` con `created_at` nella finestra, per
 *     `source_channel`; la soglia guarda quelli `auth_*`;
 *   - account Firebase Auth creati nella finestra, ciascuno classificato sul
 *     proprio documento (`subscribed` / `stub` / `missing`).
 * Nessuna email esce da questo processo: i documenti si leggono per id, e
 * report, storia e alert contengono solo conteggi.
 *
 * REPLAY
 *
 *   node scripts/check-auth-signup-subscribers.mjs --until=2026-09-14T07:25:00Z --json --dry-run
 *
 * rilegge una finestra passata. `created_at` e la data di creazione
 * dell'account sono immutabili, quindi la soglia 1 si rigioca fedelmente; la
 * classificazione degli account usa invece lo stato ATTUALE dei documenti, e
 * sottostima un buco passato che un login successivo ha gia' ricucito.
 *
 * Usage:
 *   node scripts/check-auth-signup-subscribers.mjs                 # 24h, scrive storia/alert
 *   node scripts/check-auth-signup-subscribers.mjs --json --dry-run  # sola lettura
 *   node scripts/check-auth-signup-subscribers.mjs --hours=48 --until=<ISO> --json --dry-run
 *
 * Exit 1 quando c'e' un finding che allarma (il workflow apre la issue);
 * exit 0 altrimenti.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregate,
  evaluate,
  pct,
  classifySubscriberDoc,
  providerFamily,
  AUTH_SUBSCRIBER_FLOOR,
  MIN_ACCOUNTS_FOR_FLOOR,
  UNCOVERED_SHARE_WARN,
} from './lib/authSignupSubscriberMetrics.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.resolve(ROOT, 'docs', 'auth-signup-subscribers');
const HISTORY_DAYS = 90;
const DEFAULT_HOURS = 24;
/** Tetto ai documenti letti per `created_at`: ~100/giorno misurati, 5000 copre un dispatch di settimane. */
const SUBSCRIBER_DOC_CAP = 5000;
/** getAll per blocchi: stesso ordine di grandezza degli altri lettori Firestore del repo. */
const GET_ALL_CHUNK = 100;

/* ── CLI ────────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const get = (name) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : undefined;
  };
  const h = Number.parseInt(get('hours') ?? '', 10);
  const untilRaw = get('until');
  const until = untilRaw ? new Date(untilRaw) : null;
  if (until && Number.isNaN(until.getTime())) {
    throw new Error(`--until non e' una data ISO valida: ${untilRaw}`);
  }
  return {
    hours: Number.isFinite(h) && h > 0 ? h : DEFAULT_HOURS,
    until,
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
  };
}

let JSON_ONLY = false;
const log = (...a) => { if (!JSON_ONLY) console.log(...a); };

/* ── Firebase Admin (lazy, stessa forma di check-unsubscribe-credential-rate.mjs) ── */

async function initAdmin() {
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    }
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    if (cred.project_id) initializeApp({ credential: cert(cred) });
    else initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
  }
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  return { db: getFirestore(), auth: getAuth() };
}

/* ── Letture ────────────────────────────────────────────────── */

async function readCreatedSubscribers(db, since, until) {
  const snap = await db.collection('newsletter_subscribers')
    .where('created_at', '>=', since)
    .where('created_at', '<', until)
    .limit(SUBSCRIBER_DOC_CAP)
    .get();
  if (snap.size >= SUBSCRIBER_DOC_CAP) {
    log(`⚠️  Tetto documenti raggiunto (${SUBSCRIBER_DOC_CAP}): la finestra non e' stata letta per intero.`);
  }
  // Solo il canale: nessun altro campo del documento esce da qui.
  return snap.docs.map((d) => ({ source_channel: d.get('source_channel') ?? null }));
}

async function readNewAccounts(auth, since, until) {
  const out = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      const created = u.metadata?.creationTime ? new Date(u.metadata.creationTime) : null;
      if (!created || created < since || created >= until) continue;
      out.push({ email: typeof u.email === 'string' ? u.email.trim().toLowerCase() : '', provider: providerFamily(u) });
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return out;
}

async function classifyAccounts(db, accounts) {
  const withEmail = accounts.filter((a) => a.email && a.email.includes('@'));
  const classified = [];
  for (let i = 0; i < withEmail.length; i += GET_ALL_CHUNK) {
    const chunk = withEmail.slice(i, i + GET_ALL_CHUNK);
    const snaps = await db.getAll(...chunk.map((a) => db.collection('newsletter_subscribers').doc(a.email)));
    snaps.forEach((snap, j) => {
      const data = snap.exists ? snap.data() : null;
      classified.push({
        provider: chunk[j].provider,
        docClass: classifySubscriberDoc(data),
        hasCreatedAt: Boolean(data && data.created_at),
      });
    });
  }
  // Un account senza email non puo' avere un documento: conta come assente.
  for (const a of accounts) {
    if (!a.email || !a.email.includes('@')) classified.push({ provider: a.provider, docClass: 'missing', hasCreatedAt: false });
  }
  return classified;
}

/* ── Report ─────────────────────────────────────────────────── */

const COMMAND = 'node scripts/check-auth-signup-subscribers.mjs --json --dry-run';

/**
 * Corpo della issue: puro, esportato per tests/monitor-scheda-openers.test.ts.
 * @param {ReturnType<typeof aggregate>} agg
 * @param {ReturnType<typeof evaluate>} verdict
 * @param {{ hours: number, since: string, until: string }} meta
 */
export function buildIssueBody(agg, verdict, meta) {
  const lines = [];
  lines.push(`Finestra: ${meta.hours}h, da ${meta.since} a ${meta.until}`);
  lines.push('');
  lines.push('| misura | valore |');
  lines.push('|---|---:|');
  lines.push(`| iscritti creati (\`created_at\` nella finestra) | ${agg.subscribersCreated} |`);
  lines.push(`| di cui \`source_channel\` \`auth_*\` | **${agg.authSubscribers}** (soglia ${AUTH_SUBSCRIBER_FLOOR}) |`);
  lines.push(`| account Firebase Auth creati | ${agg.accountsTotal} (traffico minimo ${MIN_ACCOUNTS_FOR_FLOOR}) |`);
  lines.push(`| account con iscrizione (\`status\` presente) | ${agg.accountClasses.subscribed} |`);
  lines.push(`| account con solo stub di profilo | ${agg.accountClasses.stub} |`);
  lines.push(`| account senza documento | ${agg.accountClasses.missing} |`);
  lines.push(`| quota scoperta | ${pct(agg.uncoveredShare)} (soglia ${pct(UNCOVERED_SHARE_WARN)}) |`);
  lines.push(`| iscritti senza \`created_at\` fra gli account nuovi | ${agg.subscribedWithoutCreatedAt} |`);
  lines.push('');
  const providers = Object.keys(agg.byProvider).sort();
  if (providers.length) {
    lines.push('| provider | iscritti | stub | assenti |');
    lines.push('|---|---:|---:|---:|');
    for (const p of providers) {
      const r = agg.byProvider[p];
      lines.push(`| ${p} | ${r.subscribed} | ${r.stub} | ${r.missing} |`);
    }
    lines.push('');
  }
  for (const f of verdict.findings) lines.push(`- ${f.alert ? '🔴' : 'ℹ️'} \`${f.code}\` (p${f.priority}) — ${f.message}`);
  lines.push('');
  lines.push(buildScheda({
    causa: [
      '(ipotesi, da confermare.) Un deploy ha tolto al login la scrittura della relazione di',
      'comunicazione (`saveUserProfileToFirestore` in services/authService.ts non chiama piu\'',
      '`upsertNewsletterSubscriber`, o le regole Firestore la rifiutano), come #8341 il 12/09/2026.',
    ],
    fix: [
      'Individuare il deploy (sito, regole o functions) che precede il calo e ripristinare la',
      'scrittura con i campi `registration_terms_*`/`consent_*`, oppure confermare che il calo e\'',
      'voluto e alzare la scelta a decisione esplicita. | **REPO**: sito',
    ],
    metrica: `prima=${agg.authSubscribers} iscritti auth_* e ${pct(agg.uncoveredShare)} account scoperti atteso=>=${AUTH_SUBSCRIBER_FLOOR} e <=${pct(UNCOVERED_SHARE_WARN)}`,
    comando: COMMAND,
    note: [
      'Il comando rilegge Firestore e Firebase Auth in sola lettura e stampa il verdetto senza',
      'scrivere storia o alert.json. `--until=<ISO>` rigioca una finestra passata.',
    ],
    osservatore: [
      '`.github/workflows/auth-signup-subscriber-monitor.yml`, ogni giorno alle 07:25 UTC: apre o',
      'commenta la issue quando `alert.json` esiste e la chiude al primo giro pulito. La serie',
      'giornaliera e\' in `docs/auth-signup-subscribers/history.json`.',
    ],
    fallimento: '`[auth-signup] <finding>: iscrizioni da login nelle ultime 24h`',
  }));
  lines.push('');
  lines.push('### Runbook');
  lines.push('');
  lines.push('1. Confronta l\'ora del calo con i deploy: `deploy_registry` (sito), `deploy-firestore-rules.yml`, `deploy-cloud-functions.yml`.');
  lines.push('2. Se gli account nuovi sono `stub`, il login scrive solo il profilo: leggi `saveUserProfileToFirestore` nel commit deployato.');
  lines.push('3. Se sono `missing`, anche la scrittura del profilo fallisce: guarda i rifiuti delle regole su `newsletter_subscribers`.');
  lines.push('4. Il recupero degli account persi passa da un opt-in esplicito, mai da un\'iscrizione d\'ufficio.');
  return lines.join('\n');
}

/* ── Core ───────────────────────────────────────────────────── */

function loadHistory(outDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(outDir, 'history.json'), 'utf8'));
    return { days: Array.isArray(parsed.days) ? parsed.days : [] };
  } catch {
    return { days: [] };
  }
}

/**
 * @param {object} deps
 * @param {{ collection: Function, getAll: Function }} deps.db
 * @param {{ listUsers: Function }} deps.auth
 */
export async function runCheck({ db, auth, hours = DEFAULT_HOURS, until = new Date(), outDir = DEFAULT_OUT_DIR, dryRun = false }) {
  const since = new Date(until.getTime() - hours * 3600_000);
  const [subscriberRows, rawAccounts] = await Promise.all([
    readCreatedSubscribers(db, since, until),
    readNewAccounts(auth, since, until),
  ]);
  const accounts = await classifyAccounts(db, rawAccounts);
  const agg = aggregate({ subscriberRows, accounts });
  const verdict = evaluate(agg);
  const meta = { hours, since: since.toISOString(), until: until.toISOString() };
  const body = buildIssueBody(agg, verdict, meta);
  log(`\n${body}\n`);

  const alertPath = path.join(outDir, 'alert.json');
  if (!dryRun) {
    const history = loadHistory(outDir);
    const date = until.toISOString().slice(0, 10);
    const days = [
      ...history.days.filter((d) => d.date !== date),
      {
        date,
        windowHours: hours,
        subscribersCreated: agg.subscribersCreated,
        authSubscribers: agg.authSubscribers,
        accountsTotal: agg.accountsTotal,
        accountClasses: agg.accountClasses,
        subscribedWithoutCreatedAt: agg.subscribedWithoutCreatedAt,
        findings: verdict.findings.map((f) => f.code),
      },
    ].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-HISTORY_DAYS);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'history.json'), `${JSON.stringify({ days }, null, 2)}\n`, 'utf8');

    if (verdict.alert) {
      const worst = verdict.findings.filter((f) => f.alert).sort((a, b) => a.priority - b.priority)[0];
      // Discriminante PRIMO: github-issue-creator.mjs deduplica sui primi 60
      // caratteri. "[auth-signup] " (14) + il codice piu' lungo,
      // `auth_accounts_without_subscription` (34), fa 48 con i due punti.
      fs.writeFileSync(alertPath, `${JSON.stringify({
        priority: verdict.priority,
        title: `[auth-signup] ${worst.code}: iscrizioni da login nelle ultime 24h`,
        body,
      }, null, 2)}\n`, 'utf8');
      log(`🔴 Alert scritto in ${path.relative(ROOT, alertPath)} (priority ${verdict.priority}).`);
    } else if (fs.existsSync(alertPath)) {
      fs.rmSync(alertPath);
    }
  } else {
    log('[dry-run] nessuna scrittura su storia o alert.json.');
  }
  return { agg, verdict, meta };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  JSON_ONLY = args.json;
  let deps;
  try {
    deps = await initAdmin();
  } catch (err) {
    // Non e' un verde: senza credenziali il monitor e' cieco.
    console.error(`❌ Impossibile inizializzare Firebase Admin: ${err?.message || err}`);
    process.exit(1);
  }
  const { agg, verdict, meta } = await runCheck({
    ...deps,
    hours: args.hours,
    until: args.until || new Date(),
    dryRun: args.dryRun,
  });
  if (args.json) console.log(JSON.stringify({ meta, agg, verdict }, null, 2));
  process.exit(verdict.alert ? 1 : 0);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('check-auth-signup-subscribers.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`❌ check-auth-signup-subscribers fallito: ${err?.message || err}`);
    process.exit(1);
  });
}
