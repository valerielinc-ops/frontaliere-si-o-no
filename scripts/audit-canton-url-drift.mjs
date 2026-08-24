#!/usr/bin/env node
/**
 * audit-canton-url-drift.mjs — how many already-indexed job URLs changed their
 * canton section since a point in the past, and in which direction.
 *
 * WHY THIS EXISTS
 * A job detail page lives at `/cerca-lavoro-<canton>/<slug>/` (plus the three
 * localised equivalents). The canton segment is derived, not stored with the
 * posting, so when the derivation changes its mind the URL moves and the old
 * one — which Google has already indexed — becomes a 301. Search Console counts
 * those under «Pagina con reindirizzamento»: 188.160 URLs on 2026-08-21, of
 * which a 1.000-URL sample said ~75% were job pages whose section had moved.
 *
 * That number is a stock. It cannot tell you whether the bleeding stopped,
 * because a redirect stays counted long after the cause is fixed. This script
 * measures the FLOW instead: slugs per week that change section, and whether
 * the move was towards or away from the canton of the municipality named in the
 * slug. Run it on a schedule and the series answers "is this getting better".
 *
 * WHAT IT COMPARES
 * `data/all-known-job-slugs/part-NN.json` is an append-only store of every slug
 * ever published, mapping each to its current path per locale. Comparing one
 * shard against its own state N days ago isolates exactly the population that
 * matters: slugs that existed then AND now, i.e. URLs Google has had time to
 * index. New slugs are not drift, and the store never removes.
 *
 * Sharding is by slug hash, so any shard is a uniform random sample of the
 * corpus. Measured 2026-08-24 over 5 shards (44.919 common slugs, 2026-08-17 →
 * 2026-08-24): per-shard rates 0,73% / 0,94% / 0,99% / 0,86% / 0,78% — tight
 * enough that the default sample of 5 is about precision, not representativity.
 *
 * DIRECTION
 * A rate alone cannot separate "the derivation is converging on the truth" from
 * "the derivation is thrashing". Job slugs usually end in the municipality
 * (…-coop-genossenschaft-richterswil), so the municipality's own canton is an
 * independent oracle. Same measurement, 330 of 387 drifts resolvable: 108 moved
 * TOWARDS that canton, 154 away, 68 lateral. Churn, not convergence — which is
 * what made it a defect worth fixing rather than a corpus improving itself.
 *
 * READ-ONLY AND FAIL-SOFT. Exits 0 on every internal failure: a monitor that
 * breaks the branch it watches gets switched off. A run that could not measure
 * says so and writes nothing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Layout of the store is the producer's business, not this reader's: the
// sharding was introduced when the monolith crossed GitHub's 100 MB push limit
// (#4248) and could move again. Hardcoding `part-NN.json` here would give a
// reader that goes quietly empty on the next reshape.
import {
  KNOWN_SLUGS_SHARD_COUNT,
  knownSlugsManifestFile,
  knownSlugsShardFile,
} from './lib/all-known-job-slugs-store.mjs';
// Static, not dynamic: checkout-profile-analyzer.mjs follows only static
// imports to decide which heavy checkout buckets a job's code path touches.
// A dynamic import here made it lose the trail and fall back to "unknown —
// assume it touches everything", which flagged all 19 excluded buckets as
// wrongly excluded even though this module only reads
// data/canton-municipalities.json (52 KB, well under the 15 MB bucket floor).
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Repo-relative path, as `git show <sha>:<path>` needs it. */
const rel = (abs) => path.relative(REPO_ROOT, abs);

/**
 * The store's per-slug value has carried two shapes over time: a bare path
 * string, and a per-locale object. Both mean the same thing for this audit —
 * only the Italian path is read, because the canton segment is the same
 * decision in all four locales and IT is the one shape guaranteed present.
 *
 * @param {unknown} entry
 * @returns {string} the IT path, or '' when the entry carries none
 */
export function italianPath(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.it === 'string') return entry.it;
  return '';
}

/**
 * First path segment — the canton section (`cerca-lavoro-lucerna`). Returns ''
 * for anything that is not a two-segment job path, so a malformed entry is
 * skipped rather than counted as a drift against ''.
 *
 * @param {string} p
 * @returns {string}
 */
export function sectionOf(p) {
  const segs = String(p || '').split('/').filter(Boolean);
  return segs.length >= 2 ? segs[0] : '';
}

/**
 * Shard ids to sample. Deterministic and evenly spread rather than random: two
 * runs a week apart must measure the same population, or the series compares
 * different samples and its movement means nothing.
 *
 * @param {number} want how many shards to sample
 * @param {number} total shards in the store
 * @returns {number[]} shard indices; the producer's helper names the files
 */
export function pickShards(want, total) {
  const n = Math.max(1, Math.min(want, total));
  const step = total / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(i * step));
  return [...new Set(out)];
}

/**
 * Canton of the municipality named in the slug, or '' when none is recognisable.
 *
 * Scans right-to-left because the municipality is conventionally the last
 * component (`…-spital-limmattal-schlieren`), and tries 3-token then 2-token
 * then 1-token windows so multi-word names (`sankt gallen`, `le mont sur
 * lausanne`) are found before a shorter accidental match inside them.
 *
 * @param {string} slug
 * @param {(text: string) => string | null} infer inferAnyCanton
 * @returns {string}
 */
export function oracleCantonFromSlug(slug, infer) {
  const toks = String(slug || '').split('-').filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    for (let i = toks.length - n; i >= 0; i--) {
      const cand = toks.slice(i, i + n).join(' ');
      if (cand.length < 4) continue;
      let got = null;
      try { got = infer(cand); } catch { got = null; }
      if (got) return String(got).toUpperCase();
    }
  }
  return '';
}

/**
 * Was the move towards the slug's own municipality, away from it, or neither?
 * `unresolved` covers both "no municipality in the slug" and "a section this
 * build does not know", so the three real buckets stay clean.
 *
 * @returns {'towards'|'away'|'lateral'|'unresolved'}
 */
export function classifyDirection(oracle, oldCanton, newCanton) {
  if (!oracle || !oldCanton || !newCanton) return 'unresolved';
  if (newCanton === oracle && oldCanton !== oracle) return 'towards';
  if (oldCanton === oracle && newCanton !== oracle) return 'away';
  return 'lateral';
}

/** `cerca-lavoro-lucerna` → `LU`, built from the canton slug registry. */
export function buildSectionToCanton(registry) {
  const table = registry?.cantons ?? registry ?? {};
  const out = {};
  for (const [code, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object') continue;
    const it = value.it;
    if (typeof it === 'string' && it) out[`cerca-lavoro-${it}`] = String(code).toUpperCase();
  }
  return out;
}

/**
 * Alert threshold, evaluated against the series rather than against a constant.
 *
 * WHY A RATIO OF THE BASELINE AND NOT AN ABSOLUTE NUMBER
 * The first row of the history is the pre-fix measurement (0,79%/week on 2026-08-24,
 * before #6318). The fix's whole claim is that a BFS inference can no longer
 * re-section an indexed URL, so what is left should be the much smaller residue
 * of crawlers genuinely restamping a canton. Halving is the weakest form of that
 * claim that is still worth asserting: sampling noise on ~45.000 slugs at
 * p≈0,008 is about ±0,08 percentage points (2 standard errors), an order of
 * magnitude below the baseline/2 line, so a run that trips this is not noise.
 *
 * WHY TWO CONSECUTIVE RUNS
 * A window straddling the fix (some days before, some after) legitimately still
 * measures old churn, and a single alert on that would be a false one — the
 * exact way a monitor earns being ignored. Requiring the previous run to be over
 * the line too costs one week of latency and removes the whole transition class.
 *
 * @param {Array<{rate: number}>} series history rows, oldest first, current one last
 * @returns {{alert: boolean, reason: string, baseline: number|null, threshold: number|null}}
 */
export function evaluateDriftAlert(series) {
  if (!Array.isArray(series) || series.length < 2) {
    return { alert: false, reason: 'serie troppo corta: serve almeno un run precedente', baseline: null, threshold: null };
  }
  const baseline = Number(series[0].rate);
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return { alert: false, reason: 'baseline non utilizzabile', baseline: null, threshold: null };
  }
  const threshold = baseline / 2;
  const current = Number(series[series.length - 1].rate);
  const previous = Number(series[series.length - 2].rate);
  // The baseline row is itself over the line by construction; it is the thing
  // being improved on, not a run that should raise an alarm about itself.
  if (series.length === 2) {
    return { alert: false, reason: 'primo run dopo la baseline: serve un secondo punto per confermare', baseline, threshold };
  }
  if (current > threshold && previous > threshold) {
    return {
      alert: true,
      reason: `due run consecutivi sopra la soglia: ${(previous * 100).toFixed(2)}% e ${(current * 100).toFixed(2)}% contro una soglia di ${(threshold * 100).toFixed(2)}%`,
      baseline,
      threshold,
    };
  }
  return {
    alert: false,
    reason: current > threshold
      ? `sopra soglia (${(current * 100).toFixed(2)}%) ma il run precedente no: si attende conferma`
      : `sotto soglia (${(current * 100).toFixed(2)}% contro ${(threshold * 100).toFixed(2)}%)`,
    baseline,
    threshold,
  };
}

/** History rows, oldest first. A missing or corrupt file is an empty series. */
export function readDriftSeries(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && Number.isFinite(Number(r.rate)));
}

/**
 * Issue body for the autonomous loop, as bl-planner's 5-field scheda.
 *
 * The consumer is the loop, not a person: a planner that has to derive cause,
 * metric, command and blast radius from scratch burns a whole round rediscovering
 * what this script already knows. What it must NOT do is state the cause as
 * settled — #6318 closed one path and a later return may come from another — so
 * the cause ships as the first hypothesis together with the command that kills
 * it. An issue that sends a fixer after a stale cause costs more than one with
 * no cause at all.
 *
 * @param {object} record the run just measured
 * @param {{reason: string, baseline: number, threshold: number}} verdict
 * @param {string} trend rendered series
 * @returns {string} markdown
 */
export function buildAlertBody(record, verdict, trend) {
  const shardCountUsed = record.shards.length;
  const repro = `node scripts/audit-canton-url-drift.mjs --days ${record.days} --shards ${shardCountUsed} --no-history`;
  return [
    `Il drift di sezione degli URL degli annunci non e' sceso: ${verdict.reason}.`,
    '',
    'Ogni slug che cambia sezione lascia dietro 4 URL (uno per locale) che Google',
    "ha gia' indicizzato e che diventano 301. E' la classe che Search Console",
    'contava come «Pagina con reindirizzamento» (188.160 URL al 2026-08-21, ~75%',
    'pagine di annunci).',
    '',
    '## SCHEDA',
    '',
    '**1-CAUSA (ipotesi, da confermare prima di toccare codice).** La precedenza in',
    '`resolveCantonAgainstPin` (`scripts/assemble-jobs-dataset.mjs`) non tiene: un',
    "cantone che proviene SOLO dall'inferenza BFS riesce a riscrivere il pin, e",
    "cosi' la sezione dell'URL diventa funzione dell'ultimo crawl invece di restare",
    'ferma. #6318 ha chiuso questa strada passando la provenienza',
    '(`crawlerCanton`) e congelando sul pin quando a dissentire e\' solo',
    "l'inferenza. Se il tasso e' risalito, la prima cosa da verificare e' se quella",
    'precedenza e\' ancora quella di #6318:',
    '',
    '```bash',
    "grep -n 'crawlerHasSpoken' scripts/assemble-jobs-dataset.mjs",
    'npx vitest run tests/canton-pin-crawler-authority.test.ts',
    '```',
    '',
    'Se il ramo c\'e\' e i test sono verdi, la causa NON e\' questa e va cercata a',
    'monte, fra le due sorgenti che #6318 non copre per costruzione:',
    '',
    '- il crawler cambia il cantone che dichiara (allora il pin viene corretto, ed',
    "  e' il comportamento voluto: il difetto sta nel parser di quella sorgente).",
    '  Per sapere quali: confronta `canton` per SLUG, non per `id`, fra due build di',
    '  il registro job per-datore-di-lavoro (`by-crawler`) — il 3% dei record cambia `id` a slug',
    '  invariato, quindi un confronto per `id` non vede niente e sembra tutto a posto.',
    "- la stringa `location` cambia fra un crawl e l'altro, e l'inferenza cambia con",
    '  lei. `inferAnyCanton` sulle citta\' pulite e\' corretto (verificato su 16',
    "  comuni), quindi in questo caso il difetto e' nell'estrazione della location,",
    '  non nel database dei comuni.',
    '',
    "**2-FIX.** Dipende da quale delle tre sorgenti sopra regge all'esame; non",
    'preassegnata qui. | **REPO**: sito | **MODE**: non nel manifest',
    "(`scripts/assemble-jobs-dataset.mjs` non e' in",
    '`frontaliere-articles/scripts/ci/loop-sync-manifest.json`, quindi nessun',
    'vincolo di mirror: la fix vive qui e non scende al corpus).',
    '',
    `**3-METRICA.** prima=${(record.rate * 100).toFixed(2)}% atteso=<${(verdict.threshold * 100).toFixed(2)}% | **COMANDO**: \`${repro}\``,
    '',
    `Baseline (prima riga dello storico, misurata prima di #6318): **${(verdict.baseline * 100).toFixed(2)}%** a settimana.`,
    `Soglia: **${(verdict.threshold * 100).toFixed(2)}%**, meta' della baseline, confermata da due run consecutivi.`,
    `Ultima misura: **${record.drifted}** slug su ${record.common} confrontati (**${(record.rate * 100).toFixed(2)}%**), circa **${record.projectedUrlsPerWindow}** URL gia' indicizzati per finestra di ${record.days} giorni sui 4 locali.`,
    `Shard campionati: ${record.shards.join(', ')} su ${record.totalSlugs} slug totali. Commit base del confronto: \`${record.base}\`.`,
    '',
    `Direzione: **${record.direction.towards}** verso il cantone del comune nominato nello slug, **${record.direction.away}** in allontanamento, **${record.direction.lateral}** laterali, ${record.direction.unresolved} senza oracolo.`,
    `${record.direction.away + record.direction.lateral} movimenti su ${record.drifted} non migliorano l'assegnazione.`,
    record.direction.towards > record.direction.away + record.direction.lateral
      ? "La maggioranza CORREGGE l'assegnazione: prima di trattarlo come difetto, valuta se e' un recupero legittimo in corso e se basta alzare la soglia."
      : 'La maggioranza NON migliora l\'assegnazione: e\' churn, quindi un difetto e non un corpus che si sta correggendo.',
    '',
    `Andamento: ${trend}`,
    '',
    '**4-OSSERVATORE.** Gia\' coperto: e\' questo monitor',
    '(`.github/workflows/canton-url-drift-monitor.yml`) a riaprire la issue se il',
    'tasso non scende, e la serie sta in `data/canton-url-drift-history.jsonl`. Una',
    'fix va accompagnata da un test che pinni la precedenza scelta, come fa',
    '`tests/canton-pin-crawler-authority.test.ts`.',
    '',
    '**5-FALLIMENTO.** `Canton URL drift: il tasso settimanale non scende sotto la soglia`',
    '',
    '## FILE',
    '',
    '- `scripts/assemble-jobs-dataset.mjs` — `resolveCantonAgainstPin` e la sua call site',
    '- `tests/canton-pin-crawler-authority.test.ts` — i test della precedenza',
    '- `scripts/lib/target-swiss-locations.mjs` — `inferAnyCanton`',
    '- `data/canton-url-drift-history.jsonl` — la serie',
    '- `scripts/audit-canton-url-drift.mjs` — la misura',
    '',
    '## RISCHIO',
    '',
    'Alto se si torna a far vincere il pin sempre: si ricreano due incidenti noti,',
    'documentati nei test, che vanno restare verdi. #4838 (Obbürgen: il crawler',
    'dichiara NW su 39 posting, BFS non risolve il paese, un pin TI stale',
    'sovrascriveva ogni build e 28 su 39 uscivano come TI) e la collisione di',
    'identity galenica (un URL di listing riusato collassava 220 job non-TI su TI).',
    "In entrambi e' il CRAWLER a contraddire il pin, e in quel caso il pin deve",
    'cedere. Un cantone congelato sbagliato e\' peggio di un redirect: e\' una pagina',
    'con il contenuto nella sezione sbagliata e `addressRegion` errato nel',
    'JobPosting (AGENTS.md Non-Negotiable #3).',
    '',
    "Nota sui numeri: rimisurali col comando sopra prima di lavorare, non fidarti di",
    'quelli qui — questa issue puo\' essere stata aperta settimane fa.',
  ].join('\n');
}

/**
 * Compare one shard's two states.
 *
 * @returns {{common: number, drifted: Array<{slug: string, from: string, to: string}>}}
 */
export function diffShard(oldSlugs, newSlugs) {
  const drifted = [];
  let common = 0;
  for (const slug of Object.keys(newSlugs)) {
    const before = oldSlugs[slug];
    if (before === undefined) continue;
    common++;
    const from = sectionOf(italianPath(before));
    const to = sectionOf(italianPath(newSlugs[slug]));
    if (from && to && from !== to) drifted.push({ slug, from, to });
  }
  return { common, drifted };
}

const git = (args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const days = Math.max(1, Number(arg('days', '7')) || 7);
  const wantShards = Math.max(1, Number(arg('shards', '5')) || 5);
  const historyPath = path.resolve(REPO_ROOT, arg('history', 'data/canton-url-drift-history.jsonl'));
  const ref = arg('ref', 'HEAD');

  const manifest = JSON.parse(fs.readFileSync(knownSlugsManifestFile(REPO_ROOT), 'utf-8'));
  const shardCount = Number(manifest.shardCount) || KNOWN_SLUGS_SHARD_COUNT;
  const totalSlugs = Number(manifest.totalSlugs) || 0;

  // Cut-off by date, not by commit count: main takes ~9.700 commits a week from
  // the bots, so any fixed --depth would land somewhere arbitrary.
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const base = git(['rev-list', '-1', `--before=${since}`, ref]).trim();
  if (!base) {
    console.log(`ℹ️  Nessun commit prima di ${since}: storia troppo corta per misurare. Nessuna scrittura.`);
    return;
  }

  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/canton-url-slugs.json'), 'utf-8'));
  const sectionToCanton = buildSectionToCanton(registry);

  const shards = pickShards(wantShards, shardCount);
  let common = 0;
  const drifted = [];
  const usedShards = [];
  for (const id of shards) {
    const shardPath = rel(knownSlugsShardFile(id, REPO_ROOT));
    let before;
    try {
      before = JSON.parse(git(['show', `${base}:${shardPath}`]));
    } catch {
      // A shard that did not exist at the base commit carries no comparable
      // population; skipping it is honest, and `shards` records what was used.
      console.log(`ℹ️  shard ${id}: assente al commit base, saltato`);
      continue;
    }
    const now = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, shardPath), 'utf-8'));
    const r = diffShard(before.slugs || {}, now.slugs || {});
    common += r.common;
    drifted.push(...r.drifted);
    usedShards.push(id);
  }

  if (!common) {
    console.log('ℹ️  Nessuno slug comune fra le due build: niente da misurare. Nessuna scrittura.');
    return;
  }

  const direction = { towards: 0, away: 0, lateral: 0, unresolved: 0 };
  for (const d of drifted) {
    const oracle = oracleCantonFromSlug(d.slug, inferAnyCanton);
    direction[classifyDirection(oracle, sectionToCanton[d.from], sectionToCanton[d.to])]++;
  }

  const rate = drifted.length / common;
  const record = {
    date: new Date().toISOString().slice(0, 10),
    base: base.slice(0, 11),
    days,
    shards: usedShards,
    common,
    drifted: drifted.length,
    // Ratio, not percent: the consumer formats it. 4 decimals resolves a rate
    // an order of magnitude below today's 0,0086.
    rate: Number(rate.toFixed(4)),
    totalSlugs,
    // What the sample implies for the whole corpus, across the 4 locales — the
    // number that lines up with Search Console's redirect count.
    projectedUrlsPerWindow: Math.round(rate * totalSlugs * 4),
    direction,
  };

  console.log(JSON.stringify(record, null, 2));

  const pct = (rate * 100).toFixed(2);
  const worse = direction.away + direction.lateral;
  const summary = [
    `### Canton URL drift — finestra ${days} giorni`,
    '',
    `| metrica | valore |`,
    `|---|---|`,
    `| slug confrontati | ${common.toLocaleString('it-CH')} (shard ${usedShards.join(', ')}) |`,
    `| hanno cambiato sezione | **${drifted.length.toLocaleString('it-CH')}** — ${pct}% |`,
    `| URL già indicizzati coinvolti | ~${record.projectedUrlsPerWindow.toLocaleString('it-CH')} su ${totalSlugs.toLocaleString('it-CH')} slug × 4 locali |`,
    `| verso il comune dello slug | ${direction.towards} |`,
    `| in allontanamento | ${direction.away} |`,
    `| laterali | ${direction.lateral} |`,
    `| senza oracolo | ${direction.unresolved} |`,
    '',
    direction.towards > worse
      ? '✅ La maggioranza dei movimenti corregge l\'assegnazione.'
      : `⚠️ ${worse} movimenti su ${drifted.length} non migliorano l'assegnazione: è rumore, non convergenza.`,
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); } catch { /* non-fatal */ }
  } else {
    console.log('\n' + summary);
  }

  if (hasFlag('no-history')) return;
  let series = [];
  try {
    series = readDriftSeries(fs.readFileSync(historyPath, 'utf-8'));
  } catch {
    series = []; // first ever run
  }
  try {
    fs.appendFileSync(historyPath, JSON.stringify(record) + '\n');
    console.log(`\n📈 storico aggiornato: ${path.relative(REPO_ROOT, historyPath)}`);
  } catch (e) {
    console.log(`⚠️  storico non scritto (${e?.message || e})`);
    return;
  }

  // Verdict against the series, not against this run alone — see evaluateDriftAlert.
  const verdict = evaluateDriftAlert([...series, record]);
  console.log(`\n${verdict.alert ? '🔴' : '🟢'} ${verdict.reason}`);
  const trend = [...series.slice(-5), record]
    .map((r) => `${r.date} ${(Number(r.rate) * 100).toFixed(2)}%`)
    .join(' → ');
  const tail = [
    '',
    `Andamento: ${trend}`,
    verdict.threshold != null
      ? `Soglia di allarme: ${(verdict.threshold * 100).toFixed(2)}% (metà della baseline ${(verdict.baseline * 100).toFixed(2)}% del ${series[0]?.date ?? '?'}), confermata da due run consecutivi.`
      : 'Soglia non ancora calcolabile: serve almeno un run precedente.',
    '',
    verdict.alert ? `🔴 ${verdict.reason}` : `🟢 ${verdict.reason}`,
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, tail + '\n'); } catch { /* non-fatal */ }
  } else {
    console.log(tail);
  }

  // A file, not an exit code: the workflow must still commit the history row
  // even on an alert, and a non-zero exit would skip that step.
  const alertFile = arg('alert-file', '');
  if (alertFile && verdict.alert) {
    const body = buildAlertBody(record, verdict, trend);
    try {
      fs.writeFileSync(alertFile, body);
      console.log(`\n🔴 allarme scritto in ${alertFile}`);
    } catch (e) {
      console.log(`⚠️  allarme non scritto (${e?.message || e})`);
    }
  }
}

// Fail-soft: a monitor must never be the thing that breaks the branch.
main().catch((e) => {
  console.log(`⚠️  audit-canton-url-drift non ha potuto misurare: ${e?.message || e}`);
});
