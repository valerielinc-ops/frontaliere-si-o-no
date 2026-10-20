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
import {
  loadCandidates,
  saveCandidates,
  setStatus,
  byStatus,
  isTraceRetryDue,
  scheduleTraceRetry,
  statusCounts,
} from './lib/prospector/candidate-store.mjs';
import { loadRegistry, saveRegistry, observePlatform } from './lib/prospector/platform-registry.mjs';
import { registrableDomain } from './lib/prospector/registrable.mjs';
import { mapPool } from './lib/prospector/polite-fetch.mjs';
import { CONCURRENCY } from './lib/prospector/config.mjs';
import { assertKnownFlags } from './lib/prospector/cli-flags.mjs';
import { parseTraceLimit, prioritizeTraceCandidates } from './lib/prospector/trace-priority.mjs';
import { attributableTraceHosts, traceCandidate } from './lib/prospector/trace-candidate.mjs';

const argv = process.argv.slice(2);
// `--dry-run` e' riconosciuto letteralmente: un refuso (`--dryrun`, `-n`) non
// e' un flag diverso, e' nessun flag, e la corsa scrive davvero.
assertKnownFlags(argv, { booleans: ['dry-run'], valued: ['key', 'limit', 'source'] });
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const limit = parseTraceLimit(arg('limit', undefined), 40);
const onlyKey = arg('key', '');
const onlySource = arg('source', '');
const dryRun = flag('dry-run');

const store = loadCandidates();
const registry = loadRegistry();

const queue = onlyKey
  // Manual --key intentionally bypasses automatic retry cooldown/evidence suppression.
  ? [store.candidates[onlyKey]].filter(Boolean)
  : prioritizeTraceCandidates(
    // Prefer direct careers URLs, known employer domains and recent SECO
    // observations; reserve a weighted share for weaker fallback candidates.
    byStatus(store, 'new')
      .filter((c) => isTraceRetryDue(c))
      .filter((c) => !onlySource || (c.sources || []).includes(onlySource)),
    limit,
  );

console.log('═══ Prospector · TRACE ═══');
console.log(`in coda: ${queue.length} candidati (di ${byStatus(store, 'new').length} nuovi)\n`);

const results = await mapPool(queue, CONCURRENCY, (c) => traceCandidate(c));

let traced = 0;
let dead = 0;
let deferred = 0;
let platformHits = 0;
const promoted = [];

for (const r of results) {
  if (!r) continue;
  const { c } = r;
  if (r.verdict === 'retry') {
    deferred++;
    setStatus(store, c.key, 'new', scheduleTraceRetry(c, r.reason));
    console.log(`  ↻ ${String(c.name).slice(0, 32).padEnd(34)} ${r.reason} — riprovo dopo ${store.candidates[c.key].traceRetryAt}`);
    continue;
  }
  if (r.verdict === 'dead') {
    dead++;
    setStatus(store, c.key, 'dead', {
      reason: r.reason,
      traceRetryable: false,
      domain: r.domain || undefined,
      traceRetryAt: null,
    });
    continue;
  }
  traced++;
  const hosts = r.trail.externalHosts;
  // Without an independently known employer domain the outlink is observable,
  // but cannot safely become an employer-to-platform registry sighting.
  const attributableHosts = attributableTraceHosts(r);
  for (const h of attributableHosts) {
    platformHits++;
    const { platform, promoted: justPromoted } = observePlatform(registry, {
      tenantHost: h.host,
      employerDomain: r.domain,
      note: `careers outlink, score ${h.score}`,
    });
    if (justPromoted && platform) promoted.push(platform.domain);
  }
  const best = attributableHosts.slice().sort((a, b) => b.score - a.score)[0];
  setStatus(store, c.key, 'traced', {
    domain: r.domain,
    domainEvidence: r.resolution?.evidence,
    careersUrl: best?.url || r.trail.careersUrls[0],
    careersUrls: r.trail.careersUrls,
    platform: best ? registrableDomain(best.host) : null,
    tenantHost: best?.host || null,
    vacancyCount: best?.vacancyCount ?? 0,
    vacancySignals: best?.signals,
    selfHosted: r.selfHosted,
    trailVia: r.trail.via,
    reason: null,
    traceRetryable: null,
    traceRetryAt: null,
  });
  const tag = best
    ? `${best.host} (score ${best.score.toFixed(1)}, ${best.vacancyCount} annunci)`
    : (!r.domain && hosts.length ? 'carriere raggiunte; datore non verificato' : 'sito proprio');
  console.log(`  ✓ ${String(c.name).slice(0, 32).padEnd(34)} ${String(r.domain || 'dominio non verificato').padEnd(26)} → ${tag}`);
}

console.log(`\ntracciati: ${traced}   rimandati: ${deferred}   esauriti: ${dead}   sightings piattaforma: ${platformHits}`);
if (promoted.length) console.log(`PIATTAFORME PROMOSSE a confirmed: ${[...new Set(promoted)].join(', ')}`);
const conf = Object.values(registry.platforms).filter((p) => p.status !== 'candidate' && p.status !== 'rejected');
console.log(`registro: ${Object.keys(registry.platforms).length} piattaforme, ${conf.length} azionabili`);
console.log(`coda: ${JSON.stringify(statusCounts(store))}`);

if (dryRun) console.log('\n--dry-run: niente scritto.');
else { saveCandidates(store); saveRegistry(registry); console.log('\nstato salvato.'); }
