/**
 * Gate B — allow one body write per PR, then require an explicit contract-fix
 * override. This is intentionally independent from pr-body-check-gate.mjs:
 * that validator checks the body contents, while this gate controls write
 * frequency. It never reads the body and never calls the network.
 */
import { EXIT_BLOCK } from './lib/hook-exit-codes.mjs';
import { findPrBodyWrite, readHookCommand } from './lib/hook-command-parser.mjs';
import { claimMarker } from './lib/hook-state.mjs';

export const BODY_REWRITE_REASON_ENV = 'FRONTALIERE_ALLOW_PR_BODY_REWRITE_REASON';

const BLOCK_MESSAGE =
  '\n🚫 pr-body-write-gate: seconda riscrittura del body della PR bloccata.\n' +
  "Il body si scrive una sola volta, alla fine e dopo l'ultimo push: una riscrittura genera un nuovo run di tests/review sulla stessa SHA.\n" +
  'Eccezione tracciabile: se pr-body-check-gate.mjs ha chiesto una correzione del contratto, ' +
  `esporta ${BODY_REWRITE_REASON_ENV}="<ragione>" e riprova la riscrittura dovuta; poi rimuovi la variabile.\n\n`;

async function main() {
  const input = await readHookCommand();
  if (!input.ok) return;

  const bodyWrite = findPrBodyWrite(input.command, process.env);
  if (!bodyWrite || !bodyWrite.prNumber) return;

  const repo = bodyWrite.repo ?? 'ambient-repository';
  const marker = claimMarker({
    scope: 'pr-body-writes',
    key: `${repo}:${bodyWrite.prNumber}`,
    record: {
      prNumber: bodyWrite.prNumber,
      repo,
      bodyFlag: bodyWrite.bodyFlag,
      createdAt: new Date().toISOString(),
    },
  });

  if (marker.status === 'claimed' || marker.status === 'unavailable') return;

  const reason = String(process.env[BODY_REWRITE_REASON_ENV] ?? '').trim();
  if (reason) {
    process.stderr.write(
      `✓ pr-body-write-gate: riscrittura autorizzata per correzione del contratto — ${reason}\n`,
    );
    return;
  }

  process.stderr.write(BLOCK_MESSAGE);
  process.exit(EXIT_BLOCK);
}

main().catch(() => process.exit(0));
