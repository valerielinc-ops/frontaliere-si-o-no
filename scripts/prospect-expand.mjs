#!/usr/bin/env node
/**
 * Prospector stage 3 — EXPAND. The stage that makes coverage compound.
 *
 * Stages 1-2 find employers one at a time. This one finds them by the hundred:
 * for every platform the registry has confirmed, enumerate its tenants and file
 * each live one as an already-traced candidate — careers URL, vacancy count and
 * company name all come straight off the tenant page, so nothing has to be
 * resolved or guessed.
 *
 * The economics are the whole point of the loop. Writing one family extractor
 * for a vendor costs the same as writing one bespoke crawler for one employer,
 * and buys every tenant that vendor has. The tenants are, by construction, the
 * employers nobody else indexes: a company big enough to run its own careers
 * infrastructure does not rent a subdomain.
 *
 * Name seeds. The slug enumerator turns employer names we already hold into
 * candidate tenant ids (`Acme Trasporti SA` -> `acmetrasporti`). Dead
 * candidates are the best seeds of all — we know the employer exists and we
 * failed to place it, which is exactly the case a tenant probe resolves.
 *
 * Usage:
 *   node scripts/prospect-expand.mjs                     # every confirmed platform
 *   node scripts/prospect-expand.mjs --platform=example.com
 *   node scripts/prospect-expand.mjs --platforms=2 --max-probe=200
 */
import { loadRegistry, saveRegistry, enumerablePlatforms } from './lib/prospector/platform-registry.mjs';
import { loadCandidates, saveCandidates, upsertCandidate, setStatus, statusCounts } from './lib/prospector/candidate-store.mjs';
import { enumerateTenants } from './lib/prospector/tenant-enum.mjs';
import { loadCoverage, isCovered } from './lib/prospector/coverage.mjs';
import { registrableDomain, tenantLabel } from './lib/prospector/registrable.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const onlyPlatform = arg('platform', '');
const maxPlatforms = Number(arg('platforms', 3));
const maxProbe = Number(arg('max-probe', 250));
const dryRun = flag('dry-run');

const registry = loadRegistry();
const store = loadCandidates();
const coverage = loadCoverage();

const targets = onlyPlatform
  ? [registry.platforms[registrableDomain(onlyPlatform)]].filter(Boolean)
  : enumerablePlatforms(registry).slice(0, maxPlatforms);

if (!targets.length) {
  console.log('Nessuna piattaforma confermata da espandere. Serve prima uno stadio TRACE.');
  process.exit(0);
}

console.log('═══ Prospector · EXPAND ═══');
console.log(`piattaforme da espandere: ${targets.map((p) => `${p.domain}[${p.status}]`).join(', ')}\n`);

// Seed the slug prober with every employer name we know of but could not place.
const seeds = Object.values(store.candidates)
  .filter((c) => c.status === 'dead' || c.status === 'new')
  .map((c) => c.name)
  .filter(Boolean);
console.log(`semi per la sonda slug: ${seeds.length} nomi di datori non ancora collocati\n`);

let filed = 0;
let covered = 0;

for (const platform of targets) {
  const res = await enumerateTenants(platform, { nameSeeds: seeds, maxProbe });
  const live = res.live;
  platform.tenantCount = Math.max(platform.tenantCount || 0, live.length);
  console.log(`${platform.domain}: ${res.discovered.length} host candidati (${JSON.stringify(res.byMethod)}) → ${live.length} tenant VIVI`);

  for (const t of live) {
    const label = tenantLabel(t.host);
    const cand = {
      name: t.company || label,
      domain: undefined,
      tenantHost: t.host,
      platform: platform.domain,
      careersUrl: t.url,
      vacancyCount: t.vacancyCount,
      vacancySignals: t.signals,
      country: 'CH',
    };
    if (isCovered(coverage, { name: cand.name, key: label }).covered) { covered++; continue; }
    const { key, created } = upsertCandidate(store, { ...cand, key: `${label}@${platform.domain}` }, `tenant:${platform.domain}`);
    // Tenants arrive already traced — the platform handed us the careers URL.
    setStatus(store, key, 'traced', cand);
    if (created) {
      filed++;
      console.log(`    + ${String(t.company || label).slice(0, 40).padEnd(42)} ${t.host.padEnd(38)} ${t.vacancyCount} annunci`);
    }
  }
  if (live.length && platform.status === 'candidate') platform.status = 'confirmed';
}

console.log(`\nnuovi datori dai tenant: ${filed}   già coperti: ${covered}`);
console.log(`coda: ${JSON.stringify(statusCounts(store))}`);
if (dryRun) console.log('\n--dry-run: niente scritto.');
else { saveCandidates(store); saveRegistry(registry); console.log('\nstato salvato.'); }
