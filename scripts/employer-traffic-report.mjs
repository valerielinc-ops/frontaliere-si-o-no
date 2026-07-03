#!/usr/bin/env node
/**
 * Employer traffic report — "candidati inviati per azienda".
 *
 * Conta i candidati che mandiamo (gratis) verso il sito di ogni azienda, cioè
 * i click "Candidati" sugli annunci SOLO gratuiti — lo sponsorizzato arriva
 * già diretto al datore (copy box dashboard), va escluso dalla pitch.
 * È il dato che alimenta sia la prova in-prodotto sia l'outreach commerciale
 * ("vi abbiamo mandato N candidati il mese scorso, gratis").
 *
 * DUE SORGENTI (i touchpoint emettono entrambi gli eventi via analytics.ts):
 *
 *   --source ga4  (PRODUZIONE, cron employer-traffic-refresh.yml) — interroga
 *       l'evento pulito `job_apply` (employer_key + is_sponsored, custom
 *       dimension registrate). Unica sorgente che sa DAVVERO distinguere
 *       sponsorizzato da gratuito (aggregateGa4Rows esclude sponsored dal
 *       conteggio) — niente stima, split esatto. Solo dati POST-deploy (le
 *       custom dimension GA4 non sono retroattive).
 *
 *   --source posthog  (DEFAULT CLI, solo backfill manuale/storico) —
 *       interroga lo STORICO via HogQL su PostHog. Aggrega `select_content`
 *       con content_type IN (job_board_apply, job_board_apply_header_logo,
 *       job_board_apply_header_title). Azienda estratta dalla label
 *       `item_id = "<company>_<title>"`, che NON porta il flag sponsored →
 *       impossibile escluderlo, il numero include sponsorizzato+gratuito
 *       insieme (mai usarlo per il cron di produzione: gonfia la pitch "free"
 *       e la quota API PostHog non è affidabile per un cron giornaliero).
 *       Vantaggio: dati RETROATTIVI, niente custom dimension richieste.
 *
 * Metrica per la pitch (`candidates`) = MIN(persone distinte, sessioni distinte),
 * non i click grezzi: un candidato che clicca logo+titolo+bottone è UNA persona,
 * non tre. Si usa il MINIMO perché `person_id` può GONFIARE per il traffico
 * anonimo (reset cookie / cross-device / identity-merge non configurata) → la
 * pitch ("vi abbiamo mandato N candidati") non deve mai sovrastimare (#2384).
 * Il report mostra anche persone e sessioni separate + il rapporto P/S come
 * segnale di stabilità (P/S ~1.0 = stabile; >>1 = person_id frammentato).
 *
 * Auth: stessa Firebase SA / PostHog key caricate da scripts/load-rc-env.mjs:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/load-rc-env.mjs)"
 *   node scripts/employer-traffic-report.mjs --days 90
 *
 * Flags:
 *   --source posthog|ga4   sorgente dati (default posthog)
 *   --days N               finestra in giorni (default 90)
 *   --min N                soglia minima candidati per comparire (default 1)
 *   --json PATH            scrive il report completo come JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** Slug normalizer (loose match to canonicalCompanyRouteSlug for display join). */
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Load crawled-employer registry for display name + careers URL enrichment. */
function loadCompanies() {
  const out = new Map();
  const file = path.join(__dirname, '..', 'data', 'crawler-companies-auto.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.companies) ? raw.companies : Object.values(raw);
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const key = slugify(c.key || c.name);
      if (key) out.set(key, { name: c.name || c.key, careersUrl: c.careersUrl || c.website || '' });
    }
  } catch { /* registry optional */ }
  return out;
}

// ───────────────────────── PostHog (HogQL, historical) ─────────────────────────
async function fromPostHog(days) {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  if (!apiKey || !projectId) throw new Error('no POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID');
  // Conta DUE metriche di unicità (#2384): persone distinte e SESSIONI distinte.
  // Per il traffico anonimo `person_id` può essere INSTABILE (reset cookie,
  // cross-device, identity-merge non configurata) → tende a GONFIARE il conteggio
  // persone rispetto agli umani reali. `$session_id` è il floor per-sessione
  // (≥ persone reali, ≤ persone gonfiate). Il numero usato nella pitch
  // (`candidates`) è il MINIMO dei due → mai sovrastima il claim "vi abbiamo
  // mandato N candidati". Il report mostra entrambi + il rapporto come segnale.
  const query = `
    SELECT splitByChar('_', coalesce(toString(properties.item_id), ''))[1] AS company,
           count(DISTINCT person_id) AS persons,
           count(DISTINCT properties.$session_id) AS sessions,
           count() AS clicks
    FROM events
    WHERE event = 'select_content'
      AND properties.content_type IN ('job_board_apply','job_board_apply_header_logo','job_board_apply_header_title')
      AND coalesce(toString(properties.item_id), '') != ''
      AND timestamp >= now() - interval ${days} day
    GROUP BY company
    ORDER BY persons DESC
    LIMIT 1000`.trim();
  const r = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`posthog ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = (await r.json()).results || [];
  // PostHog non distingue sponsored vs free dalla label item_id → sponsored=0.
  return rows.map(([company, persons, sessions, clicks]) => {
    const p = Number(persons) || 0;
    const s = Number(sessions) || 0;
    // Numero per la pitch = conservativo (min). Se 0 sessioni (proprietà assente
    // su eventi vecchi), ricade su persone per non azzerare il report.
    const candidates = s > 0 ? Math.min(p, s) : p;
    return {
      key: slugify(company), displayFromData: company,
      candidates, persons: p, sessions: s,
      clicks: Number(clicks) || 0, sponsored: 0,
    };
  });
}

// ───────────────────────── GA4 (job_apply, post-deploy) ─────────────────────────
async function fromGa4(days) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const tmp = path.join(os.tmpdir(), `firebase-sa-${process.pid}.json`);
    fs.writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
  }
  const prop = process.env.GA4_PROPERTY_ID;
  if (!prop) throw new Error('no GA4_PROPERTY_ID');
  const property = prop.startsWith('properties/') ? prop : `properties/${prop}`;
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
  const { token } = await (await auth.getClient()).getAccessToken();
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
      dimensions: [{ name: 'customEvent:employer_key' }, { name: 'customEvent:is_sponsored' }],
      metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'job_apply' } } },
      orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
      limit: 1000,
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`GA4: ${JSON.stringify(j.error).slice(0, 200)}`);
  return aggregateGa4Rows(j.rows || []);
}

/**
 * Pure aggregator GA4 rows → per-employer conteggi (unit-testable, no fetch).
 * La pitch "candidati inviati dagli annunci gratuiti" DEVE escludere lo
 * sponsorizzato (con sponsorizzato le candidature arrivano già diretto al
 * datore, copy box dashboard) — persons/sessions/clicks qui sono free-only,
 * lo sponsored va solo nel campo `sponsored` (non sommato al resto).
 */
export function aggregateGa4Rows(rows) {
  const byKey = new Map();
  for (const row of (rows || [])) {
    const key = row.dimensionValues[0].value;
    const sponsored = row.dimensionValues[1].value === 'sponsored';
    const users = Number(row.metricValues[0].value) || 0;
    const sessions = Number(row.metricValues[1].value) || 0;
    const clicks = Number(row.metricValues[2].value) || 0;
    const e = byKey.get(key) || { key, persons: 0, sessions: 0, clicks: 0, sponsored: 0 };
    if (sponsored) {
      e.sponsored += users;
    } else {
      e.persons += users; e.sessions += sessions; e.clicks += clicks;
    }
    byKey.set(key, e);
  }
  // Stesso numero conservativo del path PostHog (#2384): pitch = min(persone, sessioni).
  return [...byKey.values()].map(e => ({
    ...e, candidates: e.sessions > 0 ? Math.min(e.persons, e.sessions) : e.persons,
  }));
}

async function run() {
  const source = arg('--source', 'posthog');
  const days = Number(arg('--days', '90'));
  const min = Number(arg('--min', '1'));
  const jsonPath = arg('--json', '');

  const raw = source === 'ga4' ? await fromGa4(days) : await fromPostHog(days);
  const companies = loadCompanies();
  const rows = raw
    .map(e => {
      const meta = companies.get(e.key) || {};
      return { ...e, name: e.displayFromData || meta.name || e.key, careersUrl: meta.careersUrl || '' };
    })
    .filter(e => e.candidates >= min)
    .sort((a, b) => b.candidates - a.candidates);

  const totCand = rows.reduce((s, e) => s + e.candidates, 0);
  const totPers = rows.reduce((s, e) => s + (e.persons || 0), 0);
  const totSess = rows.reduce((s, e) => s + (e.sessions || 0), 0);
  const totClick = rows.reduce((s, e) => s + e.clicks, 0);
  // Rapporto persone/sessioni: ~1.0 = stabile; >>1 = person_id frammentato
  // (cookie reset / anonimo) → il conteggio persone gonfia. Segnale per l'owner.
  const ratio = totSess > 0 ? (totPers / totSess) : 0;

  console.log(`\n📊 Candidati inviati per azienda — sorgente ${source}, ultimi ${days} giorni`);
  console.log(`   ${rows.length} aziende · ${totCand} candidati (pitch, conservativo) · ${totClick} click totali`);
  console.log(`   persone distinte: ${totPers} · sessioni distinte: ${totSess}${ratio ? ` · rapporto P/S: ${ratio.toFixed(2)}` : ''}`);
  if (ratio > 1.3) {
    console.log(`   ⚠️  person_id sembra instabile (P/S ${ratio.toFixed(2)} > 1.3): il conteggio PERSONE è gonfiato`);
    console.log(`       per il traffico anonimo. La pitch usa già il MINIMO (sessioni) — non sovrastima.`);
  }
  console.log(`   ℹ️  "candidati" nella pitch = min(persone, sessioni): mai sovrastima il claim.\n`);
  console.log('  #  CAND  PERS  SESS  CLICK  AZIENDA');
  rows.forEach((e, i) => {
    console.log(`${String(i + 1).padStart(3)}  ${String(e.candidates).padStart(4)}  ${String(e.persons ?? '').padStart(4)}  ${String(e.sessions ?? '').padStart(4)}  ${String(e.clicks).padStart(5)}  ${e.name}${e.careersUrl ? '  ' + e.careersUrl : ''}`);
  });
  if (!rows.length) console.log('  (nessun dato per questa sorgente/finestra)');

  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify({
      source, days,
      // Disclaimer machine-readable per i consumer a valle (generate-cold-emails).
      candidatesMetric: 'min(distinct_persons, distinct_sessions)',
      identityNote: 'candidates è conservativo: min(persone, sessioni). person_id può gonfiare per traffico anonimo (reset cookie / cross-device); usare il numero così com\'è nella pitch non sovrastima.',
      totals: { candidates: totCand, persons: totPers, sessions: totSess, clicks: totClick, personsToSessionsRatio: Number(ratio.toFixed(3)) },
      employers: rows,
    }, null, 2));
    console.log(`\n💾 JSON → ${jsonPath}`);
  }
}

// Esegui solo se invocato direttamente (aggregateGa4Rows resta importabile per i test).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch(e => { console.error(e.message || e); process.exit(1); });
}
