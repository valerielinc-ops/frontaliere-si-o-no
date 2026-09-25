import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

/**
 * Un `concurrency.group` che contiene SOLO valori unici per run non serializza
 * niente: e' un gruppo che non puo' mai collidere con se stesso, cioe' nessun
 * limite. Misurato il 2026-09-19 su 24 h di run, job per job: il tetto
 * dell'account e' 20-22 job in esecuzione insieme, e
 * `deploy-matrix-experiment.yml` — che dichiarava
 * `group: deploy-matrix-experiment-${{ github.run_id }}` — teneva in media 2,14
 * slot con picco 6 e media 5,24 nel plateau 18:30→19:45Z, cioe' oltre un quarto
 * della capacita' totale, per uno studio il cui output viene scartato. Nella
 * stessa finestra l'attesa di `tests` passava da 258 s (sotto 50 run vive) a
 * 985 s (sopra), 3,8 volte tanto.
 *
 * Il gruppo per-run resta legittimo come FALLBACK quando il discriminante vero
 * puo' mancare (`github.event.issue.number || github.run_id`): li' il run_id
 * serve solo a non far collidere due eventi senza identita'. Quello che questo
 * osservatore vieta e' il gruppo il cui UNICO contenuto variabile e' unico per
 * run.
 */

const WORKFLOWS_DIR = resolve(import.meta.dirname, '../.github/workflows');

/** Espressioni `${{ ... }}` che valgono un valore diverso a ogni run. */
const PER_RUN_CONTEXTS = /github\.(run_id|run_number|run_attempt)\b/u;

/** Discriminanti stabili: se il gruppo ne contiene uno, puo' collidere. */
const STABLE_DISCRIMINATORS = [
  /github\.workflow\b/u,
  /github\.ref\b/u,
  /github\.ref_name\b/u,
  /github\.sha\b/u,
  /github\.head_ref\b/u,
  /github\.base_ref\b/u,
  /github\.event_name\b/u,
  /github\.event\./u,
  /\binputs\./u,
  /\bmatrix\./u,
  /\bneeds\./u,
];

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

/** Ogni `concurrency.group` del file: quello del workflow e quelli dei job. */
function concurrencyGroups(doc: any): Array<{ where: string; group: string }> {
  const out: Array<{ where: string; group: string }> = [];
  const push = (where: string, value: unknown) => {
    const group = typeof value === 'string' ? value : (value as any)?.group;
    if (typeof group === 'string' && group.trim()) out.push({ where, group });
  };
  push('workflow', doc?.concurrency);
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    push(`job ${jobId}`, (job as any)?.concurrency);
  }
  return out;
}

/** Il gruppo e' un no-op: cita un contesto per-run e nessun discriminante stabile. */
function isPerRunOnly(group: string): boolean {
  if (!PER_RUN_CONTEXTS.test(group)) return false;
  return !STABLE_DISCRIMINATORS.some((re) => re.test(group));
}

describe('concurrency group per-run = nessun limite', () => {
  const files = workflowFiles();

  it('trova i workflow da ispezionare', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('nessun workflow dichiara un gruppo di concorrenza unico per run', () => {
    const offenders: string[] = [];
    for (const name of files) {
      let doc: any;
      try {
        doc = YAML.parse(readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8'));
      } catch {
        continue; // La validita' YAML ha i suoi gate; qui non e' l'invariante.
      }
      for (const { where, group } of concurrencyGroups(doc)) {
        if (isPerRunOnly(group)) offenders.push(`${name} (${where}): ${group}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('riconosce il no-op e lascia passare il fallback legittimo', () => {
    // No-op: il gruppo non puo' collidere con nessun altro run.
    expect(isPerRunOnly('deploy-matrix-experiment-${{ github.run_id }}')).toBe(true);
    expect(isPerRunOnly('x-${{ github.run_number }}-${{ github.run_attempt }}')).toBe(true);
    // Fallback: il discriminante vero c'e', il run_id copre solo la sua assenza.
    expect(isPerRunOnly('issue-fix-${{ github.event.issue.number || github.run_id }}')).toBe(false);
    expect(isPerRunOnly('enable-native-automerge-${{ inputs.pr_number || github.run_id }}')).toBe(false);
    // Gruppo costante: gia' serializzante.
    expect(isPerRunOnly('deploy-matrix-experiment')).toBe(false);
  });

  it('pinna i quattro studi manuali corretti in questa PR', () => {
    const expected: Record<string, string> = {
      'deploy-matrix-experiment.yml': 'deploy-matrix-experiment',
      'cluster-pages-experiment.yml': 'cluster-pages-experiment',
      'matrix-equivalence-check.yml': 'matrix-equivalence',
      'post-build-matrix-test.yml': 'post-build-matrix-test',
    };
    for (const [name, group] of Object.entries(expected)) {
      const doc = YAML.parse(readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8'));
      expect(doc.concurrency.group, name).toBe(group);
      // Una misura gia' partita non va mai uccisa a meta'.
      expect(doc.concurrency['cancel-in-progress'], name).toBe(false);
    }
  });
});
