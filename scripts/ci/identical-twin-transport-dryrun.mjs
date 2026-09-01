#!/usr/bin/env node
/**
 * identical-twin-transport-dryrun.mjs — controllo 2 (+ riuso del 4) del piano
 * di verifica per il trasporto automatico guidato dal manifest.
 *
 * ## Cosa manca, e perche' questo file non e' ancora "il" trasporto
 *
 * Il proprietario ha deciso (2026-08-15, corpus#331): il trasporto dei gemelli
 * `identical` si estende — MAI un'allowlist per forma di directory, sempre
 * guidato dal manifest, entry per entry — ma solo dopo un piano di verifica
 * che stabilisca la soluzione strutturalmente corretta. Quel piano elenca
 * cinque controlli; il quinto ("propone l'automazione vera") e' esplicitamente
 * gated dietro i primi quattro passati **su un dry-run reale e loggato**, non
 * su un tentativo. Questo file e' quel dry-run: calcola, senza scrivere nulla
 * ne' qui ne' nel corpus, quali file `identical` sono OGGI trasportabili in
 * sicurezza e quali no, e perche'.
 *
 * Non apre PR, non copia, non spinge nulla verso `nanakokyobashi-rgb/
 * frontaliere-articles`. Un osservatore che apra issue avrebbe senso solo
 * dopo che il punto 5 del piano diventa reale (lo dice lo stesso commento del
 * 2026-08-14 che ha scritto il piano) — costruirlo ora sarebbe sorvegliare un
 * canale che non esiste ancora.
 *
 * ## L'inversione che il piano chiede di risolvere
 *
 * Il manifest (`scripts/ci/loop-sync-manifest.json`) vive NEL CORPUS, ma il
 * trasporto guidato dal manifest deve girare SUL SITO (e' li' che vive
 * `mirror-articles-engine.yml`, l'unico precedente di mirror automatico
 * esistente). La soluzione e' la stessa gia' in produzione in
 * `corpus-ahead-check.mjs` per la direzione opposta: un fetch READ-ONLY del
 * manifest via `raw.githubusercontent.com` a ogni run, mai una copia locale
 * che potrebbe divergere dall'originale. Nessuna dipendenza circolare: il
 * sito legge il corpus, non scrive mai.
 *
 * ## I quattro controlli, e come questo file li copre
 *
 * 1. **Prova di confinamento via AST** (`scripts/lib` + `generator/scripts/lib`
 *    + `host`) — QUESTO controllo resta esplicitamente fuori da questo file.
 *    `generator/` e `host/` non esistono affatto su questo repo (verificato:
 *    0 match nel `git/trees` del sito, stesso censimento del piano), quindi
 *    la meta' della prova che dovrebbe leggere quegli alberi e' un confine di
 *    repository — va scritta la' insieme al mirror inverso, quando esistera'.
 *    Il controllo 4 sotto copre la stessa classe di incidente (import non
 *    dichiarato) per la meta' che questo repo PUO' verificare: i file
 *    `identical` che vivono qui.
 * 2. **Dry-run guidato dal manifest, non dalla directory** — per ogni entry
 *    `mode: identical`, l'hash del file al `sitePath` dichiarato contro
 *    `baseline.site`, e l'hash del file del corpus contro `baseline.corpus`
 *    (`classify()`, gia' provato in produzione da `corpus-ahead-check.mjs`
 *    per la direzione corpus→sito; qui la stessa funzione pura serve la
 *    direzione sito→corpus senza una seconda implementazione).
 * 3. **Diff leggibile, non sovrascrittura, sugli `adapted`** — questi file
 *    NON sono mai candidati: `mode !== 'identical'` esce con
 *    `not-eligible-adapted`/`not-eligible-mode` prima di qualunque confronto
 *    di hash. Trattarli come `identical` e' precisamente l'incidente che
 *    #331 esiste per evitare.
 * 4. **Fail-closed sui non dichiarati** — riuso letterale di
 *    `undeclaredRelativeImports()` (`corpus-ahead-check.mjs`), lo stesso
 *    guard che ha misurato l'incidente `meta-field-regex.mjs` →
 *    `unescape-ts-string.mjs` (2026-08-13, PR #5781): un file `identical` che
 *    importa un percorso relativo non coperto dal manifest del corpus ne'
 *    dal transport manifest declassa da `ready` a
 *    `blocked-import-hazard`, MAI trasportato in silenzio.
 *
 * `both-moved` non e' mai `ready`: due modifiche indipendenti dalla baseline
 * vanno riconciliate a mano (`classify()` lo marca gia' cosi').
 *
 * Uso:
 *   node scripts/ci/identical-twin-transport-dryrun.mjs            # report leggibile, exit 0
 *   node scripts/ci/identical-twin-transport-dryrun.mjs --json     # report JSON su stdout
 *   node scripts/ci/identical-twin-transport-dryrun.mjs --strict   # exit 1 se c'e' un candidato bloccato
 *
 * Env: stessi `CORPUS_REPO` / `CORPUS_REF` / `GH_TOKEN` di `corpus-ahead-check.mjs`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_REPO,
  CORPUS_REF,
  MANIFEST_PATH_IN_CORPUS,
  classify,
  localHash,
  readSiteText,
  sha256,
  fetchRaw,
  mapPool,
  undeclaredRelativeImports,
  transportManifestPaths,
} from './corpus-ahead-check.mjs';

/**
 * Classifica UN'entry per il trasporto sito→corpus. Deliberatamente pura
 * (nessuna I/O), come `classify()` di cui e' un rivestimento: il test la
 * esercita senza rete.
 *
 * `now`/`base` hanno la stessa forma di `classify()` (`{site, corpus}`).
 *
 * @returns {{state: string, actionable: boolean, transport: string, headline?: string, detail?: string}}
 */
export function classifyForTransport(entry, now, base) {
  const verdict = classify(entry, now, base);

  // Controllo 3: gli `adapted` non sono mai candidati, qualunque cosa dica il
  // confronto di hash — divergono per costruzione.
  if (entry.mode === 'adapted') {
    return { ...verdict, transport: 'not-eligible-adapted' };
  }
  if (entry.mode !== 'identical') {
    return { ...verdict, transport: 'not-eligible-mode' };
  }

  if (verdict.state === 'site-ahead') {
    return { ...verdict, transport: 'ready' };
  }
  if (verdict.state === 'both-moved') {
    return {
      ...verdict,
      transport: 'blocked-both-moved',
      detail: 'Modificato su entrambi i lati dalla baseline: la riconciliazione e\' manuale, mai automatica.',
    };
  }
  // stable, corpus-ahead, no-baseline, absent-here, check-failed, corpus-only:
  // niente da trasportare da questo lato in nessuno di questi stati.
  return { ...verdict, transport: 'no-op' };
}

async function main() {
  const ARGS = new Set(process.argv.slice(2));
  const AS_JSON = ARGS.has('--json');
  const STRICT = ARGS.has('--strict');

  const manifestBuf = await fetchRaw(CORPUS_REPO, CORPUS_REF, MANIFEST_PATH_IN_CORPUS);
  if (!manifestBuf) {
    throw new Error(`manifest non trovato: ${CORPUS_REPO}@${CORPUS_REF}/${MANIFEST_PATH_IN_CORPUS}`);
  }
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  if (!Array.isArray(manifest.files)) throw new Error('manifest senza array `files`');

  const results = await mapPool(manifest.files, 8, async (entry) => {
    const sitePath = entry.sitePath || entry.path;
    const base = entry.baseline || null;

    if (entry.mode === 'corpus-only' || entry.mode === 'corpus-only-pending' || entry.mode === 'not-ported') {
      return { path: entry.path, sitePath, mode: entry.mode, ...classifyForTransport(entry, { site: null, corpus: null }, base) };
    }

    let now;
    try {
      const buf = await fetchRaw(CORPUS_REPO, CORPUS_REF, entry.path);
      now = { site: localHash(sitePath), corpus: buf === null ? null : sha256(buf) };
    } catch (e) {
      return {
        path: entry.path,
        sitePath,
        mode: entry.mode,
        state: 'check-failed',
        transport: 'check-failed',
        actionable: false,
        headline: `verifica fallita: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`,
      };
    }

    return { path: entry.path, sitePath, mode: entry.mode, ...classifyForTransport(entry, now, base) };
  });

  // Controllo 4, scoped ai soli candidati `ready`: "dichiarato" include sia il
  // manifest del corpus (esclusi corpus-only/-pending, che di la' non hanno
  // un gemello da nominare) sia il transport manifest generator-to-nanako —
  // due canali di consegna dello stesso file, stessa scelta di
  // `corpus-ahead-check.mjs`.
  const declared = new Set(
    manifest.files
      .filter((f) => f.mode !== 'corpus-only' && f.mode !== 'corpus-only-pending')
      .map((f) => f.sitePath || f.path),
  );
  for (const rel of transportManifestPaths()) declared.add(rel);

  const readyEntries = results.filter((r) => r.transport === 'ready');
  const hazards = undeclaredRelativeImports({
    entries: readyEntries.map((r) => ({ path: r.sitePath, mode: r.mode })),
    read: (rel) => readSiteText(rel),
    isDeclared: (rel) => declared.has(rel),
  });
  const hazardsByFrom = new Map();
  for (const h of hazards) {
    if (!hazardsByFrom.has(h.from)) hazardsByFrom.set(h.from, []);
    hazardsByFrom.get(h.from).push(h);
  }
  for (const r of results) {
    if (r.transport !== 'ready') continue;
    const own = hazardsByFrom.get(r.sitePath);
    if (!own) continue;
    r.transport = 'blocked-import-hazard';
    r.detail = own
      .map((h) => `importa \`${h.spec}\` (→ \`${h.target}\`), che il corpus non ha e nessun manifest dichiara`)
      .join('; ');
  }

  const ready = results.filter((r) => r.transport === 'ready');
  const blocked = results.filter((r) => r.transport.startsWith('blocked'));

  if (AS_JSON) {
    console.log(JSON.stringify({ corpusRepo: CORPUS_REPO, corpusRef: CORPUS_REF, alignedAt: manifest.alignedAt || null, results, ready: ready.length, blocked: blocked.length }, null, 2));
  } else {
    const byTransport = results.reduce((acc, r) => ((acc[r.transport] = (acc[r.transport] || 0) + 1), acc), {});
    console.log(`Dry-run trasporto gemelli identical — ${CORPUS_REPO}@${CORPUS_REF}`);
    console.log(`Baseline registrata sul corpus: ${manifest.alignedAt || '(mai)'}\n`);
    console.log(`${results.length} entry nel manifest — ${Object.entries(byTransport).map(([k, v]) => `${k}:${v}`).join('  ')}\n`);

    if (ready.length) {
      console.log(`Pronti per il trasporto (${ready.length}):`);
      for (const r of ready) console.log(`  [ready] ${r.sitePath} → ${r.path}`);
      console.log('');
    } else {
      console.log('Nessun file identical pronto per il trasporto in questo momento.\n');
    }

    if (blocked.length) {
      console.log(`Bloccati (${blocked.length}):`);
      for (const r of blocked) {
        console.log(`  [${r.transport}] ${r.sitePath} → ${r.path}`);
        if (r.detail) console.log(`      ${r.detail}`);
      }
      console.log('');
    }
  }

  return STRICT && blocked.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      // PROCEED-SAFE, come corpus-ahead-check.mjs: un dry-run rotto non deve
      // bloccare niente, dato che nulla dipende ancora da questo script per
      // scrivere. Senza --strict resta un log.
      console.error(`identical-twin-transport-dryrun fallito: ${e && e.stack ? e.stack : e}`);
      process.exit(process.argv.includes('--strict') ? 1 : 0);
    },
  );
}
