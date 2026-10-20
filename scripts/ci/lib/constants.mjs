/**
 * constants.mjs — costanti CI condivise tra gli script di auto-merge/rebase.
 *
 * `VITEST_CHECK_NAME` è il nome del check-run required su cui gattano sia
 * `auto-merge-eval.mjs` (gate 3: HEAD vitest == success) sia `pr-autorebase.mjs`
 * (rilevamento head "orfani" a 0 check-run vitest da heal-dispatchare). Il
 * check viene pubblicato dal job `vitest`; DEVE matchare
 * byte-per-byte il suo `name:` in `.github/workflows/tests.yml` (source of
 * truth: lo YAML non può importare una const JS). Se i tre punti divergono,
 * `headHasVitestCheck` / il gate vitest leggono length 0 / conclusion "" in
 * silenzio → heal ri-dispatcha all'infinito e nessuna PR mergia. Tenendo i due
 * script `.mjs` su questa singola const, l'unico drift residuo possibile è
 * rinominare il job in tests.yml senza aggiornare qui — coperto dal guard
 * test `tests/ci-vitest-check-name.test.ts`.
 */
export const VITEST_CHECK_NAME = 'vitest (unit + integration)';

/** The required check is the execution job itself; no separate wrapper. */
export const VITEST_EXECUTION_JOB_NAME = VITEST_CHECK_NAME;

/**
 * Keep squash commits descriptive even when the PR has only one checkpoint
 * commit. GitHub's repository setting may fall back to the commit subject;
 * every automated merge path therefore supplies this explicit headline.
 */
export function formatSquashCommitSubject({ prNumber, title } = {}) {
  const normalizedPrNumber = String(prNumber ?? '').trim();
  if (!/^\d+$/.test(normalizedPrNumber)) {
    throw new Error('numero PR mancante o non valido per il titolo dello squash');
  }
  if (typeof title !== 'string' || title.trim() === '' || /[\r\n]/u.test(title)) {
    throw new Error('titolo PR mancante o non valido per il titolo dello squash');
  }
  return `${title.trim()} (#${normalizedPrNumber})`;
}

/**
 * Matcha il nome dei check-run dei singoli SHARD vitest in `tests.yml`
 * (`name: vitest shard ${{ matrix.shard }}/4` → `vitest shard 1/4`, …). Distinto
 * da `VITEST_CHECK_NAME`, che è il job AGGREGATORE: l'aggregatore collassa
 * QUALSIASI shard non-`success` (incluso `cancelled`) in un unico `failure`
 * (`needs.vitest-shard.result != success → exit 1`), perdendo l'informazione su
 * SE la failure è un test rotto o una cancellazione transient (concurrency
 * `cancel-in-progress` durante un'ondata di push su main). `vitestCheck.mjs` usa
 * questo regex per ri-aprire gli shard sottostanti e distinguere i due casi
 * (vedi `vitestVerdictIsTransientCancellation`). `\d+\/\d+` resta valido se il
 * numero di shard cambia. Drift dal `name:` del job → guard in
 * `tests/ci-vitest-check-name.test.ts`.
 *
 * NB (2026-08-05): dal de-sharding #2882 `tests.yml` ha un JOB SOLO e questo
 * regex non matcha nulla sugli head odierni — il ramo shard di
 * `vitestVerdictIsTransientCancellation` è quindi inerte, non morto: resta per
 * rendere il ri-shardaggio reversibile senza toccare il percorso di recupero.
 * Nella topologia a job singolo la cancellazione NON viene collassata in
 * `failure`: atterra come `cancelled` sul check aggregatore, caso gestito
 * direttamente lì senza passare da questo regex. */
export const VITEST_SHARD_NAME_RE = /^vitest shard \d+\/\d+$/;

/**
 * Detects a `🔴 Important` finding in a reviewer body, TOLERANT to the reviewer's
 * markdown: `🔴 Important:`, `🔴 **Important —**`, `🔴**Important**:` all match. The
 * plain literal `'🔴 Important'` (used historically) misses the bold form, which
 * the reviewer emitted on PR #2211 round-2 ("🔴 **Important —**") → the
 * redflag-fixer skipped and the PR stalled with an unaddressed 🔴, and the
 * auto-merge 🔴-guard could likewise miss it. Single source for the JS-side gates
 * (auto-merge-eval.mjs).
 *
 * A delimiter (`:`, em-dash `—`, or `-`) is required after `Important` unless
 * the marker is anchored to a structural location (`path:L<linea>:` or
 * `PR body:L<linea>:`). Without the location guard, PR #3330 false-positived:
 * the reviewer's own negation prose "zero 🔴 Important findings (both nits are
 * non-blocking...)" matched the bare marker and made the auto-merge 🔴-guard
 * skip a PR that actually had `## LGTM` and zero real findings. The location
 * form is the output contract documented in REVIEW.md and must remain valid
 * even when the reviewer omits punctuation after the severity prefix.
 *
 * EVOLUZIONE source-backed dal corpus, non una copia dell'intero file adapted:
 * `frontaliere-articles/generator/tests/redflag-important-marker.test.mjs`
 * verifica #977/#1106/#1120/#2350. Il marker resta rosso se e' un finding vero
 * anche quando la location label e' incollata al glifo, dopo un altro finding
 * sulla stessa riga, con una label aperta o dopo una citazione chiusa. Restano
 * verdi invece le citazioni dentro code span/guillemets, compreso un marker che
 * contiene a sua volta 🟡; un numero dispari di backtick non deve nascondere un
 * finding successivo. Le ancore di posizione accettano prefissi di lista,
 * elenchi numerati e piu' path/righe, anche senza punteggiatura dopo Important,
 * ma solo se il testo del finding segue sulla stessa riga.
 *
 * Il conteggio dichiarato `## Findings (Important: N)` NON e' un ingresso del
 * gate: non e' sempre presente e potrebbe solo spostare un verdetto da rosso a
 * verde, spegnendo un finding vero. Resta un oracolo indipendente nei test.
 * Un secondo finding sulla stessa riga richiede un confine di frase esplicito:
 * punteggiatura seguita da spazio. Senza, una citazione plain-text dentro un Nit
 * sarebbe indistinguibile da un nuovo marker.
 *
 * Il preflight di `pr-redflag-fixer.yml` e la Classe B di
 * `stale-pr-rescuer.yml` usano la stessa forma PCRE: grep lavora una riga per
 * volta, quindi le classi negate non devono escludere `\n`. Il test di parita'
 * deriva il pattern dalla source, ne pinna il valore e verifica entrambe le copie
 * dei workflow.
 */
export const REDFLAG_IMPORTANT_RE = /^(?!(?=(?:[^\n\x60]*\x60[^\n\x60]*\x60)*[^\n\x60]*$)(?:[^\n\x60«🟡🟢❓]|\x60[^\n\x60]*\x60|«[^\n»]*»|«(?![^\n»]*»))*[🟡🟢❓](?:(?![.!?;][ \t])(?:[^\n\x60«]|\x60[^\n\x60]*\x60|«[^\n»]*»|«(?![^\n»]*»)))*🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-])(?:(?:(?=(?:[^\n`]*`[^\n`]*`)*[^\n`]*`[^\n`]*$)(?:(?:[^\n«🟡🟢❓]|«[^\n»]*»|«(?![^\n»]*»))*|(?:[^\n«]|«[^\n»]*»|«(?![^\n»]*»))*[🟡🟢❓](?:[^\n«]|«[^\n»]*»|«(?![^\n»]*»))*|(?:[^\n`«🟡🟢❓]|`[^\n`]*`|«[^\n»]*»|«(?![^\n»]*»))*)|(?:(?:[^\n«🟡🟢❓]|«[^\n»]*»|«(?![^\n»]*»))*|(?:[^\n`«]|`[^\n`]*`|«[^\n»]*»|«(?![^\n»]*»)|`(?![^\n`]*`))*[🟡🟢❓](?:[^\n`«]|`[^\n`]*`|«[^\n»]*»|«(?![^\n»]*»)|`(?![^\n`]*`))*|(?:[^\n`«🟡🟢❓]|`[^\n`]*`|«[^\n»]*»|«(?![^\n»]*»))*)(?<!\s`)(?<!^`))🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]|[ \t]*(?:(?:[-*+>]|\d+[.)])[ \t]*){0,3}(?:`[^\n`]*:L?\d+(?:[-–]\d+)?`?|(?:PR[ \t]+body|[A-Za-z0-9_.@/-]+):L?\d+(?:[-–]\d+)?)(?:[ \t]*[,;][ \t]*(?:`[^\n`]*:L?\d+(?:[-–]\d+)?`?|(?:PR[ \t]+body|[A-Za-z0-9_.@/-]+):L?\d+(?:[-–]\d+)?))*:[ \t]*🔴\s*\*{0,2}\s*Important\s*\*{0,2}(?=[ \t]+[^\n \t\r]))/mu;

/**
 * Identità che possono pubblicare la review Claude. Con il token GitHub App
 * la review non arriva sempre con `type: Bot`: le review REST storiche e
 * quelle dell'App hanno metadati diversi. Il login, invece, resta l'identità
 * allowlistata; i gate devono riconoscere le due forme senza accettare un
 * bot/look-alike qualunque.
 */
export const REVIEWER_BOT_LOGIN_RE = /^(?:claude|frontaliere-automation)\[bot\]$/i;

export function isReviewerBot(user) {
  return REVIEWER_BOT_LOGIN_RE.test(user?.login || '');
}

/**
 * File la cui modifica impedisce STRUTTURALMENTE al reviewer Claude di girare
 * sulla PR → niente `## LGTM` → l'auto-merge normale non scatta → senza fallback
 * la PR resta ferma in attesa di un merge manuale.
 *
 * È SOLO `tests.yml`: la GitHub App del reviewer esige che il workflow
 * file in esecuzione sia byte-identico alla versione su `main` (`Workflow
 * validation failed. 401`). Una PR che lo MODIFICA ha per definizione un
 * contenuto diverso da main → 401 → review job rosso, nessun `## LGTM` postato.
 * Verificato che gli altri file storicamente citati come "merge manuale"
 * (`auto-merge-on-lgtm.yml`, `post-merge-followup.yml`, `REVIEW.md`,
 * `FOLLOWUP.md`) NON driftano: il reviewer (che esegue `tests.yml`,
 * invariato) gira e posta `## LGTM` normalmente (`post-merge-followup` per giunta
 * gira su `pull_request: closed`, post-merge → non gatekeepa il merge). Tenere
 * la lista MINIMA limita la superficie "merge senza review Claude" del fallback.
 *
 * Usato da `auto-merge-eval.mjs` (drift-fallback: gate deterministici al posto
 * dell'`## LGTM` mancante). Se in futuro un altro workflow su `pull_request`
 * inizia a invocare il claude-code-action, aggiungilo qui.
 */
export const REVIEW_WORKFLOW_DRIFT_FILES = ['.github/workflows/tests.yml'];
