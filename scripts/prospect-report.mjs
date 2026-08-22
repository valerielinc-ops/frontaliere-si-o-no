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
