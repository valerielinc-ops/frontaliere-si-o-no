/**
 * constants.mjs — costanti CI condivise tra gli script di auto-merge/rebase.
 *
 * `VITEST_CHECK_NAME` è il nome del check-run su cui gattano sia
 * `auto-merge-eval.mjs` (gate 3: HEAD vitest == success) sia `pr-autorebase.mjs`
 * (rilevamento head "orfani" a 0 check-run vitest da heal-dispatchare). DEVE
 * matchare byte-per-byte il `name:` del job in `.github/workflows/tests.yml`
 * (source of truth: lo YAML non può importare una const JS). Se i tre punti
 * divergono, `headHasVitestCheck` / il gate vitest leggono length 0 / conclusion
 * "" in silenzio → heal ri-dispatcha all'infinito e nessuna PR mergia. Tenendo
 * i due script `.mjs` su questa singola const, l'unico drift residuo possibile è
 * rinominare il job in tests.yml senza aggiornare qui — coperto dal guard test
 * `tests/ci-vitest-check-name.test.ts`.
 */
export const VITEST_CHECK_NAME = 'vitest (unit + integration)';

/**
 * Matcha il nome dei check-run dei singoli SHARD vitest in `tests.yml`
 * (`name: vitest shard ${{ matrix.shard }}/4` → `vitest shard 1/4`, …). Distinto
 * da `VITEST_CHECK_NAME`, che è il job AGGREGATORE: l'aggregatore collassa
 * QUALSIASI shard non-`success` (incluso `cancelled`) in un unico `failure`
 * (`needs.vitest-shard.result != success → exit 1`), perdendo l'informazione su
 * SE la failure è un test rotto o una cancellazione transient (concurrency
 * `cancel-in-progress` durante un'ondata di push su main). `vitestCheck.mjs` usa
 * questo regex per ri-aprire gli shard sottostanti e distinguere i due casi
 * (vedi `vitestFailureIsTransientCancellation`). `\d+\/\d+` resta valido se il
 * numero di shard cambia. Drift dal `name:` del job → guard in
 * `tests/ci-vitest-check-name.test.ts`. */
export const VITEST_SHARD_NAME_RE = /^vitest shard \d+\/\d+$/;

/**
 * Detects a `🔴 Important` finding in a reviewer body, TOLERANT to the reviewer's
 * markdown: `🔴 Important`, `🔴 **Important`, `🔴**Important**` all match. The plain
 * literal `'🔴 Important'` (used historically) misses the bold form, which the
 * reviewer emitted on PR #2211 round-2 ("🔴 **Important —**") → the redflag-fixer
 * skipped and the PR stalled with an unaddressed 🔴, and the auto-merge 🔴-guard
 * could likewise miss it. Single source for the JS-side gates (auto-merge-eval.mjs).
 *
 * NB: `pr-redflag-fixer.yml`'s preflight greps the SAME shape in bash
 * (`grep -qP '🔴\s*\*{0,2}\s*Important'`) — a YAML `if:` cannot import this regex,
 * so keep the two equivalent. `stale-pr-rescuer.yml` uses an even broader bare `🔴`.
 */
export const REDFLAG_IMPORTANT_RE = /🔴\s*\*{0,2}\s*Important/;

/**
 * File la cui modifica impedisce STRUTTURALMENTE al reviewer Claude di girare
 * sulla PR → niente `## LGTM` → l'auto-merge normale non scatta → senza fallback
 * la PR resta ferma in attesa di un merge manuale.
 *
 * È SOLO `pr-review-loop.yml`: la GitHub App del reviewer esige che il workflow
 * file in esecuzione sia byte-identico alla versione su `main` (`Workflow
 * validation failed. 401`). Una PR che lo MODIFICA ha per definizione un
 * contenuto diverso da main → 401 → review job rosso, nessun `## LGTM` postato.
 * Verificato che gli altri file storicamente citati come "merge manuale"
 * (`auto-merge-on-lgtm.yml`, `post-merge-followup.yml`, `REVIEW.md`,
 * `FOLLOWUP.md`) NON driftano: il reviewer (che esegue `pr-review-loop.yml`,
 * invariato) gira e posta `## LGTM` normalmente (`post-merge-followup` per giunta
 * gira su `pull_request: closed`, post-merge → non gatekeepa il merge). Tenere
 * la lista MINIMA limita la superficie "merge senza review Claude" del fallback.
 *
 * Usato da `auto-merge-eval.mjs` (drift-fallback: gate deterministici al posto
 * dell'`## LGTM` mancante). Se in futuro un altro workflow su `pull_request`
 * inizia a invocare il claude-code-action, aggiungilo qui.
 */
export const REVIEW_WORKFLOW_DRIFT_FILES = ['.github/workflows/pr-review-loop.yml'];
