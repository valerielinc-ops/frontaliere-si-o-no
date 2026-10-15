/**
 * checkRunObservation.mjs — OSSERVAZIONE (non decisione) dell'insieme dei
 * check-run sulla HEAD di una PR, per l'auto-merge.
 *
 * ── Il difetto che rende necessaria l'osservazione (issue #5552) ───────────
 * `auto-merge-eval.mjs` decide il merge su UN SOLO check-run nominato,
 * `VITEST_CHECK_NAME`. Misurato su 60 PR mergiate (2026-08-09 → 2026-08-11,
 * 626 check-run): sulla HEAD di una PR vivono fino a 10 check-run distinti, di
 * cui 4 sostanziali (`vitest (unit + integration)`, `typecheck (tsc --noEmit)`,
 * `contract`, `detect`). Tre dei quattro NON gattano nulla. E non esiste branch
 * protection su `main` (`branches/main/protection` → 404), quindi quel singolo
 * check È davvero l'unico cancello.
 *
 * Il danno non è una PR rotta mergiata oggi: è che chi AGGIUNGE un gate crede
 * ragionevolmente di averlo aggiunto. Lo vede girare, lo vede rosso su un caso
 * di prova, e conclude che blocca. Non blocca. Misura di questo: PR #5590 è
 * stata mergiata il 2026-08-11T03:04Z con `contract` = `failure`.
 *
 * ── AGGIORNAMENTO: il difetto è stato CHIUSO alla radice ──────────────────
 * `tests.yml` non produce più quattro check-run: `contract` e
 * `typecheck (tsc --noEmit)` sono diventati step del job che produce
 * `VITEST_CHECK_NAME`, quindi un loro rosso fa rosso il check gating.
 *
 * `collision` invece è tornato un check-run a sé il 2026-08-26, e non è un
 * ripensamento: portava un lock `concurrency` GLOBALE (il detector scrive la
 * label su tutte le PR aperte) e, non esistendo le concurrency di step, sul
 * job fuso serializzava una suite da ~18 minuti contro quella di ogni altra PR
 * aperta — terza PR sfrattata a `cancelled`, auto-merge fermo. Resta quindi
 * NON bloccante, ed è corretto: il cancello di merge è la LABEL che applica,
 * non il suo exit code. Due dei quattro «sostanziali» che questo modulo
 * esisteva per SORVEGLIARE non esistono più come check-run separati; degli
 * altri due, uno è quello su cui la decisione si prendeva già.
 *
 * Conseguenza pratica: su una PR normale `wouldBlock` è ora quasi sempre vuoto
 * — non perché l'osservazione sia rotta, ma perché non c'è più niente da
 * osservare che non gatti già. Il modulo resta in piedi, e non è codice morto:
 * continua a classificare QUALUNQUE check-run atterri sulla HEAD, compresi
 * quelli di altri workflow (oggi e in futuro), e la denylist advisory sotto
 * resta l'unico posto dove è scritto perché i check della macchina del ciclo
 * non contano. Se un domani `tests.yml` tornasse a più job, torna utile
 * esattamente com'è. Rimuoverlo sarebbe una decisione a sé, con la sua misura.
 *
 * Questo modulo NON cambia cosa può mergiare. Produce solo l'elenco di ciò che
 * AVREBBE bloccato se la decisione fosse presa sull'insieme invece che sul
 * singolo check. Il passaggio a bloccante è una decisione del proprietario,
 * dopo una settimana di osservazione.
 *
 * ── Perché è un modulo puro ───────────────────────────────────────────────
 * Nessun `gh`, nessuna I/O, nessun `process.exit`: il chiamante passa l'array
 * `.check_runs` che ha GIÀ letto per il gate vitest (zero chiamate API in più)
 * e riceve una struttura. Rende l'intera classificazione unit-testabile su liste
 * sintetiche — vedi `tests/ci-check-run-observation.test.ts`.
 */
import { VITEST_CHECK_NAME } from './constants.mjs';

/**
 * Denylist ADVISORY — corta e NOMINATA, non un'euristica.
 *
 * Il criterio è UNO e verificabile: sono i check-run prodotti dalla MACCHINA
 * del ciclo autonomo, che AGISCE sulla PR invece di GIUDICARLA. Un loro rosso
 * dice che l'automazione è inciampata, non che il codice della PR sia cattivo.
 *
 * Ogni voce è il `name` esatto del check-run, con il workflow che lo produce.
 * Deliberatamente NON contiene i quattro check sostanziali — `vitest (unit +
 * integration)`, `typecheck (tsc --noEmit)`, `contract`, `detect` — che sono
 * esattamente ciò che l'osservazione deve mostrare.
 *
 * In particolare `detect` (pr-collision-detector.yml) NON è qui: sulla stessa
 * finestra di 60 PR ha chiuso 45 volte `success` e 0 volte `failure`, quindi
 * osservarlo non produce rumore, ed è uno dei quattro sostanziali della issue.
 * NB — dal consolidamento in `tests.yml` quel check-run su PR non atterra più:
 * `pr-collision-detector.yml` gira solo su `schedule`/`workflow_dispatch` e lo
 * scan su PR è uno step del job gating. Il nome resta fuori dalla denylist
 * perché la regola («è un giudizio sul diff, non un'azione sulla PR») non è
 * cambiata, e reintrodurlo come job lo rimetterebbe sotto osservazione.
 *
 * NB — i nomi dei check-run NON sono unici per repo: il job `detect` esiste
 * anche in `quality-alerts.yml`, che però gira SOLO su `schedule`/
 * `workflow_dispatch` (verificato) e non atterra mai sulla HEAD di una PR.
 * Nessun altro nome di questa mappa è ambiguo sui trigger `pull_request*`.
 */
export const ADVISORY_CHECK_NAMES = Object.freeze({
  sweep:
    'worktree-branch-janitor.yml — spazzino della coda, nessun verdetto sul codice',
  'delete-closed-unmerged':
    'worktree-branch-janitor.yml — pota i branch delle PR chiuse, gira dopo la decisione',
  preflight:
    'pr-redflag-fixer.yml / pr-redcheck-fixer.yml — decide SE far girare il fixer, non giudica il diff',
  'redflag-fix':
    'pr-redflag-fixer.yml — applica la fix ai finding del reviewer; un rosso è il fixer inciampato',
  'redcheck-fix':
    'pr-redcheck-fixer.yml — ripara il check required rosso; un rosso qui è il fixer inciampato, non un verdetto sul diff',
  followup:
    'post-merge-followup.yml — triage POST-merge (`schedule`/`workflow_dispatch`): per costruzione non può essere un verdetto sulla PR al momento della decisione',
});

/**
 * Conclusioni che rappresentano un VERDETTO NEGATIVO sul codice. Stesso
 * vocabolario di `REAL_FAILURE` in `vitestCheck.mjs`
 * (`vitestVerdictIsTransientCancellation`), tenuto identico di proposito: se un
 * giorno i due elenchi divergessero, l'osservazione e il recupero vitest
 * direbbero cose diverse sullo stesso check-run.
 */
export const BLOCKING_CONCLUSIONS = Object.freeze(['failure', 'timed_out', 'action_required', 'stale']);

/**
 * Conclusioni ESPLICITAMENTE non bloccanti, ognuna per una ragione diversa:
 *  - `success`  → verdetto positivo;
 *  - `skipped`  → il job non è stato eseguito (`if:` falso). Non è un verdetto.
 *                 Sulla finestra misurata sono 235 check-run su 626: trattarli
 *                 come rossi renderebbe l'osservazione inutilizzabile;
 *  - `neutral`  → per definizione GitHub «non influenza lo stato del merge»;
 *  - `cancelled`→ vedi sotto, è il caso che richiede più attenzione.
 */
export const NON_BLOCKING_CONCLUSIONS = Object.freeze(['success', 'skipped', 'neutral', 'cancelled']);

/**
 * `cancelled` NON è un check fallito — e questa distinzione è la più facile da
 * sbagliare qui, perché `gh pr checks` presenta `cancelled` nella colonna
 * `fail`. Un run cancellato non ha prodotto NESSUN verdetto sul codice: non c'è
 * niente da cui dedurre che la PR sia rotta.
 *
 * Non è un caso di scuola, è il caso DOMINANTE: sulle 60 PR misurate le
 * cancellazioni sono 26 (16 su `contract`, 5 su `vitest`, 5 su `typecheck`)
 * contro 2 sole failure reali. `contract` in particolare rigira a OGNI edit
 * della description (concurrency `cancel-in-progress`), quindi ogni correzione
 * del PR body lascia dietro di sé un `cancelled`. Contarli come bloccanti
 * significherebbe 26 falsi allarmi su 2 segnali veri — l'osservazione verrebbe
 * ignorata dopo il primo giorno.
 *
 * Vengono comunque CONTATI e riportati a parte (`cancelled`), perché «quanti
 * check sono stati cancellati al momento della decisione» è a sua volta
 * un'informazione che il proprietario deve avere.
 */

/**
 * Collassa i check-run per NOME tenendo, per ogni nome, l'ultimo COMPLETATO per
 * `completed_at`.
 *
 * È la generalizzazione a tutti i nomi di ciò che
 * `latestCompletedVitestConclusion` fa per il solo vitest, e serve per la stessa
 * ragione già pagata una volta (#2394): uno SHA immutabile può portare PIÙ
 * check-run con lo STESSO nome — il run `pull_request` più qualunque
 * `workflow_dispatch` o ri-esecuzione. Prendere un elemento arbitrario fa
 * leggere un verdetto STANTIO.
 *
 * Misurato, non ipotizzato: sulla HEAD di PR #5511 convivono
 * `vitest (unit + integration)` = `failure` (10:27:23Z) e `success` (10:32:41Z).
 * Senza questo collasso l'osservazione riporterebbe #5511 come «avrebbe
 * bloccato», che è falso: il verdetto finale su quel codice è verde.
 *
 * I run senza `completed_at` (queued/in_progress) NON entrano qui: sono
 * riportati a parte come `pending`.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 * @returns {Array<{name: string, conclusion: string, completed_at: string}>} uno per nome, ordinato per nome.
 */
export function latestCompletedByName(checkRuns) {
  if (!Array.isArray(checkRuns)) return [];
  /** @type {Map<string, {name: string, conclusion: string, completed_at: string}>} */
  const byName = new Map();
  for (const c of checkRuns) {
    if (!c || typeof c.name !== 'string' || !c.name) continue;
    if (c.status !== 'completed') continue;
    if (typeof c.completed_at !== 'string' || !c.completed_at) continue;
    const t = Date.parse(c.completed_at);
    if (Number.isNaN(t)) continue;
    const prev = byName.get(c.name);
    if (prev && Date.parse(prev.completed_at) >= t) continue;
    byName.set(c.name, { name: c.name, conclusion: c.conclusion || '', completed_at: c.completed_at });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Osserva l'insieme dei check-run sulla HEAD e dice quali AVREBBERO bloccato il
 * merge se la decisione fosse presa sull'insieme invece che sul solo
 * `gatingCheckName`.
 *
 * Puro: nessuna I/O, nessun effetto. NON decide nulla — il chiamante usa il
 * risultato solo per riportarlo.
 *
 * @param {Array<object>} checkRuns L'array `.check_runs` della check-runs API.
 * @param {{gatingCheckName?: string, advisory?: Record<string,string>}} [opts]
 * @returns {{
 *   gating: {name: string, conclusion: string}|null,
 *   wouldBlock: Array<{name: string, conclusion: string, completed_at: string}>,
 *   cancelled: Array<{name: string, completed_at: string}>,
 *   advisorySeen: Array<{name: string, conclusion: string, reason: string}>,
 *   pending: string[],
 *   observed: Array<{name: string, conclusion: string, completed_at: string}>,
 *   counts: {distinct: number, wouldBlock: number, cancelled: number, advisory: number, pending: number},
 * }}
 */
export function observeCheckRuns(checkRuns, { gatingCheckName = VITEST_CHECK_NAME, advisory = ADVISORY_CHECK_NAMES } = {}) {
  const collapsed = latestCompletedByName(checkRuns);
  const blocking = new Set(BLOCKING_CONCLUSIONS);

  const wouldBlock = [];
  const cancelled = [];
  const advisorySeen = [];
  for (const c of collapsed) {
    if (Object.prototype.hasOwnProperty.call(advisory, c.name)) {
      advisorySeen.push({ name: c.name, conclusion: c.conclusion, reason: advisory[c.name] });
      continue; // advisory: non entra MAI in wouldBlock, qualunque sia la conclusion.
    }
    if (c.conclusion === 'cancelled') {
      // Nessun verdetto prodotto → non è un fallimento. Contato a parte.
      cancelled.push({ name: c.name, completed_at: c.completed_at });
      continue;
    }
    if (blocking.has(c.conclusion)) wouldBlock.push(c);
  }

  // Un nome ancora in volo (queued/in_progress) al momento della decisione: non
  // ha un verdetto, quindi non blocca — ma «quanti check erano ancora pendenti
  // quando l'auto-merge ha deciso» è a sua volta una misura del difetto.
  const completedNames = new Set(collapsed.map((c) => c.name));
  const pending = [
    ...new Set(
      (Array.isArray(checkRuns) ? checkRuns : [])
        .filter((c) => c && typeof c.name === 'string' && c.name && c.status !== 'completed')
        .map((c) => c.name)
        .filter((n) => !completedNames.has(n)),
    ),
  ].sort();

  const gatingRun = collapsed.find((c) => c.name === gatingCheckName) || null;

  return {
    gating: gatingRun ? { name: gatingRun.name, conclusion: gatingRun.conclusion } : null,
    wouldBlock,
    cancelled,
    advisorySeen,
    pending,
    observed: collapsed,
    counts: {
      distinct: collapsed.length,
      wouldBlock: wouldBlock.length,
      cancelled: cancelled.length,
      advisory: advisorySeen.length,
      pending: pending.length,
    },
  };
}

const MARKER = '<!-- CHECK-SET-OBSERVATION -->';

/** Marker HTML per il dedup/upsert del commento sticky. Esportato perché è
 * anche la chiave con cui si aggregano le PR dopo una settimana:
 * `gh search issues '"CHECK-SET-OBSERVATION"'`. */
export const OBSERVATION_MARKER = MARKER;

const ICON = { success: '✅', skipped: '⏭️', neutral: '➖', cancelled: '🚫' };

/**
 * Rende l'osservazione in markdown. Puro (nessuna I/O) → testabile.
 * Lo stesso testo va sia nel job summary sia, quando c'è almeno un
 * `wouldBlock`, nel commento sticky.
 *
 * @param {ReturnType<typeof observeCheckRuns>} obs
 * @param {{pr?: string|number, head?: string, gatingCheckName?: string}} [ctx]
 */
export function formatObservationMarkdown(obs, { pr = '', head = '', gatingCheckName = VITEST_CHECK_NAME } = {}) {
  const L = [];
  L.push(MARKER);
  L.push('### 🔭 Osservazione dell’insieme dei check (issue #5552) — NON blocca nulla');
  L.push('');
  L.push(
    `L'auto-merge decide **solo** su \`${gatingCheckName}\`. Qui sotto l'insieme COMPLETO dei check-run ` +
      `completati sulla HEAD${head ? ` \`${String(head).slice(0, 8)}\`` : ''}${pr ? ` di #${pr}` : ''} al momento della decisione, ` +
      `e quali **avrebbero** bloccato il merge se la decisione fosse presa sull'insieme. ` +
      `Questa PR è stata mergiata con la regola di oggi: l'elenco è a fini di misura.`,
  );
  L.push('');

  if (obs.wouldBlock.length === 0) {
    L.push('**Verdetto: nessun check aggiuntivo avrebbe bloccato questo merge.**');
  } else {
    const n = obs.wouldBlock.length;
    L.push(`**Verdetto: ${n} check ${n === 1 ? 'avrebbe' : 'avrebbero'} BLOCCATO questo merge:**`);
    L.push('');
    for (const c of obs.wouldBlock) L.push(`- 🔴 \`${c.name}\` → \`${c.conclusion}\` (${c.completed_at})`);
  }
  L.push('');

  L.push('<details><summary>Insieme osservato</summary>');
  L.push('');
  L.push('| check-run | conclusion | conta ai fini del blocco? |');
  L.push('|---|---|---|');
  for (const c of obs.observed) {
    const isAdv = obs.advisorySeen.some((a) => a.name === c.name);
    const isBlk = obs.wouldBlock.some((b) => b.name === c.name);
    let verdict;
    if (isAdv) verdict = 'no — **advisory** (denylist nominata)';
    else if (isBlk) verdict = '**SÌ**';
    else if (c.conclusion === 'cancelled') verdict = 'no — **cancellato, non fallito** (nessun verdetto prodotto)';
    else verdict = 'no';
    L.push(`| \`${c.name}\` | ${ICON[c.conclusion] || '🔴'} \`${c.conclusion}\` | ${verdict} |`);
  }
  L.push('');
  if (obs.pending.length) {
    L.push(`Ancora in volo alla decisione (nessun verdetto): ${obs.pending.map((n) => `\`${n}\``).join(', ')}.`);
    L.push('');
  }
  if (obs.advisorySeen.length) {
    L.push('**Advisory esclusi per nome** (macchina del ciclo: agisce sulla PR, non la giudica):');
    L.push('');
    for (const a of obs.advisorySeen) L.push(`- \`${a.name}\` — ${a.reason}`);
    L.push('');
  }
  L.push('</details>');
  return L.join('\n');
}

/** Riga a campo singolo, greppabile nei log di ogni run, per aggregare la
 * settimana senza aprire un summary alla volta. */
export function formatObservationLogLine(obs, { pr = '', head = '' } = {}) {
  const names = obs.wouldBlock.map((c) => `${c.name}=${c.conclusion}`).join(',') || '-';
  return (
    `CHECK-SET-OBSERVATION pr=${pr} head=${String(head).slice(0, 8)} ` +
    `distinct=${obs.counts.distinct} wouldBlock=${obs.counts.wouldBlock} ` +
    `cancelled=${obs.counts.cancelled} advisory=${obs.counts.advisory} pending=${obs.counts.pending} ` +
    `blockers=${names}`
  );
}
