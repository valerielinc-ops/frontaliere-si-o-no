#!/usr/bin/env node
/**
 * Employer traffic report — "candidati inviati per azienda".
 *
 * Conta gli eventi GA4 `job_apply` (click "Candidati" sugli annunci) raggruppati
 * per `employer_key`, distinguendo annunci sponsorizzati da quelli crawlati
 * (`is_sponsored`). È il dato che alimenta sia la prova in-prodotto sia
 * l'outreach commerciale ("vi abbiamo mandato N candidati il mese scorso, gratis").
 *
 * I parametri `employer_key` / `is_sponsored` sono custom dimension GA4 registrate
 * (event-scope). NB: le custom dimension NON sono retroattive → il report copre
 * solo i click avvenuti dopo il deploy di `trackJobApply` + la registrazione.
 *
 * Auth: stessa Firebase SA usata da scripts/lib/evidence/ga4Fetcher.mjs.
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/load-rc-env.mjs)"
 *   node scripts/employer-traffic-report.mjs --days 30
 *
 * Flags:
 *   --days N     finestra in giorni (default 30)
 *   --min N      soglia minima di click per comparire (default 1)
 *   --json PATH  scrive il report completo come JSON (default: solo stdout)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function getToken() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('no service-account credentials (set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON)');
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const tmp = path.join(os.tmpdir(), `firebase-sa-${process.pid}.json`);
    fs.writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
  }
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
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
  } catch { /* registry optional — report still works with raw keys */ }
  return out;
}

async function run() {
  const days = Number(arg('--days', '30'));
  const min = Number(arg('--min', '1'));
  const jsonPath = arg('--json', '');

  const prop = process.env.GA4_PROPERTY_ID;
  if (!prop) { console.error('NO GA4_PROPERTY_ID (load via scripts/load-rc-env.mjs)'); process.exit(2); }
  const property = prop.startsWith('properties/') ? prop : `properties/${prop}`;
  const token = await getToken();

  const body = {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'customEvent:employer_key' }, { name: 'customEvent:is_sponsored' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'job_apply' } } },
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 1000,
  };
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) { console.error('GA4 error:', JSON.stringify(j.error).slice(0, 400)); process.exit(1); }

  const companies = loadCompanies();
  const byEmployer = new Map();
  for (const row of (j.rows || [])) {
    const key = row.dimensionValues[0].value;
    const sponsored = row.dimensionValues[1].value === 'sponsored';
    const count = Number(row.metricValues[0].value) || 0;
    const e = byEmployer.get(key) || { key, free: 0, sponsored: 0 };
    if (sponsored) e.sponsored += count; else e.free += count;
    byEmployer.set(key, e);
  }

  const rows = [...byEmployer.values()]
    .map(e => {
      const meta = companies.get(e.key) || {};
      return { ...e, total: e.free + e.sponsored, name: meta.name || e.key, careersUrl: meta.careersUrl || '' };
    })
    .filter(e => e.total >= min)
    .sort((a, b) => b.total - a.total);

  const totalFree = rows.reduce((s, e) => s + e.free, 0);
  const totalSpon = rows.reduce((s, e) => s + e.sponsored, 0);

  console.log(`\n📊 Candidati inviati per azienda — ultimi ${days} giorni (property ${property})`);
  console.log(`   ${rows.length} aziende · ${totalFree} click free · ${totalSpon} click sponsorizzati\n`);
  console.log('  #  TOT   FREE  SPON  AZIENDA');
  rows.forEach((e, i) => {
    console.log(
      `${String(i + 1).padStart(3)}  ${String(e.total).padStart(4)}  ${String(e.free).padStart(4)}  ${String(e.sponsored).padStart(4)}  ${e.name}${e.careersUrl ? '  ' + e.careersUrl : ''}`,
    );
  });
  if (!rows.length) {
    console.log('  (nessun evento job_apply — atteso finché il deploy di trackJobApply non accumula dati; le custom dimension non sono retroattive)');
  }

  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify({ generatedDays: days, property, totals: { free: totalFree, sponsored: totalSpon }, employers: rows }, null, 2));
    console.log(`\n💾 JSON → ${jsonPath}`);
  }
}

run().catch(e => { console.error(e.message || e); process.exit(1); });
