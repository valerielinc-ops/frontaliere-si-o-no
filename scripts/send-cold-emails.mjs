#!/usr/bin/env node
/**
 * Invio cold-email outreach — passo #3 del piano.
 *
 * GATING DI SICUREZZA (azione outward-facing):
 *   • default = DRY-RUN: stampa cosa verrebbe inviato, NON invia.
 *   • --test --target-email <addr>: invia le bozze SOLO a <addr> (override
 *     destinatario) — canale di prova, mai alle aziende reali. Usa questo per
 *     vedere com'è l'email in casella.
 *   • --send: invio REALE ai contatti. Richiede anche --confirm e invia SOLO
 *     alle aziende con `email` verificata (mai a `emailInferred`). Gated apposta.
 *
 * Riusa buildSequence (generate-cold-emails.mjs) + sendEmailCascade (cascade
 * multi-provider esistente). Carica le chiavi via load-rc-env.mjs.
 *
 * Log persistente (send-log.json):
 *   Traccia ogni invio reale (--send) per azienda. Usato per:
 *   - suppression check: aziende con `suppressed: true` vengono saltate
 *   - dedup touch: stessa touch non viene inviata due volte alla stessa azienda
 *   - cap multi-touch: --max-touches N salta aziende con ≥N touch già inviate
 *   Il log è locale (gitignored). Per sopprimere un'azienda: imposta
 *   `suppressed: true` + `suppressedReason` nel send-log.json a mano.
 *
 * Esempi:
 *   # prova in casella (sanzionato): manda la touch-1 di Casale a te stesso
 *   node scripts/send-cold-emails.mjs --test --target-email valerielinc@gmail.com \
 *     --report data/employer-outreach/report.json --company casale-sa --touch 1
 *
 *   # dry-run con stato log (mostra suppressed/cap/già inviata per azienda)
 *   node scripts/send-cold-emails.mjs --report data/employer-outreach/report.json
 *
 *   # invio reale touch-1, max 3 aziende, cap a 2 touch totali per azienda
 *   node scripts/send-cold-emails.mjs --send --confirm \
 *     --report data/employer-outreach/report.json --touch 1 --max-touches 2
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSequence, OPTOUT_EMAIL } from './generate-cold-emails.mjs';
import { bodyToHtml } from './lib/cold-email-sequence.mjs';
import { classifySector } from './lib/employer-sectors.mjs';
import { buildUnsubUrl } from './lib/outreach-unsubscribe-token.mjs';
import { buildInsightsUrl } from './lib/employer-insights-token.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// Sending identity. Configurable via OUTREACH_FROM_ADDRESS so the outreach can be
// moved to an ISOLATED sending subdomain (e.g. valerie@outreach.frontaliereticino.ch
// with its own SPF/DKIM/DMARC — follow-up #2620 item 3) WITHOUT a code change:
// only the env var flips. The value may be a bare address or a full
// `Display Name <addr>` form; a bare address is wrapped with the brand display
// name. Default = the canonical reply address valerie@frontaliereticino.ch.
// CLI `--from` still overrides everything (one-off sends / tests).
const OUTREACH_FROM_ADDRESS = (process.env.OUTREACH_FROM_ADDRESS || '').trim() || 'valerie@frontaliereticino.ch';
const FROM_DEFAULT = OUTREACH_FROM_ADDRESS.includes('<')
  ? OUTREACH_FROM_ADDRESS
  : `Valerie · Frontaliere Ticino <${OUTREACH_FROM_ADDRESS}>`;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const n = process.argv[i + 1];
  return n && !n.startsWith('--') ? n : true;
}
const has = (name) => process.argv.includes(name);

function loadJson(p, def) { try { return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')); } catch { return def; } }

// ── Send log helpers ──────────────────────────────────────────

/**
 * Load the send log (local-only, gitignored). Returns empty object on missing/corrupt.
 * Structure: { [companyKey]: { touches: [{touch, sentAt, provider, messageId}], suppressed, suppressedReason } }
 */
function loadSendLog(logPath) {
  try {
    const raw = fs.readFileSync(path.resolve(logPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveSendLog(logPath, log) {
  const p = path.resolve(logPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(log, null, 2), 'utf8');
}

function isSuppressed(log, key) {
  return key ? !!(log[key]?.suppressed) : false;
}

function touchesSentForKey(log, key) {
  return key ? (log[key]?.touches || []) : [];
}

function alreadySentTouch(log, key, touchNum) {
  return touchesSentForKey(log, key).some((t) => t.touch === touchNum);
}

function cappedOut(log, key, maxTouches) {
  return touchesSentForKey(log, key).length >= maxTouches;
}

/** Human-readable log status for dry-run display. */
function logStatus(log, key, touchNum, maxTouches) {
  if (!key) return 'no key';
  if (isSuppressed(log, key)) return `⛔ suppressed: ${log[key].suppressedReason || '(no reason)'}`;
  const sent = touchesSentForKey(log, key);
  if (alreadySentTouch(log, key, touchNum)) {
    const entry = sent.find((t) => t.touch === touchNum);
    return `⚠ touch ${touchNum} già inviata ${entry?.sentAt ? `(${entry.sentAt.slice(0, 10)})` : ''}`;
  }
  if (cappedOut(log, key, maxTouches)) return `🚫 cap (${sent.length}/${maxTouches} touch)`;
  return sent.length === 0 ? '● nuovo' : `${sent.length} touch precedenti`;
}

/**
 * Read the Firestore-backed one-click suppression list written by the
 * outreachUnsubscribe Cloud Function (collection `employer_outreach_suppression`,
 * doc id = companyKey). Returns a Set of suppressed companyKeys.
 *
 * Best-effort: a missing service account or any Firestore error logs a warning
 * and returns an empty Set so the send falls back to local send-log suppression
 * only — it must never crash the send.
 */
async function loadFirestoreSuppression() {
  const suppressed = new Set();
  try {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      console.warn('↷ Firestore suppression: GOOGLE_APPLICATION_CREDENTIALS non impostato — uso solo send-log locale.');
      return suppressed;
    }
    const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (getApps().length === 0) {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      if (cred.project_id) {
        initializeApp({ credential: cert(cred) });
      } else {
        initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
      }
    }
    const db = getFirestore();
    const snap = await db.collection('employer_outreach_suppression').get();
    snap.forEach((doc) => {
      const key = (doc.data()?.companyKey || doc.id || '').trim();
      if (key) suppressed.add(key);
    });
    console.log(`🛡  Firestore suppression: ${suppressed.size} aziende disiscritte (one-click).`);
  } catch (err) {
    console.warn(`↷ Firestore suppression non disponibile (${err.message}) — uso solo send-log locale.`);
  }
  return suppressed;
}

/**
 * Read the Firestore-backed editable contacts written by the admin dashboard
 * (collection `employer_contacts`, doc id = companyKey, via the
 * adminEmployerInsights Cloud Function POST). Returns Map(companyKey → fields).
 *
 * Best-effort, same contract as loadFirestoreSuppression: missing SA / any error
 * → empty Map (falls back to the local contacts.json). Admin edits made in the
 * dashboard win over the local file so the recipient/personalization the admin
 * fixed there actually reaches the send (no parallel source of truth).
 */
async function loadFirestoreContacts() {
  const map = new Map();
  try {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      console.warn('↷ Firestore contacts: GOOGLE_APPLICATION_CREDENTIALS non impostato — uso solo contacts.json locale.');
      return map;
    }
    const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (getApps().length === 0) {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      if (cred.project_id) {
        initializeApp({ credential: cert(cred) });
      } else {
        initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
      }
    }
    const db = getFirestore();
    const snap = await db.collection('employer_contacts').get();
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const key = (d.companyKey || doc.id || '').trim();
      if (key) map.set(key, d);
    });
    console.log(`📇 Firestore contacts: ${map.size} contatti editati dal pannello admin.`);
  } catch (err) {
    console.warn(`↷ Firestore contacts non disponibile (${err.message}) — uso solo contacts.json locale.`);
  }
  return map;
}

/**
 * Merge admin-edited Firestore contacts over the local contacts.json: a non-empty
 * Firestore field (email / contactName / topRole) overrides the local one; a
 * cleared (empty) email from the dashboard also clears the local one. Mutates and
 * returns `contacts`.
 */
function mergeFirestoreContacts(contacts, fsContacts) {
  for (const [key, d] of fsContacts) {
    const prev = contacts[key] || {};
    const next = { ...prev };
    // email: a NON-EMPTY dashboard value wins. An empty value is "not set in the
    // dashboard" → must NOT clobber a valid email already in contacts.json (the
    // default case: employer_contacts is empty while the local file holds the
    // address). An intentional clear is gated behind an explicit `clearEmail`
    // flag the admin POST sets only when emptying a previously dashboard-set
    // address.
    if (d.email) next.email = String(d.email).trim();
    else if (d.clearEmail === true) next.email = '';
    if (d.emailInferred) next.emailInferred = String(d.emailInferred);
    if (d.contactName) next.contactName = String(d.contactName);
    if (d.topRole) next.topRole = String(d.topRole);
    contacts[key] = next;
  }
  return contacts;
}

/**
 * Best-effort mirror of a REAL send to Firestore so the admin dashboard
 * (adminEmployerInsights → AdminPanel "Insights Aziende") can show which touch
 * went out and when — the local send-log.json is gitignored and only lives on
 * this machine. Collection `employer_outreach_sends`, doc id = companyKey.
 *
 * Never throws: the send must never depend on this write succeeding. The
 * firebase-admin app is already initialized by loadFirestoreContacts/
 * loadFirestoreSuppression (both run before any real send), so we only grab the
 * existing app here; if it isn't up we silently skip.
 */
async function recordSendToFirestore(key, touchNum, subject, result) {
  if (!key) return;
  try {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) return;
    const { getApps } = await import('firebase-admin/app');
    if (getApps().length === 0) return; // app not initialized → nothing to mirror to
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const db = getFirestore();
    const sentAt = new Date().toISOString();
    await db.collection('employer_outreach_sends').doc(key).set({
      companyKey: key,
      lastTouch: touchNum,
      lastSentAt: sentAt,
      touches: FieldValue.arrayUnion({
        touch: touchNum,
        sentAt,
        provider: result?.provider || '',
        messageId: result?.messageId || '',
        subject: String(subject || '').slice(0, 200),
      }),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn(`↷ Firestore send-track non scritto per ${key} (${err.message}).`);
  }
}

// ─────────────────────────────────────────────────────────────

async function run() {
  const reportPath = arg('--report', path.join(ROOT, 'data/employer-outreach/report.json'));
  const contactsPath = arg('--contacts', path.join(ROOT, 'data/employer-outreach/contacts.json'));
  const logPath = arg('--log', path.join(ROOT, 'data/employer-outreach/send-log.json'));
  const touch = Number(arg('--touch', '1'));
  const top = Number(arg('--top', '5'));
  const maxTouches = Number(arg('--max-touches', '4'));
  const onlyCompany = arg('--company', '');
  const from = arg('--from', FROM_DEFAULT);
  const periodLabel = typeof arg('--days-label', 0) === 'string' ? arg('--days-label') : 'negli ultimi 3 mesi';

  const isTest = has('--test');
  const isSend = has('--send');
  const targetEmail = arg('--target-email', '');

  const report = loadJson(reportPath, null);
  if (!report || !Array.isArray(report.employers)) { console.error(`report illeggibile: ${reportPath}`); process.exit(1); }
  const contacts = loadJson(contactsPath, {});
  // Overlay admin-edited contacts (Firestore) on the local file so the recipient
  // / personalization fixed in the dashboard actually reaches dry-run, test and
  // real sends. Best-effort: no SA creds → no-op, local file is used as-is.
  mergeFirestoreContacts(contacts, await loadFirestoreContacts());
  const sendLog = loadSendLog(logPath);

  const topExplicit = process.argv.includes('--top');
  let targets = report.employers.slice(0, top);
  if (onlyCompany && onlyCompany !== true) targets = report.employers.filter((e) => (e.key || '') === onlyCompany);
  // Guard: a target without a usable candidate count would render "candidati: undefined".
  const skipped = targets.filter((e) => !Number.isFinite(e?.candidates) || e.candidates <= 0);
  if (skipped.length) console.warn(`↷ ${skipped.length} target senza candidati validi saltati: ${skipped.map((e) => e.name).join(', ').slice(0, 120)}`);
  targets = targets.filter((e) => Number.isFinite(e?.candidates) && e.candidates > 0);
  if (!targets.length) { console.error('nessun target valido (controlla --company / --report)'); process.exit(1); }
  // Safety: in --test/--send without an explicit --company or --top, don't fan
  // out to all `top` targets by surprise — limit to 1 (one preview / one send).
  if ((isTest || isSend) && !onlyCompany && !topExplicit && targets.length > 1) {
    console.warn(`⚠️  ${isTest ? 'test' : 'invio'} senza --company/--top: limito a 1 target (${targets[0].name}). Usa --top N per più.`);
    targets = targets.slice(0, 1);
  }

  // Costruisci i messaggi (touch richiesto) per ogni target.
  const messages = targets.map((e) => {
    const c = contacts[e.key] || contacts[e.name] || {};
    const seq = buildSequence({ company: e.name, candidates: e.candidates, periodLabel, contactName: c.contactName, topRole: c.topRole });
    const m = seq.find((x) => x.touch === touch) || seq[0];
    return { company: e.name, key: e.key, sector: c.sector || classifySector(e.name),
      realEmail: c.email || '', inferred: c.emailInferred || '', contactName: c.contactName || '',
      subject: m.subject, text: m.body, html: bodyToHtml(m.body) };
  });

  // ── DRY-RUN (default) ──
  if (!isTest && !isSend) {
    console.log('═══ DRY-RUN — nessun invio (usa --test --target-email <addr> per la prova) ═══\n');
    for (const m of messages) {
      const status = logStatus(sendLog, m.key, touch, maxTouches);
      console.log(`• ${m.company}  [${m.sector}]  → ${m.realEmail || m.inferred || '(nessuna email)'}${m.realEmail ? '' : ' (NON verificata)'}  [${status}]`);
      console.log(`  oggetto: ${m.subject}`);
      console.log(m.text.split('\n').map((l) => '    ' + l).join('\n'));
      console.log('');
    }
    console.log(`${messages.length} messaggi pronti (touch ${touch}, max-touches ${maxTouches}). Nessuno inviato.`);
    return;
  }

  if (isTest && (!targetEmail || targetEmail === true)) { console.error('--test richiede --target-email <addr>'); process.exit(2); }
  if (isSend && !has('--confirm')) { console.error('⛔ --send richiede anche --confirm (invio reale ai contatti). Annullato.'); process.exit(2); }

  // One-click suppression (Firestore, scritta dalla Cloud Function
  // outreachUnsubscribe). Si aggiunge — non sostituisce — alla suppression
  // locale del send-log. Best-effort: errori/SA mancante → Set vuoto, nessun crash.
  const firestoreSuppressed = (isSend) ? await loadFirestoreSuppression() : new Set();

  // Costruisci la coda per la cascade, applicando suppression/cap/dedup.
  const queue = [];
  for (const m of messages) {
    // Suppression/cap check applicato SOLO in invio reale (--send), non in --test.
    if (isSend && m.key) {
      if (firestoreSuppressed.has(m.key)) {
        console.warn(`↷ skip ${m.company}: disiscritto one-click (Firestore employer_outreach_suppression).`);
        continue;
      }
      if (isSuppressed(sendLog, m.key)) {
        console.warn(`↷ skip ${m.company}: in suppression list (${sendLog[m.key].suppressedReason || 'no reason'})`);
        continue;
      }
      if (cappedOut(sendLog, m.key, maxTouches)) {
        console.warn(`↷ skip ${m.company}: cap raggiunto (${touchesSentForKey(sendLog, m.key).length}/${maxTouches} touch)`);
        continue;
      }
      if (alreadySentTouch(sendLog, m.key, touch)) {
        const prev = touchesSentForKey(sendLog, m.key).find((t) => t.touch === touch);
        console.warn(`↷ skip ${m.company}: touch ${touch} già inviata il ${prev?.sentAt?.slice(0, 10) || '?'}`);
        continue;
      }
    }

    let to;
    if (isTest) {
      to = targetEmail; // override: solo a te stesso
    } else {
      to = m.realEmail; // invio reale: SOLO email verificate, mai inferite
      if (!to) { console.warn(`↷ skip ${m.company}: nessuna email verificata (inferita "${m.inferred}" non usata)`); continue; }
    }
    const subjectPrefix = isTest ? `[TEST → ${m.company}] ` : '';
    // One-click opt-out URL firmato (RFC 8058), per company key. Manca la chiave
    // (target legacy senza key) → URL generico alla home (buildUnsubUrl gestisce
    // anche secret mancante con fallback alla home). Sostituisce il placeholder
    // {{UNSUB_URL}} iniettato nel footer da generate-cold-emails.mjs.
    const unsubUrl = buildUnsubUrl(m.key || m.company);
    // Per-company stats "proof" page link ({{INSIGHTS_URL}}) — the primary CTA,
    // HMAC-gated (employerInsights CF). Same secret-missing→home fallback.
    const insightsUrl = buildInsightsUrl(m.key || m.company);
    const sub = (s) => String(s).split('{{UNSUB_URL}}').join(unsubUrl).split('{{INSIGHTS_URL}}').join(insightsUrl);
    const html = sub(m.html);
    const text = sub(m.text);
    // List-Unsubscribe (RFC 8058 + RFC 2369): HTTPS one-click PRIMA, mailto come
    // fallback. List-Unsubscribe-Post abilita il vero one-click (POST). Il
    // subject del mailto porta la company key così l'opt-out resta tracciabile.
    const unsubKey = encodeURIComponent(m.key || m.company);
    queue.push({
      payload: {
        from,
        to: [to],
        subject: subjectPrefix + m.subject,
        html,
        text,
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>, <mailto:${OPTOUT_EMAIL}?subject=unsubscribe%20${unsubKey}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        tags: [{ name: 'type', value: 'cold-outreach' }, { name: 'company', value: (m.key || m.company).slice(0, 40) }],
      },
      recipient: { email: to },
      // Metadati per il log (non usati dalla cascade, solo dall'onSent callback).
      _key: m.key,
      _touch: touch,
    });
  }
  if (!queue.length) { console.error('coda vuota — nessun destinatario valido.'); process.exit(1); }

  console.log(`${isTest ? '🧪 TEST' : '📨 INVIO REALE'}: ${queue.length} email${isTest ? ` → tutte a ${targetEmail}` : ''} (touch ${touch})\n`);

  // onSent: aggiorna il log dopo ogni invio reale. Non scrive in --test (email non vanno alle aziende reali).
  const onSent = isSend ? (item, result) => {
    const key = item._key;
    if (!key) return;
    if (!sendLog[key]) sendLog[key] = { touches: [], suppressed: false, suppressedReason: '' };
    sendLog[key].touches.push({
      touch: item._touch,
      sentAt: new Date().toISOString(),
      provider: result.provider,
      messageId: result.messageId,
    });
    saveSendLog(logPath, sendLog);
    // Mirror to Firestore (best-effort, non-blocking) so the admin dashboard
    // sees which touch went out and when. Failures stay local-only, never abort.
    void recordSendToFirestore(key, item._touch, item.subject, result);
  } : undefined;

  import('./lib/email-cascade.mjs').then(async ({ sendEmailCascade, logProviderSummary }) => {
    const { sent, failed } = await sendEmailCascade(queue, { concurrency: 1, delayMs: 1200, onSent });
    console.log(`\n✅ inviate ${sent.length}, ❌ fallite ${failed.length}`);
    if (isSend && sent.length > 0) console.log(`   Log aggiornato: ${path.relative(ROOT, path.resolve(logPath))}`);
    logProviderSummary();
    if (failed.length) process.exitCode = 1; // segnala invii falliti al chiamante
  }).catch((err) => {
    // Senza questo, un reject (es. syncQuotasFromAPIs) resterebbe unhandled e
    // l'exit 0 farebbe sembrare riuscito un invio non avvenuto.
    console.error(`\n❌ invio non riuscito: ${err?.message || err}`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((err) => { console.error(err); process.exitCode = 1; });
}
