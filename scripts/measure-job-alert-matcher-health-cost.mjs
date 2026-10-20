#!/usr/bin/env node
/**
 * Costo del passo «matcher health» di send-job-alerts rispetto al planning.
 *
 * Inventario e alert SINTETICI e deterministici (PRNG con seme): stesso input,
 * stesso lavoro a ogni esecuzione. Le dimensioni di default sono quelle della
 * run di produzione 37182235831 (2026-10-04): 3.321 alert pianificati in
 * 127,3 s su 83.760.905 righe candidate, cioe' una finestra media di 25.222
 * righe per alert, su un inventario di circa 30.000 annunci aperti.
 *
 *   baseline  = planAlertMatch per ogni alert sulla sua finestra (il planning)
 *   candidate = baseline + runJobAlertMatcherHealth sull'inventario attivo
 *
 * Stampa le due durate e il rapporto candidate/baseline. Uso:
 *   node scripts/measure-job-alert-matcher-health-cost.mjs \
 *     [--jobs 30000] [--alerts 3321] [--window 25222] [--probes 200] [--seed 9060] [--json]
 * `--alerts` piu' basso accorcia la misura: il rapporto cresce in proporzione,
 * perche' il costo delle sonde non dipende dal numero di alert.
 */
import { performance } from 'node:perf_hooks';
import { planAlertMatch, runJobAlertMatcherHealth } from './send-job-alerts.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} vuole un numero positivo`);
  return value;
}

const JOBS = arg('jobs', 30000);
const ALERTS = arg('alerts', 3321);
const WINDOW = Math.min(arg('window', 25222), JOBS);
const PROBES = arg('probes', 200);
const SEED = arg('seed', 9060);
const JSON_OUT = process.argv.includes('--json');
const NOW = Date.parse('2026-10-04T12:00:00Z');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (list) => list[Math.floor(rnd() * list.length)];

const PROFESSIONS = [
  'Infermiere', 'Cuoco', 'Elettricista', 'Contabile', 'Muratore', 'Commesso', 'Meccanico',
  'Ingegnere', 'Operaio', 'Magazziniere', 'Autista', 'Cameriere', 'Programmatore', 'Impiegato',
  'Fisioterapista', 'Farmacista', 'Logopedista', 'Architetto', 'Disegnatore', 'Saldatore',
  'Idraulico', 'Falegname', 'Receptionist', 'Educatore', 'Assistente', 'Venditore', 'Tecnico',
  'Polimeccanico', 'Contabile', 'Segretario',
];
const QUALIFIERS = ['senior', 'junior', 'qualificato', 'diplomato', 'responsabile', 'aiuto', '80-100%', 'a tempo pieno'];
const CANTONS = ['TI', 'GR', 'VS', 'ZH', 'BE', 'GE', 'VD', 'LU', 'SG', 'AG', 'BS', 'BL', 'SO', 'FR', 'NE', 'ZG', 'SZ', 'TG'];
const CITIES = { TI: ['Lugano', 'Mendrisio', 'Bellinzona', 'Locarno', 'Chiasso'], GR: ['Coira', 'Davos'], ZH: ['Zurigo', 'Winterthur'] };
const CATEGORIES = ['Sanità', 'Ristorazione', 'Edilizia', 'Informatica', 'Commercio', 'Industria', 'Logistica', 'Amministrazione'];

const jobs = Array.from({ length: JOBS }, (_, i) => {
  const canton = rnd() < 0.55 ? 'TI' : pick(CANTONS);
  const firstSeenAt = new Date(NOW - Math.floor(rnd() * 30 * 86400_000)).toISOString();
  return {
    id: `bench-${i}`,
    slug: `bench-job-${i}`,
    title: `${pick(PROFESSIONS)} ${pick(QUALIFIERS)}`,
    company: `Azienda ${i % 1500}`,
    canton,
    city: pick(CITIES[canton] || ['Centro']),
    category: pick(CATEGORIES),
    sourceLang: 'it',
    firstSeenAt,
    crawledAt: firstSeenAt,
    datePosted: firstSeenAt,
  };
});

const alerts = Array.from({ length: ALERTS }, (_, i) => ({
  id: `bench-alert-${i}`,
  email: `bench-${i}@example.invalid`,
  locale: 'it',
  active: true,
  keywords: [pick(PROFESSIONS)],
  cantonFilter: rnd() < 0.7 ? ['TI'] : [pick(CANTONS)],
}));

const context = {
  behaviorProfiles: new Map(),
  lastClickedUrlByEmail: new Map(),
  locationIndex: new Map(),
  cityToCanton: new Map(),
  subscriberProfiles: new Map(),
  applicationIntentAccountProfiles: new Map(),
  now: NOW,
  featureCache: null,
};

// Finestra di ogni alert: WINDOW righe consecutive dell'inventario, con offset
// a rotazione, cosi' il totale delle righe e' ALERTS × WINDOW come in produzione.
let candidateRows = 0;
const baselineStart = performance.now();
for (let i = 0; i < alerts.length; i += 1) {
  const offset = (i * 7919) % Math.max(1, JOBS - WINDOW + 1);
  const recentJobs = jobs.slice(offset, offset + WINDOW);
  candidateRows += recentJobs.length;
  planAlertMatch(alerts[i], { ...context, recentJobs });
}
const baselineMs = performance.now() - baselineStart;

const healthStart = performance.now();
const health = runJobAlertMatcherHealth(jobs, { now: NOW, maxProbes: PROBES });
const healthMs = performance.now() - healthStart;
if (health.error) throw new Error(`matcher health fallito: ${health.error}`);

const candidateMs = baselineMs + healthMs;
const result = {
  seed: SEED,
  jobs: JOBS,
  alerts: ALERTS,
  window: WINDOW,
  candidateRows,
  probes: health.probeCount,
  probesPassed: health.passedCount,
  probeRows: health.probeCount * health.activeInventoryCount,
  baselineMs: Math.round(baselineMs),
  healthMs: Math.round(healthMs),
  candidateMs: Math.round(candidateMs),
  ratio: Number((candidateMs / baselineMs).toFixed(4)),
};

if (JSON_OUT) {
  console.log(JSON.stringify(result));
} else {
  console.log(`inventario ${JOBS} annunci (seme ${SEED}), ${ALERTS} alert × finestra ${WINDOW} = ${candidateRows} righe`);
  console.log(`baseline  (planning):              ${result.baselineMs} ms`);
  console.log(`matcher health (${result.probes} sonde, ${result.probesPassed} ok, ${result.probeRows} righe): ${result.healthMs} ms`);
  console.log(`candidate (planning + health):     ${result.candidateMs} ms`);
  console.log(`rapporto candidate/baseline:       ${result.ratio}`);
}
