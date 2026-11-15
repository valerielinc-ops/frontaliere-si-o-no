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
 *   stdout: sha256 esadecimale del fingerprint, oppure `UNKNOWN` se non calcolabile
 *           (troncato/errore/file non verificabili → bail conservativo: il guard NON
 *           deve skippare la review su un fingerprint unknown).
 *   stderr: una riga `fingerprint-contributo <sha12> kind=<ok|truncated|unverifiable|error>
 *           source=<git|api|-> <dettaglio>` che distingue «troncato» (il contributo è
 *           troppo grande per la compare API) da «errore» (git locale e API falliti,
 *           es. 403 a token esaurito): non è lo stesso problema e non si cura allo
 *           stesso modo. Il calcolo usa git locale (merge-base + diff dei soli path
 *           code della PR, i merge di main restano fuori) e cade sulla compare API
 *           solo se il checkout non basta.
 * Env:  GH_TOKEN (read-only), GITHUB_REPOSITORY.
 *
 * Confronto nel guard: fingerprint(HEAD) === fingerprint(last-LGTM-commit) ⇒ il
 * contributo della PR è identico (es. rebase di solo main-merge) ⇒ skip Claude.
 */
import { createHash } from 'node:crypto';
import { prContributionFingerprintDetailed } from './auto-merge-eval.mjs';

const sha = process.argv[2];
if (!sha) {
  console.error('uso: node scripts/ci/pr-contribution-fingerprint.mjs <sha>');
  process.exit(2);
}

const result = prContributionFingerprintDetailed(sha);
process.stderr.write(
  `fingerprint-contributo ${sha.slice(0, 12)} kind=${result.kind} source=${result.source ?? '-'} ${result.detail || ''}`.trimEnd() + '\n',
);
const fp = result.fingerprint;
if (fp == null) {
  // null = incertezza (troncato/errore): emetti UNKNOWN così il guard cade
  // sul ramo conservativo (review piena), mai uno skip su fingerprint inaffidabile.
  process.stdout.write('UNKNOWN\n');
} else {
  process.stdout.write(createHash('sha256').update(fp).digest('hex') + '\n');
}
