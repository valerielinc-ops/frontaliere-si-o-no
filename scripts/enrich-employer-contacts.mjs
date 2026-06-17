#!/usr/bin/env node
/**
 * Enrichment contatti HR per l'outreach (passo #1 del piano).
 *
 * Per ogni azienda target del report candidati-per-azienda:
 *   1) trova il RUOLO più cliccato (PostHog) → personalizzazione Livello 4 email;
 *   2) prova a estrarre un'email di contatto HR dalle pagine careers/contatti
 *      (best-effort, public pages) con priorità hr@/lavoro@/candidature@/jobs@.
 * Scrive/aggiorna `data/employer-outreach/contacts.json` (untracked, gitignored)
 * SENZA sovrascrivere le email inserite a mano.
 *
 * NON invia nulla. Solo arricchimento dati locali.
 *
 * Nessuna azienda esclusa: prende le prime `--top` per candidati inviati. Ogni
 * contatto è etichettato col settore (pubblico/multinazionale/pmi) come contesto
 * per calibrare il messaggio a mano, ma il tag NON filtra.
 *
 * Uso:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/load-rc-env.mjs)"
 *   node scripts/enrich-employer-contacts.mjs --report data/employer-outreach/report.json --top 15
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySector, slugify } from './lib/employer-sectors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const n = process.argv[i + 1];
  return n && !n.startsWith('--') ? n : true;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_BAD = /(noreply|no-reply|example|sentry|wixpress|\.png|\.jpg|\.webp|@2x|domain\.|email\.com|yourcompany)/i;
const EMAIL_PRIORITY = [/^(hr|risorseumane|risorse-umane|lavoro|lavora|candidature|recruiting|recruitment|jobs|career|personal)/i, /^(info|contact|contatto|amministrazione|segreteria)/i];

async function fetchText(url, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; frontaliereticino-enrichment/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return '';
    return (await r.text()).slice(0, 500_000);
  } catch { return ''; }
}

function pickEmail(emails) {
  const clean = [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => !EMAIL_BAD.test(e));
  for (const re of EMAIL_PRIORITY) { const hit = clean.find((e) => re.test(e.split('@')[0])); if (hit) return hit; }
  return clean[0] || null;
}

async function findEmail(careersUrl, website) {
  const bases = [careersUrl, website].filter(Boolean);
  const paths = ['', '/contatti', '/contatti/', '/contact', '/contact/', '/chi-siamo', '/lavora-con-noi', '/lavora-con-noi/', '/jobs', '/careers'];
  const seen = new Set();
  const found = [];
  for (const base of bases) {
    let origin = '';
    try { origin = new URL(base).origin; } catch { continue; }
    const urls = [base, ...paths.map((p) => origin + p)];
    for (const u of urls) {
      if (seen.has(u) || found.length > 12) continue;
      seen.add(u);
      const html = await fetchText(u);
      if (!html) continue;
      const m = html.match(EMAIL_RE);
      if (m) found.push(...m);
      const pick = pickEmail(found);
      if (pick && EMAIL_PRIORITY[0].test(pick.split('@')[0])) return pick; // strong match → stop early
    }
  }
  return pickEmail(found);
}

async function topRoles(targets, days) {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY, projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  if (!apiKey || !projectId) return new Map();
  const q = `
    SELECT splitByChar('_', coalesce(toString(properties.item_id),''))[1] AS company,
           arrayStringConcat(arraySlice(splitByChar('_', coalesce(toString(properties.item_id),'')), 2), '_') AS role,
           count() AS c
    FROM events
    WHERE event='select_content'
      AND properties.content_type IN ('job_board_apply','job_board_apply_header_logo','job_board_apply_header_title')
      AND timestamp >= now() - interval ${days} day
    GROUP BY company, role ORDER BY c DESC LIMIT 2000`.trim();
  const r = await fetch(`${host}/api/projects/${projectId}/query/`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }) });
  if (!r.ok) return new Map();
  const out = new Map();
  for (const [company, role, c] of ((await r.json()).results || [])) {
    const key = slugify(company);
    if (!out.has(key) && role) out.set(key, { role, clicks: Number(c) || 0 }); // first = top (ordered desc)
  }
  return out;
}

async function run() {
  const reportPath = arg('--report', path.join(ROOT, 'data/employer-outreach/report.json'));
  const top = Number(arg('--top', '15'));
  const days = Number(arg('--days', '90'));
  const contactsPath = path.join(ROOT, 'data/employer-outreach/contacts.json');

  const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8'));
  // Nessuna azienda esclusa: prendi le prime `top` per candidati inviati.
  const targets = (report.employers || []).slice(0, top);

  const existing = fs.existsSync(contactsPath) ? JSON.parse(fs.readFileSync(contactsPath, 'utf8')) : {};
  const roles = await topRoles(targets, days);

  console.log(`Enrichment: ${targets.length} aziende target (nessuna esclusa)\n`);
  for (const e of targets) {
    const key = e.key || slugify(e.name);
    const prev = existing[key] || {};
    const role = roles.get(key)?.role || prev.topRole || '';
    const sector = classifySector(e.name);
    let email = prev.email || null; // never overwrite manual email
    if (!email) email = await findEmail(e.careersUrl, prev.website);
    existing[key] = { name: e.name, candidates: e.candidates, sector, topRole: role, careersUrl: e.careersUrl || prev.careersUrl || '', website: prev.website || '', contactName: prev.contactName || '', email: email || '' };
    console.log(`  ${e.candidates.toString().padStart(3)}  [${sector.padEnd(13)}]  ${email ? '✓ ' + email : '⚠ no email'}  ${e.name}${role ? `  · ruolo top: ${role.slice(0, 46)}` : ''}`);
  }

  fs.mkdirSync(path.dirname(contactsPath), { recursive: true });
  fs.writeFileSync(contactsPath, JSON.stringify(existing, null, 2));
  const withEmail = Object.values(existing).filter((c) => c.email).length;
  console.log(`\n${Object.keys(existing).length} contatti in contacts.json (${withEmail} con email). Email mancanti: completale a mano (LinkedIn / form).`);
  console.log('Nessun invio. Prossimo: node scripts/generate-cold-emails.mjs --report <report.json>');
}

run().catch((e) => { console.error(e.message || e); process.exit(1); });
