/**
 * pr-body-generator-contract.mjs — il lato GENERATORE del contratto sul body.
 *
 * `pr-body-sections-check.mjs` e `pr-body-contract.yml` GIUDICANO un body già
 * scritto. Questo modulo sta dall'altra parte: è ciò che il generatore chiama
 * PRIMA di scriverlo, così che le due metà non possano divergere.
 *
 * Il difetto che chiude è di forma nota — «il generatore non conosce le regole
 * del gate che poi giudica quello che ha scritto»:
 *
 *   1. RESIDUI SENZA STATO. AGENTS.md #8 pretende che ogni bullet di
 *      `## Non implementato (ancora)` dichiari uno stato letterale, e il gate
 *      lo verifica (advisory, `bullet-without-state`). I generatori invece
 *      emettevano bullet nudi. Misurato sulle ultime 100 PR di ogni repo:
 *      sito 264 bullet su 554 senza stato (60 PR su 100), corpus 156 su 378
 *      (74 su 100). Non è cosmesi: `scripts/ci/followup-has-candidates.mjs`
 *      riapre come follow-up ogni bullet senza stato, quindi un residuo già
 *      chiuso torna indietro come issue nuova e la coda non si smaltisce.
 *
 *   2. `Closes` SU UNA FOLLOW-UP AGGREGATA. `pr-body-contract.yml` (blocco
 *      «Closes #N targeting a multi-item follow-up aggregate») fallisce la PR
 *      quando la issue bersaglio è una follow-up multi-item: `Closes` è
 *      GitHub-native e scatta al MERGE, chiudendo un'aggregata da 5 item
 *      perché ne è stato fatto 1 (il circuit-breaker del fixer ne fa 1 per
 *      run). Il generatore emetteva `Closes` incondizionatamente → PR ROSSA IN
 *      PARTENZA. Successo reale due volte nello stesso giorno: #5848 e #5862.
 *
 *   3. `Closes` SU UNA ISSUE CHE UN MONITOR CHIUDE DA SÉ. Una issue
 *      `[crawler-health] <slug>: …` si chiude sulla MISURA, non sul merge:
 *      lo step «Close recovered crawler-health issues» di
 *      `crawler-health-monitor.yml` la risolve quando `data/crawler-health.json`
 *      dà `healthy`. `Closes` la chiudeva al merge del fix, prima che un crawl
 *      lo avesse eseguito; il monitor la riapriva alla misura dopo e il fixer
 *      ripartiva (2026-10-02/03: #10945, #10947, #10948, #11089).
 *
 * La regola di aggregazione NON è riscritta qui: `isAggregate` arriva da
 * `scripts/ci/check-issue-already-resolved.mjs`, che è la stessa sorgente che
 * `pr-body-contract.yml` rispecchia. Generatore e gate condividono un'unica
 * definizione, quindi non possono dare due risposte diverse sullo stesso input.
 *
 * Uso da CLI (per i generatori che sono shell o prompt, non JavaScript):
 *   gh issue view N --json number,title,body,labels \
 *     | node scripts/lib/pr-body-generator-contract.mjs --closing-ref
 *   # → `Closes #N`  oppure  `Addresses #N`
 *
 *   node scripts/lib/pr-body-generator-contract.mjs --closing-ref --json < issue.json
 *   # → { "line": "...", "keyword": "...", "aggregate": true, "reason": "..." }
 */

import { isAggregate } from '../ci/check-issue-already-resolved.mjs';

// ---------------------------------------------------------------------------
// 1. Il vocabolario degli stati, dal lato di chi SCRIVE
// ---------------------------------------------------------------------------

/**
 * Le forme letterali che un bullet di residuo può dichiarare, esattamente come
 * vanno scritte. È la controparte di `STATE_PATTERNS` in
 * `pr-body-sections-check.mjs`: quelle sono le regex che RICONOSCONO, queste
 * sono le stringhe da EMETTERE. Il test `tests/pr-body-generators-state.test.ts`
 * verifica che ognuna di queste sia effettivamente riconosciuta dal gate, così
 * un refactor di una delle due metà non può lasciare l'altra a scrivere una
 * forma che non passa più.
 */
export const RESIDUAL_STATE_LITERALS = Object.freeze([
  'in questa PR',
  'PR concatenata #N',
  'per scelta',
  'by construction',
  'blocked: <causa>',
]);

/**
 * La tassonomia ABOLITA (pre-AGENTS.md #8). Un generatore che la suggerisce
 * ancora sta insegnando all'agente a scrivere bullet che il reviewer boccia e
 * che `followup-has-candidates.mjs` riapre. Il test la cerca nei generatori.
 */
export const ABOLISHED_DEFERRAL_LITERALS = Object.freeze([
  'out of scope',
  'posposto',
]);

// ---------------------------------------------------------------------------
// 2. Quale keyword di chiusura può emettere il generatore
// ---------------------------------------------------------------------------

/**
 * Normalizza le label comunque arrivino: `gh issue view --json labels` dà
 * oggetti `{name}`, l'API REST a volte stringhe, un prompt a volte un CSV.
 *
 * @param {unknown} labels
 * @returns {string[]}
 */
function labelNames(labels) {
  if (!labels) return [];
  const arr = Array.isArray(labels) ? labels : String(labels).split(',');
  return arr
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string')
    .map((n) => n.trim());
}

/**
 * Titoli delle issue che un monitor chiude da sé sulla misura, e che quindi un
 * merge non deve chiudere. Oggi una sola famiglia: `[crawler-health] <slug>: …`,
 * aperta e risolta da `crawler-health-monitor.yml` (step «Close recovered
 * crawler-health issues», che seleziona le aperte con lo stesso prefisso).
 * `tests/pr-body-closing-ref-monitor.test.ts` lega questa regex al filtro di
 * quello step: se lo step sparisce o cambia prefisso, il test diventa rosso.
 *
 * Si estende a un'altra famiglia SOLO quando il suo closer chiude davvero:
 * con `Addresses` e un closer che non chiude, la issue resterebbe aperta per
 * sempre.
 */
export const MONITOR_OWNED_CLOSE_TITLE_RE = /^\[crawler-health\] /;

/**
 * La riga di chiusura che il generatore DEVE scrivere per questa issue:
 * `Closes #N` oppure `Addresses #N`.
 *
 * `Addresses` e non `Closes` quando il bersaglio è una follow-up aggregata
 * multi-item: `Addresses` non è una keyword GitHub, quindi non chiude niente al
 * merge — che è esattamente il comportamento voluto. L'aggregata la chiude
 * `reconcile-followups.mjs` quando TUTTI i suoi item risultano fatti, ed è quel
 * veto che `Closes` scavalcherebbe.
 *
 * `Addresses` anche quando la issue appartiene a un monitor che la chiude da sé
 * (`MONITOR_OWNED_CLOSE_TITLE_RE`): il merge non prova che il fix funzioni,
 * lo prova la misura successiva del monitor.
 *
 * Fail-open deliberato: senza un numero di issue non si inventa niente e si
 * torna `null`. Un generatore che non sa cosa sta chiudendo non deve scrivere
 * una riga di chiusura a caso.
 *
 * @param {{number?: number|string, title?: string, body?: string, labels?: unknown, pull_request?: unknown}} issue
 * @returns {{line: string, keyword: 'Closes'|'Addresses', number: number, aggregate: boolean, reason: string}|null}
 */
export function closingRefFor(issue) {
  const num = Number(issue?.number);
  if (!Number.isInteger(num) || num <= 0) return null;

  // Un riferimento a una PR non è una issue di tracking: il gate lo salta e
  // anche noi (altrimenti si declasserebbe a `Addresses` una chiusura valida).
  if (issue?.pull_request) {
    return { line: `Closes #${num}`, keyword: 'Closes', number: num, aggregate: false, reason: 'pull-request-ref' };
  }

  const labels = labelNames(issue?.labels);
  const isFollowUp = labels.includes('follow-up');
  const aggregate = isFollowUp && isAggregate(issue?.title ?? '', issue?.body ?? '');

  if (aggregate) {
    return {
      line: `Addresses #${num}`,
      keyword: 'Addresses',
      number: num,
      aggregate: true,
      reason:
        'follow-up aggregata multi-item: `Closes` la chiuderebbe al merge con item ancora dovuti '
        + '(pr-body-contract.yml → violazione, PR rossa). La chiude reconcile-followups.mjs '
        + 'quando tutti gli item sono fatti.',
    };
  }

  if (MONITOR_OWNED_CLOSE_TITLE_RE.test(String(issue?.title ?? ''))) {
    return {
      line: `Addresses #${num}`,
      keyword: 'Addresses',
      number: num,
      aggregate: false,
      reason:
        'issue di un monitor che la chiude da sé sulla misura `healthy` '
        + '(crawler-health-monitor.yml, step Close recovered crawler-health issues): '
        + '`Closes` la chiuderebbe al merge, prima che un crawl abbia eseguito il fix; '
        + 'il monitor la riaprirebbe.',
    };
  }

  return {
    line: `Closes #${num}`,
    keyword: 'Closes',
    number: num,
    aggregate: false,
    reason: isFollowUp ? 'follow-up single-item' : 'issue ordinaria',
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');

  const run = (raw) => {
    let issue;
    try {
      issue = JSON.parse(raw);
    } catch {
      process.stderr.write('pr-body-generator-contract: stdin non è JSON di una issue.\n');
      process.exitCode = 2;
      return;
    }
    const res = closingRefFor(issue);
    if (!res) {
      process.stderr.write('pr-body-generator-contract: issue senza `number` — nessuna riga di chiusura.\n');
      process.exitCode = 2;
      return;
    }
    process.stdout.write(asJson ? `${JSON.stringify(res)}\n` : `${res.line}\n`);
  };

  if (argv.includes('--closing-ref')) {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => run(buf));
  } else {
    process.stderr.write('uso: … | node scripts/lib/pr-body-generator-contract.mjs --closing-ref [--json]\n');
    process.exitCode = 2;
  }
}
