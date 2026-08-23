#!/usr/bin/env node
/**
 * Prospector — the state of the loop, in one page.
 *
 * Answers the only three questions that matter between runs: how much coverage
 * the loop has added, where the next unit of work would pay off most, and what
 * it currently cannot reach. The third is the one a dashboard usually hides,
 * and it is what tells you which source to build next.
 *
 * Usage:
 *   node scripts/prospect-report.mjs
 *   node scripts/prospect-report.mjs --markdown   # for a workflow summary
 */
import fs from 'node:fs';
import { loadCandidates, statusCounts } from './lib/prospector/candidate-store.mjs';
import { loadRegistry, enumerablePlatforms, sharedHostPlatforms } from './lib/prospector/platform-registry.mjs';
import { loadCoverage } from './lib/prospector/coverage.mjs';
import { VALIDATION_PATH } from './lib/prospector/config.mjs';
import { loadChannelHealth } from './lib/prospector/sources/commoncrawl-careers.mjs';
import { isTransportLogistics } from './lib/prospector/sector-signal.mjs';

const md = process.argv.includes('--markdown');
const store = loadCandidates();
const registry = loadRegistry();
const coverage = loadCoverage();
const counts = statusCounts(store);
const all = Object.values(store.candidates);

let validation = null;
try { validation = JSON.parse(fs.readFileSync(VALIDATION_PATH, 'utf8')); } catch { /* not graded yet */ }

const h = (t) => (md ? `\n## ${t}\n` : `\n═══ ${t} ═══`);
const row = (k, v) => (md ? `| ${k} | ${v} |` : `  ${String(k).padEnd(38)} ${v}`);
const tableHead = (a, b) => (md ? `\n| ${a} | ${b} |\n|---|---|` : '');

const out = [];
out.push(md ? '# Prospector — stato del loop' : '═══ Prospector — stato del loop ═══');

out.push(h('Copertura'));
out.push(tableHead('metrica', 'valore'));
out.push(row('crawler in produzione oggi', coverage.crawlerCount));
out.push(row('datori in coda (tutti gli stati)', all.length));
out.push(row('promossi dal loop', counts.promoted || 0));
out.push(row('in attesa di sintesi (tracciati)', counts.traced || 0));
out.push(row('da tracciare (nuovi)', counts.new || 0));
out.push(row('esauriti (nessuna pagina carriere)', counts.dead || 0));

if (validation) {
  out.push(h('Qualità dell\'estrazione'));
  out.push(tableHead('esito', 'crawler'));
  for (const [k, v] of Object.entries(validation.tally)) out.push(row(k, v));
  out.push(row('annunci coperti dai promossi', validation.promotedVacancies));
  const weak = (validation.reports || []).filter((r) => r.verdict !== 'good');
  if (weak.length) {
    out.push(md ? '\n**Da riparare**\n' : '\n  Da riparare:');
    for (const r of weak.slice(0, 10)) {
      out.push(md
        ? `- \`${r.companyKey}\` — score ${r.score} — ${r.problems[0] || 'campione insufficiente'}`
        : `    ${String(r.companyKey).padEnd(28)} ${r.score}  ${r.problems[0] || 'campione insufficiente'}`);
    }
  }
}

out.push(h('Piattaforme'));
const enumerable = enumerablePlatforms(registry);
const shared = sharedHostPlatforms(registry);
out.push(row('registrate', Object.keys(registry.platforms).length));
out.push(row('ATS multi-tenant (enumerabili)', enumerable.length));
out.push(row('host condivisi / bacheche', shared.length));

out.push(md ? '\n**Prossimo lavoro che rende di più**\n' : '\n  Prossimo lavoro che rende di più:');
// Ranked by employers-per-crawler: a shared host is one crawler for N
// employers, so it outranks a tenant sweep at equal employer count.
const next = [
  ...shared.map((p) => ({ what: `bacheca ${p.domain}`, gain: p.seenOn.length, cost: 1 })),
  ...enumerable.map((p) => ({ what: `sweep tenant ${p.domain}`, gain: p.tenantCount || p.seenOn.length, cost: 1 })),
].sort((a, b) => b.gain - a.gain).slice(0, 8);
for (const n of next) out.push(md ? `- ${n.what} → ~${n.gain} datori` : `    ${n.what.padEnd(34)} ~${n.gain} datori`);

// Gli errori INATTESI sono l'unica riga di questo report che indica un bug
// nostro invece di una proprieta' del web. Senza questa distinzione finiscono
// fra i `rejected` come il rumore atteso, e vengono ri-scartati allo stesso
// ritmo senza che nessuno li veda.
const unexpected = all.filter((c) => c.errorClass === 'unexpected');
if (unexpected.length) {
  out.push(h('Errori INATTESI in sintesi (probabili bug, non rumore del web)'));
  out.push(tableHead('datore', 'causa'));
  for (const c of unexpected.slice(0, 10)) out.push(row(String(c.name || c.key).slice(0, 34), String(c.reason || '').slice(0, 90)));
  if (unexpected.length > 10) out.push(md ? `- …e altri ${unexpected.length - 10}` : `    …e altri ${unexpected.length - 10}`);
}

// Una PR di promozione ferma non e' un dettaglio di processo: finche' resta
// aperta il loop non ne apre altre — deliberatamente, perche' due si
// bloccherebbero a vicenda — quindi la PIPELINE E' FERMA e questo report e'
// l'unico posto dove si vede.
const promoting = all.filter((c) => c.status === 'promoting');
if (promoting.length) {
  const prs = [...new Set(promoting.map((c) => c.promotionPr).filter(Boolean))];
  out.push(h('Promozione in volo'));
  out.push(row('candidati in attesa di merge', promoting.length));
  out.push(row('PR', prs.map((n) => `#${n}`).join(', ') || '—'));
  out.push(md
    ? '\n> Finche\' una PR di promozione resta aperta il loop non ne apre altre: due rigenererebbero gli stessi gruppi di workflow e si bloccherebbero a vicenda.'
    : '  (finche\' resta aperta, il loop non promuove nessun altro)');
}

out.push(h('Dove il loop NON arriva'));
const deadReasons = {};
for (const c of all.filter((c) => c.status === 'dead')) deadReasons[c.reason || '?'] = (deadReasons[c.reason || '?'] || 0) + 1;
out.push(tableHead('causa', 'datori'));
for (const [k, v] of Object.entries(deadReasons).sort((a, b) => b[1] - a[1])) out.push(row(k, v));

const bySource = {};
for (const c of all) for (const s of c.sources || []) bySource[s] = (bySource[s] || 0) + 1;
out.push(h('Resa per sorgente'));
out.push(tableHead('sorgente', 'datori'));
for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) out.push(row(k, v));

// OSM's Ticino census turned up zero domain-carrying transport/logistics
// businesses (#6251 item 2) — a one-off manual count until now. This makes it
// an ongoing measurement: per SOURCE, how many filed candidates read as
// transport/logistics by name, so a later run can tell whether the
// sector-agnostic `web` sweep is actually closing OSM's gap or whether it
// stays at zero long enough to justify a dedicated source.
const transportLogistics = all.filter((c) => isTransportLogistics(c.name));
if (transportLogistics.length || bySource.osm || bySource.web) {
  const bySourceSector = {};
  for (const c of transportLogistics) for (const s of c.sources || []) bySourceSector[s] = (bySourceSector[s] || 0) + 1;
  out.push(h('Settore trasporti/logistica (copertura OSM vs web)'));
  out.push(tableHead('sorgente', 'datori trasporti/logistica'));
  for (const s of ['osm', 'web', 'seco', 'own']) out.push(row(s, bySourceSector[s] || 0));
  out.push(row('totale distinti', transportLogistics.length));
}

const webHealth = loadChannelHealth();
if (webHealth.length) {
  // Common Crawl is a shared volunteer index and goes dark for stretches
  // (measured: a full hour of `status 0`); a single run's zero yield looks
  // identical whether the index is down or the `.ch` range legitimately had
  // nothing new, so the signal that matters is the outage RATE over recent
  // runs, not any one run's number.
  const recent = webHealth.slice(-14);
  const outages = recent.filter((r) => r.outage).length;
  out.push(h('Salute canale web (Common Crawl)'));
  out.push(tableHead('metrica', 'valore'));
  out.push(row('run in storico', webHealth.length));
  out.push(row(`interruzioni indice, ultimi ${recent.length} run`, outages));
  const last = webHealth[webHealth.length - 1];
  out.push(row('ultimo run', `${last.pagesRead} pagine → ${last.employers} datori${last.outage ? ' (indice non raggiungibile)' : ''}`));
}

console.log(out.join('\n'));
