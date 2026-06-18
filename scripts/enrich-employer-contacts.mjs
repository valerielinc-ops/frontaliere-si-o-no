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
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { classifySector, slugify } from './lib/employer-sectors.mjs';
import { apexDomain, extractCompanyEmails, pickBestEmail, inferPatternEmail } from './lib/email-finder.mjs';
import { extractDdgDomains, guessDomains, rankDomains } from './lib/domain-finder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const n = process.argv[i + 1];
  return n && !n.startsWith('--') ? n : true;
}

// Third-party ATS / job-board domains: a careers/website URL pointing here is
// NOT the employer's own domain, so its apex would be wrong (e.g. emailing
// ncoreplat.com). Skip email-scraping when the resolved apex is one of these.
const ATS_DOMAINS = new Set([
  'lever.co', 'greenhouse.io', 'myworkdayjobs.com', 'workday.com', 'smartrecruiters.com',
  'personio.de', 'personio.com', 'recruitee.com', 'ncoreplat.com', 'ostendis.com',
  'refline.ch', 'prospective.ch', 'jobs.ch', 'jobscout24.ch', 'indeed.com',
  'jobcloud.ch', 'softgarden.io', 'teamtailor.com', 'workable.com', 'bamboohr.com',
  'orior.ch', 'oraclecloud.com', 'taleo.net', 'successfactors.com', 'eu.greenhouse.io',
]);

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

async function mxOk(domain) {
  try { const mx = await dns.resolveMx(domain); return Array.isArray(mx) && mx.length > 0; } catch { return false; }
}

// Find the employer's own domain when the registry lacks it: web search +
// heuristic guesses, validated by MX + a name-token match (rejects directories).
let _lastDdg = 0;
async function findDomain(name) {
  const wait = 2500 - (Date.now() - _lastDdg); // space DDG calls (avoid throttling)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastDdg = Date.now();
  let candidates = [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(name + ' sito ufficiale'),
      { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'it' } });
    clearTimeout(t);
    if (r.ok) candidates = extractDdgDomains(await r.text());
  } catch { /* search unavailable → fall back to guesses */ }
  candidates.push(...guessDomains(name));
  const valid = [];
  for (const d of [...new Set(candidates)]) { if (!ATS_DOMAINS.has(d) && await mxOk(d)) valid.push(d); if (valid.length >= 6) break; }
  return rankDomains(valid, name)[0] || '';
}

/**
 * Deep-scrape the employer's OWN domain (contact/impressum/careers pages) and
 * return the on-domain emails found (third-party noise dropped by the domain
 * filter in email-finder). Returns [] for unknown/ATS domains.
 */
async function scrapeCompanyEmails(domain) {
  if (!domain || ATS_DOMAINS.has(domain)) return [];
  const paths = ['', '/contatti', '/contatti/', '/it/contatti', '/contact', '/contact/', '/kontakt', '/impressum', '/chi-siamo', '/lavora-con-noi', '/lavora-con-noi/', '/jobs', '/careers', '/azienda/contatti'];
  const origins = [`https://www.${domain}`, `https://${domain}`];
  const found = new Set();
  for (const origin of origins) {
    for (const p of paths) {
      const html = await fetchText(origin + p);
      if (!html) continue;
      for (const e of extractCompanyEmails(html, domain)) found.add(e);
      if (found.size >= 8) return [...found];
    }
    if (found.size) break;
  }
  return [...found];
}

/** Registry: company key → own website domain (apex), excluding ATS hosts. */
function loadRegistryDomains() {
  const out = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/crawler-companies-auto.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.companies) ? raw.companies : Object.values(raw);
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const key = slugify(c.key || c.name);
      const apex = apexDomain(c.website || c.careersUrl || '');
      if (key && apex && !ATS_DOMAINS.has(apex)) out.set(key, apex);
    }
  } catch { /* registry optional */ }
  return out;
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
  const registryDomains = loadRegistryDomains();

  console.log(`Enrichment: ${targets.length} aziende target (nessuna esclusa)\n`);
  for (const e of targets) {
    const key = e.key || slugify(e.name);
    const prev = existing[key] || {};
    const role = roles.get(key)?.role || prev.topRole || '';
    const sector = classifySector(e.name);
    // Domain: registry website (own domain, ATS-filtered) → fallback apex(careersUrl)
    // → web-search discovery (domain-finder) when still unknown.
    const careersApex = apexDomain(e.careersUrl || prev.careersUrl || '');
    let domain = registryDomains.get(key) || prev.domain || (ATS_DOMAINS.has(careersApex) ? '' : careersApex);
    if (!domain) domain = await findDomain(e.name);

    // Never overwrite a manually-set email. Otherwise scrape the own domain.
    let email = prev.email || '';
    let emailSource = prev.email ? (prev.emailSource || 'manual') : '';
    let emailInferred = prev.emailInferred || '';
    let mx = false;
    if (domain) {
      mx = await mxOk(domain);
      if (!email) {
        const found = await scrapeCompanyEmails(domain);
        const best = pickBestEmail(found);
        if (best) { email = best; emailSource = 'scraped'; }
        // Personal-email guess for the named LinkedIn contact (pattern-learned).
        if (prev.contactName && !emailInferred) {
          emailInferred = inferPatternEmail(found, prev.contactName, domain) || '';
        }
      }
    }
    existing[key] = {
      name: e.name, candidates: e.candidates, sector, topRole: role,
      careersUrl: e.careersUrl || prev.careersUrl || '', domain,
      contactName: prev.contactName || '', contactRole: prev.contactRole || '', linkedinUrl: prev.linkedinUrl || '',
      email, emailSource, emailInferred, mxVerified: mx,
    };
    const tag = email ? `✓ ${email} (${emailSource}${mx ? ', mx✓' : ''})` : (emailInferred ? `~ ${emailInferred} (inferita)` : (domain ? '⚠ no email' : '⚠ no domain'));
    console.log(`  ${e.candidates.toString().padStart(3)}  [${sector.padEnd(13)}]  ${tag}  ${e.name}`);
  }

  fs.mkdirSync(path.dirname(contactsPath), { recursive: true });
  fs.writeFileSync(contactsPath, JSON.stringify(existing, null, 2));
  const withEmail = Object.values(existing).filter((c) => c.email).length;
  const withInferred = Object.values(existing).filter((c) => !c.email && c.emailInferred).length;
  console.log(`\n${Object.keys(existing).length} contatti (${withEmail} email verificate da sito, ${withInferred} solo inferite). Le mancanti: completale a mano (LinkedIn DM / form).`);
  console.log('Nessun invio. Prossimo: node scripts/generate-cold-emails.mjs --report <report.json>');
}

run().catch((e) => { console.error(e.message || e); process.exit(1); });
