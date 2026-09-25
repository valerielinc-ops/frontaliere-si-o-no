/**
 * pr-contribution-fingerprint.mjs — stampa un hash STABILE del contributo CODE
 * di una PR a un dato SHA (zero-Claude, sola compare API).
 *
 * Riusa ESATTAMENTE `prContributionFingerprint` di auto-merge-eval.mjs (3-dot vs
 * merge-base con main, code-only, invariante alla churn di main) così che il
 * re-review guard di `pr-review-loop.yml` e il carry-forward dell'LGTM di
 * auto-merge-eval decidano "contributo invariato" con LA STESSA semantica — niente
 * drift by-construction (AGENTS.md #6).
 *
 * Uso:  node scripts/ci/pr-contribution-fingerprint.mjs <sha>
 *   stdout: sha256 esadecimale del fingerprint, oppure `NULL` se non calcolabile
 *           (compare troncato/errore/file grandi → bail conservativo: il guard NON
 *           deve skippare la review su un NULL).
 * Env:  GH_TOKEN (read-only), GITHUB_REPOSITORY.
 *
 * Confronto nel guard: fingerprint(HEAD) === fingerprint(last-LGTM-commit) ⇒ il
 * contributo della PR è identico (es. rebase di solo main-merge) ⇒ skip Claude.
 */
import { createHash } from 'node:crypto';
import { prContributionFingerprint } from './auto-merge-eval.mjs';

const sha = process.argv[2];
if (!sha) {
  console.error('uso: node scripts/ci/pr-contribution-fingerprint.mjs <sha>');
  process.exit(2);
}

const fp = prContributionFingerprint(sha);
if (fp == null) {
  // null = incertezza (compare troncato/errore): emetti NULL così il guard cade
  // sul ramo conservativo (review piena), mai uno skip su fingerprint inaffidabile.
  process.stdout.write('NULL\n');
} else {
  process.stdout.write(createHash('sha256').update(fp).digest('hex') + '\n');
}
