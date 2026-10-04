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

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

interface AllowListJob {
  jobId: string;
  lines: string[];
  cone: boolean;
  /** Il job esegue `npm ci`/`npm install`: i pacchetti di node_modules esistono. */
  installsDeps: boolean;
  entries: string[];
  closure: Array<{ rel: string; src: string }>;
}

/**
 * Specifier di pacchetto (ne' relativi ne' `node:`) delle dichiarazioni che
 * Node collega prima di eseguire il modulo. Solo a inizio riga, per non
 * scambiare per import la prosa dei commenti («… from 'x'»).
 */
function bareStaticSpecifiersIn(src: string): string[] {
  const out = new Set<string>();
  const res = [
    /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"\n]+)['"]/gm,
    /^\s*import\s*['"]([^'"\n]+)['"]/gm,
  ];
  for (const re of res) {
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:')) out.add(spec);
    }
  }
  return [...out];
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
    const installsDeps = (doc.jobs?.[job.jobId]?.steps ?? [])
      .some((s) => typeof s?.run === 'string' && /\bnpm\s+(?:ci|install|i)\b/.test(s.run));
    out.push({
      jobId: job.jobId,
      lines,
      cone: step.with?.['sparse-checkout-cone-mode'] !== false,
      installsDeps,
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
      const candidates = new Set<string>();
      for (const { src } of job.closure) {
        for (const rel of importedDataOrPublicPathsIn(src)) candidates.add(rel);
        for (const rel of literalPathsIn(src)) if (/^(?:data|public)\//.test(rel)) candidates.add(rel);
      }
      // Un candidato (import o letterale come
      // `readFileSync(new URL('../../data/…', import.meta.url))`) conta solo se
      // e' un file tracciato: una URL, un esempio o un `./metadata/x.mjs` che
      // importedDataOrPublicPathsIn taglia a `data/x.mjs` non lo sono.
      // `git ls-files` legge l'indice, quindi vale anche nei worktree sparse.
      const read = candidates.size
        ? execFileSync('git', ['ls-files', '--', ...candidates], { encoding: 'utf8' })
          .split('\n').filter(Boolean)
        : [];
      const missing = pathsOutsideSparseRules(job.lines, read, { cone: job.cone });
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

  it.each(jobs.filter((job) => !job.installsDeps).map((job) => [job.jobId, job] as const))(
    '%s: without npm ci the closure imports only relative and node: modules',
    (_jobId, job) => {
      // La chiusura statica segue solo gli specifier relativi: un `import YAML
      // from 'yaml'` in un modulo del crawler passerebbe i controlli sopra e
      // morirebbe con lo stesso ERR_MODULE_NOT_FOUND in un job senza npm ci.
      const bare = job.closure.flatMap(({ rel, src }) =>
        bareStaticSpecifiersIn(src).map((spec) => `${rel} -> ${spec}`));
      expect(
        bare,
        `${FAILURE_TITLE}\n${WORKFLOW}:${job.jobId} non esegue npm ci: import di pacchetto ${bare.join(', ')}`,
      ).toEqual([]);
    },
  );

  it('reports the import that broke run 37114856509 (PR #10941)', () => {
    // Allow-list di tree-inventory com'era prima di #11142, congelata: non e'
    // derivata dal testo attuale del workflow, cosi' una pulizia corretta della
    // lista (per esempio `/scripts/lib/` intera) non fa diventare rosso il replay.
    const before = [
      '/scripts/seo/',
      '/scripts/lib/canonicalExemptions.mjs',
      '/scripts/lib/jobBoardSections.mjs',
      '/scripts/lib/meta-description-extract.mjs',
    ];
    const inventory = jobs.find((job) => job.jobId === 'tree-inventory');
    expect(inventory).toBeDefined();
    expect(uncoveredAllowListCode(before, inventory!.entries, { cone: false }))
      .toContain('scripts/lib/professionLandingsSections.mjs');
    const dataRead = inventory!.closure.flatMap(({ src }) => [...importedDataOrPublicPathsIn(src)]);
    expect(pathsOutsideSparseRules(before, dataRead, { cone: false }))
      .toContain('data/profession-landing-routes.json');
  });
});
