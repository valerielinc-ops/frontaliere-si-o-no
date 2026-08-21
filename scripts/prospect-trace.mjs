#!/usr/bin/env node
/**
 * Prospector stage 2 — TRACE.
 *
 * Takes `new` candidates and answers one question each: where does this
 * employer actually publish its vacancies?
 *
 *   name only        -> guess-and-verify a domain (domain-resolve)
 *   domain known     -> follow the careers trail two hops (careers-trail)
 *   third-party host -> record a platform sighting; two unrelated employers on
 *                       one host promote it to `confirmed`, which is what
 *                       unlocks tenant enumeration in stage 3
 *   own site only    -> mark self-hosted; it needs a bespoke crawler
 *   nothing          -> `dead`, with the reason kept in the ledger
 *
 * This stage is the only one that visits employer sites, so it carries the
 * politeness budget: one request per host per second, robots.txt honoured,
 * and a hard cap per run.
 *
 * Usage:
 *   node scripts/prospect-trace.mjs --limit=40
 *   node scripts/prospect-trace.mjs --key=acme-trasporti.ch
 *   node scripts/prospect-trace.mjs --source=osm --limit=150
 *   node scripts/prospect-trace.mjs --limit=20 --dry-run
 */
import { loadCandidates, saveCandidates, setStatus, byStatus, statusCounts } from './lib/prospector/candidate-store.mjs';
import { loadRegistry, saveRegistry, observePlatform } from './lib/prospector/platform-registry.mjs';
import { resolveDomain } from './lib/prospector/domain-resolve.mjs';
import { traceCareers, traceFromCareersUrl } from './lib/prospector/careers-trail.mjs';
import { registrableDomain } from './lib/prospector/registrable.mjs';
import { mapPool } from './lib/prospector/polite-fetch.mjs';
import { CONCURRENCY } from './lib/prospector/config.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const limit = Number(arg('limit', 40));
const onlyKey = arg('key', '');
const onlySource = arg('source', '');
const dryRun = flag('dry-run');

const store = loadCandidates();
const registry = loadRegistry();

const queue = onlyKey
  ? [store.candidates[onlyKey]].filter(Boolean)
  : byStatus(store, 'new')
    .filter((c) => !onlySource || (c.sources || []).includes(onlySource))
    // Two-key ordering, both about return on crawl budget:
    //   1. a candidate that already carries a domain costs ~2 requests to
    //      trace; one that needs name-to-domain guessing costs up to 10 and
    //      fails most of the time (measured: 87 of 104 dead candidates in the
    //      first SECO batch died at domain resolution, not at the careers page).
    //   2. within each group, employers with live ads first — their vacancies
    //      are the ones we would publish today.
    .sort((a, b) => (Number(Boolean(b.domain)) - Number(Boolean(a.domain)))
      || ((b.adCount || 0) - (a.adCount || 0)))
    .slice(0, limit);

console.log('═══ Prospector · TRACE ═══');
console.log(`in coda: ${queue.length} candidati (di ${byStatus(store, 'new').length} nuovi)\n`);

const results = await mapPool(queue, CONCURRENCY, async (c) => {
  let domain = c.domain ? registrableDomain(c.domain) : null;
  let resolution = null;
  if (!domain) {
    resolution = await resolveDomain({ name: c.name, city: c.city, zip: c.zip });
    domain = resolution.domain;
  }
  if (!domain) return { c, verdict: 'dead', reason: 'dominio non risolto', resolution };

  // A source that already handed us the careers URL (the web index does) skips
  // the homepage walk entirely — fewer requests and a trail that cannot be lost
  // to a script-built navigation menu.
  const trail = c.careersUrl
    ? await traceFromCareersUrl(c.careersUrl, domain)
    : await traceCareers(domain);
  if (!trail.reachable) return { c, domain, verdict: 'dead', reason: 'sito irraggiungibile', resolution };
  if (!trail.careersUrls.length && !trail.externalHosts.length) {
    return { c, domain, verdict: 'dead', reason: 'nessuna pagina carriere', resolution, trail };
  }
  return { c, domain, verdict: 'traced', trail, resolution };
});

let traced = 0;
let dead = 0;
let platformHits = 0;
const promoted = [];

for (const r of results) {
  if (!r) continue;
  const { c } = r;
  if (r.verdict === 'dead') {
    dead++;
    setStatus(store, c.key, 'dead', { reason: r.reason, domain: r.domain || undefined });
    continue;
  }
  traced++;
  const hosts = r.trail.externalHosts;
  for (const h of hosts) {
    platformHits++;
    const { platform, promoted: justPromoted } = observePlatform(registry, {
      tenantHost: h.host,
      employerDomain: r.domain,
      note: `careers outlink, score ${h.score}`,
    });
    if (justPromoted && platform) promoted.push(platform.domain);
  }
  const best = hosts.slice().sort((a, b) => b.score - a.score)[0];
  setStatus(store, c.key, 'traced', {
    domain: r.domain,
    domainEvidence: r.resolution?.evidence,
    careersUrl: best?.url || r.trail.careersUrls[0],
    careersUrls: r.trail.careersUrls,
    platform: best ? registrableDomain(best.host) : null,
    tenantHost: best?.host || null,
    vacancyCount: best?.vacancyCount ?? 0,
    vacancySignals: best?.signals,
    selfHosted: r.trail.selfHosted,
    trailVia: r.trail.via,
  });
  const tag = best ? `${best.host} (score ${best.score.toFixed(1)}, ${best.vacancyCount} annunci)` : 'sito proprio';
  console.log(`  ✓ ${String(c.name).slice(0, 32).padEnd(34)} ${String(r.domain).padEnd(26)} → ${tag}`);
}

console.log(`\ntracciati: ${traced}   esauriti: ${dead}   sightings piattaforma: ${platformHits}`);
if (promoted.length) console.log(`PIATTAFORME PROMOSSE a confirmed: ${[...new Set(promoted)].join(', ')}`);
const conf = Object.values(registry.platforms).filter((p) => p.status !== 'candidate' && p.status !== 'rejected');
console.log(`registro: ${Object.keys(registry.platforms).length} piattaforme, ${conf.length} azionabili`);
console.log(`coda: ${JSON.stringify(statusCounts(store))}`);

if (dryRun) console.log('\n--dry-run: niente scritto.');
else { saveCandidates(store); saveRegistry(registry); console.log('\nstato salvato.'); }
