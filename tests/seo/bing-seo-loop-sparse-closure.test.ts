import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { analyzeWorkflow, transitiveClosure } from '../../scripts/ci/checkout-profile-analyzer.mjs';
import {
  importedDataOrPublicPathsIn,
  literalPathsIn,
  pathsOutsideSparseRules,
  uncoveredAllowListCode,
} from '../../scripts/ci/verify-checkout-profiles.mjs';

/**
 * I job `tree-*` (e `audit`) di `bing-seo-loop.yml` fanno checkout con una
 * allow-list sparse scritta a mano: ogni import nuovo in un modulo che il
 * crawler carica e' un file che quella lista deve nominare.
 *
 * Il guard generale esiste (`scripts/ci/verify-checkout-profiles.mjs`, lanciato
 * da `tests/checkout-sparse-profiles.test.ts`), ma il selezionatore delle PR lo
 * esclude sempre per costo, e su `main` `tests.yml` e' un segnale, non il gate.
 * PR #10941 ha aggiunto a `scripts/lib/jobBoardSections.mjs` l'import di
 * `./professionLandingsSections.mjs`, fuori lista: PR verde, run 37114856509
 * morta in `tree-inventory` con ERR_MODULE_NOT_FOUND, riparata a mano da #11142.
 *
 * Questo test analizza UN solo workflow (non `verifyCheckoutProfiles()`
 * intero) e `scripts/ci/run-related-tests.mjs` lo seleziona per perimetro di
 * path (`sourceTreeLintTests`), non per import: chi aggiunge un import non sa
 * di questo workflow, quindi deve girare proprio sul suo diff.
 */
const WORKFLOW = '.github/workflows/bing-seo-loop.yml';
const FAILURE_TITLE = 'Bing full-tree: sparse-checkout senza la chiusura degli import';

/**
 * Radici del perimetro con cui `run-related-tests.mjs` seleziona questo test.
 * Ogni file di codice della chiusura deve starci dentro: altrimenti un import
 * aggiunto a quel file non farebbe girare il test sulla sua PR. Il lato del
 * runner e' fissato da `tests/run-related-tests-github-assets.test.ts`, che
 * interroga il runner vero per un file sotto ciascuna radice.
 */
const SELECTION_ROOTS = ['scripts/', 'build-plugins/shared/', 'packages/articles/engine/'];

/** Job con il pavimento anti-verde-vacuo: i cinque del crawler full-tree. */
const TREE_JOBS = [
  'tree-inventory',
  'tree-crawl',
  'tree-discovered-inventory',
  'tree-discovered-crawl',
  'tree-report',
];

type Step = { uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

interface AllowListJob {
  jobId: string;
  lines: string[];
  cone: boolean;
  entries: string[];
  closure: Array<{ rel: string; src: string }>;
}

function allowListJobs(): AllowListJob[] {
  const doc = YAML.parse(fs.readFileSync(path.resolve(WORKFLOW), 'utf8')) as Workflow;
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const analysis = analyzeWorkflow(path.resolve(WORKFLOW), pkg.scripts) as {
    jobs: Array<{ jobId: string; entries?: string[]; inlineEntries?: string[] }>;
  };
  const out: AllowListJob[] = [];
  for (const job of analysis.jobs) {
    const checkouts = (doc.jobs?.[job.jobId]?.steps ?? [])
      .filter((step) => typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@'));
    const step = checkouts[0];
    const sparse = step?.with?.['sparse-checkout'];
    if (sparse === undefined) continue;
    const lines = String(sparse).split('\n').map((line) => line.trim()).filter(Boolean);
    // Stesso criterio di verify-checkout-profiles.mjs: allow-list = non comincia
    // con `/*`, attribuibile solo se e' l'unico checkout del job, alla radice.
    if (lines[0] === '/*' || checkouts.length !== 1 || step.with?.path) continue;
    const entries = [...new Set([...(job.entries ?? []), ...(job.inlineEntries ?? [])])];
    out.push({
      jobId: job.jobId,
      lines,
      cone: step.with?.['sparse-checkout-cone-mode'] !== false,
      entries,
      closure: transitiveClosure(entries, { staticOnly: true }),
    });
  }
  return out;
}

const jobs = allowListJobs();
const isCode = (rel: string) => /\.(?:mjs|cjs|js|mts|ts)$/.test(rel);

describe('bing-seo-loop sparse checkout covers the crawler import closure', () => {
  it('verifies every tree job (anti-vacuous floor)', () => {
    const verified = jobs.map((job) => job.jobId);
    expect(verified).toEqual(expect.arrayContaining(TREE_JOBS));
    expect(verified.length).toBeGreaterThanOrEqual(TREE_JOBS.length);
    for (const job of jobs) {
      // Senza entry point la chiusura e' vuota e i controlli sotto passerebbero
      // senza aver guardato nulla.
      expect(job.entries.length, `${job.jobId}: nessun entry point riconosciuto`).toBeGreaterThan(0);
      expect(job.closure.length, `${job.jobId}: chiusura vuota`).toBeGreaterThan(0);
    }
  });

  it.each(jobs.map((job) => [job.jobId, job] as const))(
    '%s: the allow-list materializes every module the job loads',
    (_jobId, job) => {
      const missing = uncoveredAllowListCode(job.lines, job.entries, { cone: job.cone });
      expect(
        missing,
        `${FAILURE_TITLE}\n${WORKFLOW}:${job.jobId} — aggiungi allo sparse-checkout: ${missing.join(', ')}`,
      ).toEqual([]);
    },
  );

  it.each(jobs.map((job) => [job.jobId, job] as const))(
    '%s: the allow-list materializes the data/ and public/ files the closure reads',
    (_jobId, job) => {
      // Gli import JSON (`import routes from '../../data/…json' with { type: 'json' }`)
      // si leggono dal sorgente, quindi il controllo vale anche dove `data/`
      // non e' materializzato (worktree sparse locali).
      const read = new Set<string>();
      const literals = new Set<string>();
      for (const { src } of job.closure) {
        for (const rel of importedDataOrPublicPathsIn(src)) read.add(rel);
        for (const rel of literalPathsIn(src)) if (/^(?:data|public)\//.test(rel)) literals.add(rel);
      }
      // Un letterale (`readFileSync(new URL('../../data/…', import.meta.url))`)
      // conta solo se e' un file tracciato: una URL o un esempio non lo sono.
      if (literals.size) {
        const tracked = execFileSync('git', ['ls-files', '--', ...literals], { encoding: 'utf8' })
          .split('\n').filter(Boolean);
        for (const rel of tracked) read.add(rel);
      }
      const missing = pathsOutsideSparseRules(job.lines, [...read], { cone: job.cone });
      expect(
        missing,
        `${FAILURE_TITLE}\n${WORKFLOW}:${job.jobId} — aggiungi allo sparse-checkout: ${missing.join(', ')}`,
      ).toEqual([]);
    },
  );

  it('keeps every closure module inside the related-test selection perimeter', () => {
    const outside = [...new Set(jobs.flatMap((job) => job.closure.map((row) => row.rel)))]
      .filter((rel) => isCode(rel) && !SELECTION_ROOTS.some((root) => rel.startsWith(root)));
    expect(
      outside,
      'Un import nuovo in questi file non selezionerebbe questo test sulla sua PR: '
        + 'estendi il perimetro di tests/seo/bing-seo-loop-sparse-closure.test.ts in '
        + 'scripts/ci/run-related-tests.mjs (sourceTreeLintTests) e SELECTION_ROOTS qui.',
    ).toEqual([]);
  });

  it('reports the import that broke run 37114856509 (PR #10941)', () => {
    // Allow-list di tree-inventory com'era prima di #11142: senza
    // professionLandingsSections.mjs (e il JSON che importa).
    const inventory = jobs.find((job) => job.jobId === 'tree-inventory');
    expect(inventory).toBeDefined();
    const before = inventory!.lines.filter(
      (line) => !/professionLandingsSections\.mjs$|profession-landing-routes\.json$/.test(line),
    );
    expect(before.length).toBeLessThan(inventory!.lines.length);
    expect(uncoveredAllowListCode(before, inventory!.entries, { cone: inventory!.cone }))
      .toContain('scripts/lib/professionLandingsSections.mjs');
    const dataRead = inventory!.closure.flatMap(({ src }) => [...importedDataOrPublicPathsIn(src)]);
    expect(pathsOutsideSparseRules(before, dataRead, { cone: inventory!.cone }))
      .toContain('data/profession-landing-routes.json');
  });
});
