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
 * Esempi:
 *   # prova in casella (sanzionato): manda la touch-1 di Casale a te stesso
 *   node scripts/send-cold-emails.mjs --test --target-email valerielinc@gmail.com \
 *     --report data/employer-outreach/report.json --company casale-sa --touch 1
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSequence } from './generate-cold-emails.mjs';
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

function run() {
  const reportPath = arg('--report', path.join(ROOT, 'data/employer-outreach/report.json'));
  const contactsPath = arg('--contacts', path.join(ROOT, 'data/employer-outreach/contacts.json'));
  const touch = Number(arg('--touch', '1'));
  const top = Number(arg('--top', '5'));
  const onlyCompany = arg('--company', '');
  const from = arg('--from', FROM_DEFAULT);
  const periodLabel = typeof arg('--days-label', 0) === 'string' ? arg('--days-label') : 'negli ultimi 3 mesi';

  const isTest = has('--test');
  const isSend = has('--send');
  const targetEmail = arg('--target-email', '');

  const report = loadJson(reportPath, null);
  if (!report || !Array.isArray(report.employers)) { console.error(`report illeggibile: ${reportPath}`); process.exit(1); }
  const contacts = loadJson(contactsPath, {});

  let targets = report.employers.slice(0, top);
  if (onlyCompany && onlyCompany !== true) targets = report.employers.filter((e) => (e.key || '') === onlyCompany);
  if (!targets.length) { console.error('nessun target (controlla --company / --report)'); process.exit(1); }

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
      console.log(`• ${m.company}  [${m.sector}]  → ${m.realEmail || m.inferred || '(nessuna email)'}${m.realEmail ? '' : ' (NON verificata)'}`);
      console.log(`  oggetto: ${m.subject}`);
      console.log(m.text.split('\n').map((l) => '    ' + l).join('\n'));
      console.log('');
    }
    console.log(`${messages.length} messaggi pronti (touch ${touch}). Nessuno inviato.`);
    return;
  }

  if (isTest && (!targetEmail || targetEmail === true)) { console.error('--test richiede --target-email <addr>'); process.exit(2); }
  if (isSend && !has('--confirm')) { console.error('⛔ --send richiede anche --confirm (invio reale ai contatti). Annullato.'); process.exit(2); }

  // Costruisci la coda per la cascade.
  const queue = [];
  for (const m of messages) {
    let to;
    if (isTest) {
      to = targetEmail; // override: solo a te stesso
    } else {
      to = m.realEmail; // invio reale: SOLO email verificate, mai inferite
      if (!to) { console.warn(`↷ skip ${m.company}: nessuna email verificata (inferita "${m.inferred}" non usata)`); continue; }
    }
    const subjectPrefix = isTest ? `[TEST → ${m.company}] ` : '';
    queue.push({
      payload: {
        from,
        to: [to],
        subject: subjectPrefix + m.subject,
        html: m.html,
        text: m.text,
        tags: [{ name: 'type', value: 'cold-outreach' }, { name: 'company', value: (m.key || m.company).slice(0, 40) }],
      },
      recipient: { email: to },
    });
  }
  if (!queue.length) { console.error('coda vuota — nessun destinatario valido.'); process.exit(1); }

  console.log(`${isTest ? '🧪 TEST' : '📨 INVIO REALE'}: ${queue.length} email${isTest ? ` → tutte a ${targetEmail}` : ''} (touch ${touch})\n`);
  import('./lib/email-cascade.mjs').then(async ({ sendEmailCascade, logProviderSummary }) => {
    const { sent, failed } = await sendEmailCascade(queue, { concurrency: 1, delayMs: 1200 });
    console.log(`\n✅ inviate ${sent.length}, ❌ fallite ${failed.length}`);
    logProviderSummary();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
