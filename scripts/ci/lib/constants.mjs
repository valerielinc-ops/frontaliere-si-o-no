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
