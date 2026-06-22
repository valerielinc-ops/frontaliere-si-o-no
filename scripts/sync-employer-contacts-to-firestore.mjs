#!/usr/bin/env node
/**
 * sync-employer-contacts-to-firestore.mjs — fill the admin "Insights Aziende"
 * dashboard contact column.
 *
 * The dashboard (CF `adminEmployerInsights`) reads the per-company outreach
 * email from Firestore `employer_contacts/{companyKey}`. That collection starts
 * EMPTY, so every row shows "contatto mancante". The local enrichment
 * (`enrich-employer-contacts.mjs`) only ever wrote `contacts.json` (gitignored,
 * invisible to the GET) — nothing bridged the discovered emails INTO Firestore.
 * This script closes that gap: it discovers an HR/contact email per company and
 * upserts it to `employer_contacts/{companyKey}` so the dashboard fills in.
 *
 * Company universe = the `employer_insights` docs (exactly what the dashboard
 * lists). Domain resolution, in priority order, all open-data / best-effort:
 *   1. jobs.json `companyDomain` (the employer's own domain, non-ATS) — same
 *      `companyKey` as insights, so it joins directly;
 *   2. `data/crawler-companies-auto.json` registry (by key, then by name-slug);
 *   3. web-search discovery (`findDomain`: DDG + guesses, MX + name-token gated).
 * Then scrape the own-domain contact/impressum/careers pages for on-domain
 * emails and pick the best HR target (`email-finder` scoring). MX-validated.
 *
 * Never clobbers a contact that already has an email (admin-edited) unless
 * `--force`. Never deletes. Idempotent: re-runs only fill the still-missing ones.
 *
 * Usage:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=<sa> node scripts/load-rc-env.mjs)"   # optional (no secrets needed)
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa> node scripts/sync-employer-contacts-to-firestore.mjs            # dry-run
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa> node scripts/sync-employer-contacts-to-firestore.mjs --apply    # write
 *   ... --min-views 10        only enrich companies with ≥N dashboard views (default 5)
 *   ... --limit 50            cap the number of companies processed this run
 *   ... --company <key>       single company (debug)
 *   ... --concurrency 6       parallel scrape workers (default 6)
 *   ... --force               re-enrich companies that already have an email
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apexDomain, pickBestEmail } from './lib/email-finder.mjs';
import { slugify } from './lib/employer-sectors.mjs';
import { ATS_DOMAINS, mxOk, findDomain, scrapeCompanyEmails } from './lib/email-enrichment.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function arg(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const n = argv[i + 1];
  return n && !n.startsWith('--') ? n : true;
}

const APPLY = has('--apply');
const FORCE = has('--force');
const MIN_VIEWS = Number(arg('--min-views', 5)) || 0;
const LIMIT = Number(arg('--limit', 0)) || 0;
const ONLY = typeof arg('--company') === 'string' ? arg('--company') : '';
const CONCURRENCY = Math.max(1, Number(arg('--concurrency', 6)) || 6);

/** apex domain with ATS hosts filtered out (empty string if it resolves to an ATS). */
function ownApex(url) {
  const apex = apexDomain(url || '');
  return apex && !ATS_DOMAINS.has(apex) ? apex : '';
}

/** jobs.json: companyKey → most-frequent own (non-ATS) domain. */
function loadJobsDomains() {
  const p = ['data/jobs.json', 'public/data/jobs.json'].map((x) => path.join(ROOT, x)).find(fs.existsSync);
  const byKey = new Map(); // key → Map(domain → count)
  if (!p) return new Map();
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const jobs = Array.isArray(raw) ? raw : raw.jobs || [];
  for (const j of jobs) {
    const key = j.companyKey;
    const dom = ownApex(j.companyDomain || '');
    if (!key || !dom) continue;
    if (!byKey.has(key)) byKey.set(key, new Map());
    const m = byKey.get(key);
    m.set(dom, (m.get(dom) || 0) + 1);
  }
  // collapse to the single most-frequent domain per key
  const out = new Map();
  for (const [key, m] of byKey) {
    out.set(key, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
  return out;
}

/** crawler-companies-auto.json: key → domain AND name-slug → domain (own, non-ATS). */
function loadRegistryDomains() {
  const byKey = new Map();
  const byName = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/crawler-companies-auto.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.companies) ? raw.companies : Object.values(raw);
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const apex = ownApex(c.website || c.careersUrl || '');
      if (!apex) continue;
      if (c.key) byKey.set(slugify(c.key), apex);
      if (c.name) byName.set(slugify(c.name), apex);
    }
  } catch { /* registry optional */ }
  return { byKey, byName };
}

/** Resolve a company's own domain from the cheap local sources, web-search last. */
async function resolveDomain(company, jobsDomains, registry) {
  const key = company.key;
  const nameSlug = slugify(company.name || '');
  const local =
    jobsDomains.get(key) ||
    registry.byKey.get(key) ||
    registry.byKey.get(nameSlug) ||
    registry.byName.get(nameSlug) ||
    '';
  if (local) return { domain: local, domainSource: 'registry' };
  // Last resort: web-search discovery (rate-limited, MX + name-token gated).
  const found = await findDomain(company.name || key);
  return found ? { domain: found, domainSource: 'search' } : { domain: '', domainSource: '' };
}

/** Discover the best contact email for one company. Returns the enriched record. */
async function enrichOne(company, jobsDomains, registry) {
  const { domain, domainSource } = await resolveDomain(company, jobsDomains, registry);
  const rec = { key: company.key, name: company.name, views: company.views, domain, domainSource, email: '', emailSource: '', emailInferred: '' };
  if (!domain) return rec;
  if (!(await mxOk(domain))) { rec.note = 'domain has no MX'; return rec; }
  const found = await scrapeCompanyEmails(domain);
  const best = pickBestEmail(found);
  if (best) { rec.email = best; rec.emailSource = 'scraped'; }
  // No public address scraped, but the domain accepts mail (MX ok): surface a
  // low-confidence `info@` guess in the dashboard's INFERRED column. It never
  // becomes the send recipient on its own — the cold-email sender only uses the
  // confirmed `email`, so the admin must promote it after verifying.
  else rec.emailInferred = `info@${domain}`;
  return rec;
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return out;
}

async function main() {
  const db = await getFirestoreDb();

  // Universe = dashboard insights docs.
  const [insSnap, conSnap] = await Promise.all([
    db.collection('employer_insights').get(),
    db.collection('employer_contacts').get(),
  ]);
  const existing = new Map(); // key → has-email
  conSnap.forEach((d) => {
    const data = d.data() || {};
    existing.set(String(data.companyKey || d.id), Boolean(String(data.email || '').trim()));
  });

  let companies = insSnap.docs.map((d) => {
    const x = d.data() || {};
    return { key: String(x.companyKey || d.id), name: String(x.companyName || x.companyKey || d.id), views: Number(x.totals?.views || 0) };
  });

  // Filter: meaningful traffic, skip junk slug-only names, skip already-filled.
  const looksReal = (c) => c.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.name) || c.views >= 20;
  companies = companies
    .filter((c) => (ONLY ? c.key === ONLY : c.views >= MIN_VIEWS && looksReal(c)))
    .filter((c) => FORCE || ONLY || !existing.get(c.key))
    .sort((a, b) => b.views - a.views);
  if (LIMIT) companies = companies.slice(0, LIMIT);

  console.log(`Universe: ${insSnap.size} insights docs · ${conSnap.size} existing contacts.`);
  console.log(`Enriching ${companies.length} companies (min-views=${MIN_VIEWS}, concurrency=${CONCURRENCY}, ${APPLY ? 'APPLY' : 'dry-run'}).\n`);

  const jobsDomains = loadJobsDomains();
  const registry = loadRegistryDomains();

  let done = 0;
  const records = await mapPool(companies, CONCURRENCY, async (c) => {
    const rec = await enrichOne(c, jobsDomains, registry);
    done++;
    const tag = rec.email ? `✓ ${rec.email}` : rec.domain ? `· no email (${rec.domain})` : '✗ no domain';
    console.log(`[${done}/${companies.length}] ${rec.name} (${rec.views}v) → ${tag}`);
    return rec;
  });

  const toWrite = records.filter((r) => r.email || r.emailInferred);
  const scraped = records.filter((r) => r.email).length;
  console.log(`\nResolved domain for ${records.filter((r) => r.domain).length}/${records.length}; scraped email for ${scraped}, inferred for ${toWrite.length - scraped}.`);

  if (!APPLY) {
    console.log('\n(dry-run — pass --apply to upsert employer_contacts/*)');
    return;
  }

  const { FieldValue } = await import('firebase-admin/firestore');
  let written = 0;
  for (let i = 0; i < toWrite.length; i += 400) {
    const batch = db.batch();
    for (const r of toWrite.slice(i, i + 400)) {
      // merge:true + only non-empty fields → never wipes an admin-edited address.
      // A scraped email lands in `email` (confirmed); a guess only in
      // `emailInferred` so it can't silently become the send recipient.
      const doc = {
        companyKey: r.key,
        domain: r.domain,
        enrichedAt: FieldValue.serverTimestamp(),
        updatedBy: 'sync-employer-contacts',
      };
      if (r.email) { doc.email = r.email; doc.emailSource = r.emailSource; }
      if (r.emailInferred) doc.emailInferred = r.emailInferred;
      batch.set(db.collection('employer_contacts').doc(r.key), doc, { merge: true });
      written++;
    }
    await batch.commit();
  }
  console.log(`\n✅ Upserted ${written} contacts into employer_contacts/ (${scraped} scraped, ${written - scraped} inferred).`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
