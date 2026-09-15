/**
 * Gate A — prevent accidental `gh run rerun` / `gh run cancel`.
 *
 * PreToolUse hooks block only with exit 2. This gate is fail-safe by design:
 * malformed input, unknown shell syntax, missing run id, and state failures
 * all return 0. It performs no network calls and never invokes `gh`.
 */
import { EXIT_BLOCK } from './lib/hook-exit-codes.mjs';
import { findGhRunMutation, normalizeRepository, readHookCommand } from './lib/hook-command-parser.mjs';
import { claimMarker, resolveHookRepositoryScope } from './lib/hook-state.mjs';

export const MUTATION_REASON_ENV = 'FRONTALIERE_RUN_MUTATION_REASON';
export const MAX_MUTATIONS_PER_RUN = 1;

const BLOCK_MESSAGE =
  '\n🚫 run-mutation-gate: comando `gh run rerun`/`gh run cancel` bloccato.\n' +
  'Ogni tentativo rispende una review Claude completa: la mediana misurata è 384.354 token.\n' +
  'Se il check è rosso, leggi il log e correggi la causa; se è verde, hai finito.\n' +
  `Caso legittimo (guasto d'ambiente esterno alla PR): esporta ${MUTATION_REASON_ENV}="<ragione>" ` +
  `e usa al massimo ${MAX_MUTATIONS_PER_RUN} tentativo autorizzato per quella run.\n` +
  'Non usare il rerun per vedere se passa: la review ripartirebbe senza informazione nuova.\n\n';

const CAP_MESSAGE =
  '\n🚫 run-mutation-gate: comando bloccato — tetto raggiunto.\n' +
  `Questa run ha già consumato il massimo di ${MAX_MUTATIONS_PER_RUN} tentativo autorizzato; ` +
  'un altro rerun/cancel rispenderebbe una review completa (mediana 384.354 token).\n' +
  'Leggi il log se il check è rosso; se è verde, hai finito.\n' +
  `L'autorizzazione ${MUTATION_REASON_ENV} non supera il tetto.\n\n`;

async function main() {
  const input = await readHookCommand();
  if (!input.ok) return;

  const mutation = findGhRunMutation(input.command);
  if (!mutation) return;

  const reason = String(process.env[MUTATION_REASON_ENV] ?? '').trim();
  if (!reason) {
    process.stderr.write(BLOCK_MESSAGE);
    process.exit(EXIT_BLOCK);
  }

  // A shell variable such as "$RUN_ID" is not expandable by a PreToolUse
  // hook. Allowing it is the fail-safe choice because the cap cannot be keyed
  // to a trustworthy run id yet.
  if (!mutation.runId) return;

  const repo =
    mutation.repo ??
    normalizeRepository(process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO) ??
    resolveHookRepositoryScope(input.cwd);
  // Do not collapse an unknown local target into a shared ambient namespace:
  // an untrusted scope cannot safely enforce a per-repository cap.
  if (!repo) return;
  const marker = claimMarker({
    scope: 'run-mutations',
    key: `${repo}:${mutation.runId}`,
    record: {
      action: mutation.action,
      runId: mutation.runId,
      repo,
      reason,
      createdAt: new Date().toISOString(),
      cap: MAX_MUTATIONS_PER_RUN,
    },
  });
  if (marker.status === 'exists') {
    process.stderr.write(CAP_MESSAGE);
    process.exit(EXIT_BLOCK);
  }
  // `claimed` and `unavailable` both allow the command; the latter is the
  // explicit fail-safe path required for a broken/unreadable state store.
}

main().catch(() => process.exit(0));
