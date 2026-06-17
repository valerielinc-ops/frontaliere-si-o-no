/**
 * auto-merge-sweep.mjs — rete di sicurezza periodica per l'auto-merge (zero-Claude).
 *
 * Perché esiste: `auto-merge-on-lgtm.yml` è puramente EVENT-DRIVEN — valuta solo
 * su `pull_request_review` (## LGTM appena postato) o su `workflow_run` di `tests`
 * concluso con `conclusion == 'success'`. Esiste una classe di PR che diventa
 * mergeable SENZA che scatti nessuno dei due:
 *   - il run `tests` chiude con conclusion ≠ success (es. un job collaterale
 *     `cancelled`) MENTRE il check-run `vitest (unit + integration)` è verde →
 *     il trigger `workflow_run` (gate `conclusion=='success'`) NON parte, ma il
 *     gate vitest di auto-merge-eval (che guarda il check-run, non il run) sarebbe
 *     soddisfatto (osservato 2026-06-17 su #2428: vitest aggregator success, PR
 *     ferma perché nessun evento ri-valutava);
 *   - race tra il completamento del check vitest e l'eval, o LGTM arrivato su un
 *     commit poi superato senza un nuovo evento.
 * Senza ri-valutazione, queste PR restano ferme fino al recycle 24h.
 *
 * Questo sweep gira su `schedule` (+ workflow_dispatch) e RI-VALUTA ogni PR open
 * non-draft con `node scripts/ci/auto-merge-eval.mjs <n>` — STESSA logica e stessi
 * gate dell'event-driven (single source of truth): merge SOLO se `## LGTM` (o
 * drift-fallback) + vitest check == success + collision gate ok. Una PR non pronta
 * → eval esce 0 senza mergiare (idempotente, nessun effetto). Le race col path
 * event-driven sono già gestite da auto-merge-eval (confirmedMergedAfterRace).
 *
 * Uso:  node scripts/ci/auto-merge-sweep.mjs
 * Env:  GH_TOKEN (read-only query), GITHUB_REPOSITORY, MERGE_PRIMARY_TOKEN,
 *       MERGE_FALLBACK_TOKEN, HAS_PAT — passati invariati a ogni auto-merge-eval.
 *       Richiede `gh` in PATH.
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY || '';

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

/**
 * Dalla lista `gh pr list --json number,isDraft` ai numeri PR da ri-valutare:
 * tutte le OPEN non-draft. Puro → testabile. L'eval per-PR fa già tutto il
 * gating (LGTM/vitest/collision); pre-filtrare oltre il draft duplicherebbe la
 * sua logica e rischierebbe di divergere → si delega all'eval (DRY).
 */
export function selectSweepCandidates(prs) {
  if (!Array.isArray(prs)) return [];
  return prs.filter((p) => p && p.isDraft === false && Number.isInteger(p.number)).map((p) => p.number);
}

function main() {
  if (!REPO) {
    console.error('GITHUB_REPOSITORY mancante — skip.');
    process.exit(0);
  }
  let prs;
  try {
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '100',
      '--json', 'number,isDraft']);
  } catch (e) {
    console.error(`gh pr list fallito: ${String(e).slice(0, 160)} — skip.`);
    process.exit(0);
  }
  const candidates = selectSweepCandidates(prs);
  console.log(`auto-merge-sweep: ${candidates.length} PR open non-draft da ri-valutare → [${candidates.join(', ') || '—'}]`);

  let merged = 0;
  for (const n of candidates) {
    try {
      // auto-merge-eval esce 0 sia che mergi sia che non sia pronta; eredita
      // l'env (token di merge) dal processo. Cattura lo stdout per loggare l'esito.
      const out = execFileSync('node', ['scripts/ci/auto-merge-eval.mjs', String(n)],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: process.env });
      if (/mergiata/.test(out)) {
        merged++;
        console.log(`  #${n}: MERGIATA dallo sweep ✔`);
      } else {
        // logga solo l'ultima riga di esito dell'eval (gate non soddisfatto, atteso).
        const last = out.trim().split('\n').pop() || '';
        console.log(`  #${n}: no-merge — ${last.slice(0, 160)}`);
      }
    } catch (e) {
      // auto-merge-eval esce !=0 solo su errore reale di merge (raro); non blocca lo sweep.
      console.log(`  #${n}: eval errore (${String(e).slice(0, 120)}) — continuo.`);
    }
  }
  console.log(`auto-merge-sweep completo: ${merged}/${candidates.length} mergiate.`);
}

if (process.argv[1]?.endsWith('auto-merge-sweep.mjs')) {
  main();
}
