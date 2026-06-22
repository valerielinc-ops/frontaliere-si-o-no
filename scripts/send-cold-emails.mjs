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
import { classifySector } from './lib/employer-sectors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FROM_DEFAULT = 'Valerie · Frontaliere Ticino <valerie@frontaliereticino.ch>';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const n = process.argv[i + 1];
  return n && !n.startsWith('--') ? n : true;
}
const has = (name) => process.argv.includes(name);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Cold email = aspetto plain. HTML minimale: paragrafi, niente immagini/CTA grafiche. */
function bodyToHtml(body) {
  const paras = body.trim().split(/\n\n+/).map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${paras.join('')}</div>`;
}

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

// ─────────────────────────────────────────────────────────────

function run() {
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

  // Costruisci la coda per la cascade, applicando suppression/cap/dedup.
  const queue = [];
  for (const m of messages) {
    // Suppression/cap check applicato SOLO in invio reale (--send), non in --test.
    if (isSend && m.key) {
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
    // List-Unsubscribe (RFC 2369): abilita il pulsante "Annulla iscrizione" nativo
    // di Gmail/Outlook. Solo mailto (niente One-Click: nessun endpoint HTTPS); il
    // subject porta la company key così l'opt-out è tracciabile alla sorgente.
    const unsubKey = encodeURIComponent(m.key || m.company);
    queue.push({
      payload: {
        from,
        to: [to],
        subject: subjectPrefix + m.subject,
        html: m.html,
        text: m.text,
        headers: { 'List-Unsubscribe': `<mailto:${OPTOUT_EMAIL}?subject=unsubscribe%20${unsubKey}>` },
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
