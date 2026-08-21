#!/usr/bin/env node
/**
 * Prospector stage 1 — DISCOVER.
 *
 * Fans the discovery sources out over the requested cantons, drops everything
 * we already crawl, and files the rest as candidates. It also does the cheapest
 * platform learning available: cluster the apply-URL hosts the SECO feed hands
 * us, and any host serving two or more unrelated employers is a hosted ATS.
 *
 * Usage:
 *   node scripts/prospect-discover.mjs                       # TI, all sources
 *   node scripts/prospect-discover.mjs --cantons=TI,GR,VS
 *   node scripts/prospect-discover.mjs --sources=seco --days=60
 *   node scripts/prospect-discover.mjs --cantons=all --dry-run
 *
 * Options:
 *   --cantons=<list|all>  default TI
 *   --sources=<list>      own,seco,osm,web    (default: all four)
 *   --pages=<n>           index pages to sweep for `web`, default 20
 *   --days=<n>            SECO window, default 30
 *   --limit=<n>           cap candidates filed per run
 *   --dry-run             report only, write nothing
 */
import { fetchSecoEmployers } from './lib/prospector/sources/seco-jobroom.mjs';
import { fetchOsmBusinesses } from './lib/prospector/sources/osm-overpass.mjs';
import { censusFromOwnCrawls, listingPathsFromAdapters } from './lib/prospector/sources/known-crawlers.mjs';
import { sweepSwissCareerPages } from './lib/prospector/sources/commoncrawl-careers.mjs';
import { loadCoverage, isCovered } from './lib/prospector/coverage.mjs';
import { loadCandidates, saveCandidates, upsertCandidate, statusCounts, pruneTerminal } from './lib/prospector/candidate-store.mjs';
import { loadRegistry, saveRegistry, observePlatform } from './lib/prospector/platform-registry.mjs';
import { registrableDomain, sameOrg } from './lib/prospector/registrable.mjs';
import { CANTONS } from './lib/prospector/config.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const cantonArg = String(arg('cantons', 'TI'));
const cantons = cantonArg === 'all' ? CANTONS : cantonArg.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const sources = String(arg('sources', 'own,seco,osm,web')).split(',').map((s) => s.trim());
const pages = Number(arg('pages', 20));
const days = Number(arg('days', 30));
const limit = Number(arg('limit', 100000));
const dryRun = flag('dry-run');

const coverage = loadCoverage();
const store = loadCandidates();
const registry = loadRegistry();

console.log('═══ Prospector · DISCOVER ═══');
console.log(`cantoni: ${cantons.join(',')}  sorgenti: ${sources.join(',')}  finestra SECO: ${days}g`);
console.log(`già coperti: ${coverage.crawlerCount} crawler, ${coverage.names.size} nomi, ${coverage.domains.size} domini\n`);

let filed = 0;
let skippedCovered = 0;
const perSource = {};

/**
 * @param {Record<string, any>} candidate
 * @param {string} source
 */
function file(candidate, source) {
  if (filed >= limit) return;
  const cov = isCovered(coverage, candidate);
  if (cov.covered) { skippedCovered++; return; }
  const { created } = upsertCandidate(store, candidate, source);
  if (created) { filed++; perSource[source] = (perSource[source] || 0) + 1; }
}

/* ── Our own crawls, read as a platform census (no network) ───── */
if (sources.includes('own')) {
  const census = censusFromOwnCrawls();
  console.log(`OWN : ${census.jobCount} annunci già crawlati → ${census.platforms.length} piattaforme con ≥2 datori (${census.weakHosts} host deboli scartati)`);
  for (const p of census.platforms) {
    for (const [employer, host, jobPath] of p.employerHosts) {
      observePlatform(registry, {
        tenantHost: host,
        path: jobPath,
        employerDomain: employer.replace(/\s+/g, '-'),
        note: `own-crawl census: ${p.employers.length} datori`,
      });
    }
    const entry = registry.platforms[p.domain];
    if (entry) entry.hostSamples = [...new Set([...(entry.hostSamples || []), ...p.sampleHosts])].slice(0, 25);
  }
  const listing = listingPathsFromAdapters();
  let learned = 0;
  for (const [domain, paths] of Object.entries(listing)) {
    const entry = registry.platforms[domain];
    if (!entry) continue;
    entry.listingPaths = [...new Set([...(entry.listingPaths || []), ...paths])].slice(0, 4);
    learned++;
  }
  console.log(`OWN : path di listing appresi dagli adapter per ${learned} piattaforme`);
}

/* ── SECO ─────────────────────────────────────────────────────── */
if (sources.includes('seco')) {
  for (const canton of cantons) {
    const { employers, adCount, hostHistogram } = await fetchSecoEmployers({ cantons: [canton], onlineSince: days });
    console.log(`SECO ${canton}: ${adCount} annunci, ${employers.length} datori distinti`);
    for (const e of employers) {
      file({
        name: e.name,
        city: e.city,
        zip: e.zip,
        canton,
        country: 'CH',
        domain: e.website ? registrableDomain(e.website) : undefined,
        adCount: e.adCount,
        sampleTitles: e.titles,
        applyHosts: e.applyHosts,
      }, 'seco');
    }

    // Platform learning, for free: which host do UNRELATED employers send
    // applications to? Two independent employers on one host is a vendor.
    // Keyed by registrable domain, but the FULL host is kept per employer:
    // the registry classifies a vendor by whether employers sit on their own
    // subdomain or all share the apex, and reducing to the apex here would
    // erase exactly that signal.
    /** @type {Map<string, { employers: Map<string, string> }>} */
    const byHost = new Map();
    for (const e of employers) {
      for (const h of e.applyHosts) {
        const reg = registrableDomain(h);
        if (!byHost.has(reg)) byHost.set(reg, { employers: new Map() });
        byHost.get(reg).employers.set(e.name.toLowerCase(), h);
      }
    }
    for (const [reg, entry] of byHost) {
      if (entry.employers.size < 2) continue;
      for (const [name, host] of entry.employers) {
        observePlatform(registry, {
          tenantHost: host,
          employerDomain: name.replace(/\s+/g, '-'),
          note: `apply-host cluster from SECO ${canton}`,
        });
      }
    }
  }
}

/* ── OSM ──────────────────────────────────────────────────────── */
if (sources.includes('osm')) {
  for (const canton of cantons) {
    const businesses = await fetchOsmBusinesses(canton);
    console.log(`OSM  ${canton}: ${businesses.length} imprese con dominio`);
    for (const b of businesses) {
      file({ name: b.name, domain: b.domain, city: b.city, canton, country: 'CH', osmTags: b.tags }, 'osm');
    }
  }
}

/* ── The Swiss web's own careers pages, via the crawl index ───── */
if (sources.includes('web')) {
  const sweep = await sweepSwissCareerPages({ pages });
  console.log(`WEB : ${sweep.collection} · ${sweep.pagesRead.length}/${sweep.totalPages} pagine d'indice → ${sweep.employers.length} datori con pagina carriere`);
  for (const e of sweep.employers) {
    // The careers URL is already known, so these skip domain resolution
    // entirely — the most expensive and most failure-prone step in TRACE.
    file({ name: e.host.split('.')[0], domain: e.host, careersUrl: e.url, country: 'CH' }, 'web');
  }
}

/* ── Report ───────────────────────────────────────────────────── */
const confirmed = Object.values(registry.platforms).filter((p) => p.status === 'confirmed' || p.status === 'supported');
console.log(`\nnuovi candidati: ${filed}   (${Object.entries(perSource).map(([s, n]) => `${s}:${n}`).join(', ') || '—'})`);
console.log(`scartati perché già coperti: ${skippedCovered}`);
console.log(`piattaforme note: ${Object.keys(registry.platforms).length}  di cui confermate: ${confirmed.length}`);
if (confirmed.length) {
  console.log('  ' + confirmed.slice(0, 12).map((p) => `${p.domain}(${p.seenOn.length})`).join('  '));
}
console.log(`\ncoda: ${JSON.stringify(statusCounts(store))}`);

const pruned = pruneTerminal(store, Number(arg('prune-days', 90)));
if (pruned) console.log(`potati ${pruned} candidati terminali oltre la finestra di ritenzione`);

if (dryRun) {
  console.log('\n--dry-run: niente scritto su disco.');
} else {
  saveCandidates(store);
  saveRegistry(registry);
  console.log('\nscritti data/prospector/candidates.json e platforms.json');
}
