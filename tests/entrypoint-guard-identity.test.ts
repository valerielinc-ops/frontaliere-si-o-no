/**
 * Guard di entrypoint: identità del modulo, non suffisso del path (#7292).
 *
 * Il difetto: `if (process.argv[1]?.endsWith('followup-drainer.mjs')) main()`
 * non chiede «questo modulo è l'entrypoint?», chiede «il path dell'entrypoint
 * finisce con questa stringa?». Sono la stessa domanda solo finché il modulo ha
 * UN solo consumatore. Da quando `scripts/prospect-promote.mjs` importa il
 * drainer per `canPushWorkflows()`, il guard smette di essere teorico: un
 * entrypoint qualunque il cui `argv[1]` finisca con `followup-drainer.mjs`
 * (wrapper, copia, runner che risolve un altro path) fa partire un `main()` che
 * NON è read-only — scrive label e commenti su issue e PR reali.
 *
 * I due test qui sotto sono l'osservatore del comportamento, non della forma:
 *
 *   1. un entrypoint DIVERSO il cui basename coincide non deve eseguire il CLI
 *      (era il falso positivo del suffisso);
 *   2. l'invocazione via symlink deve continuare a eseguirlo — `argv[1]` è il
 *      link e `import.meta.url` il file reale, quindi il confronto canonico
 *      senza `realpathSync` avrebbe rotto un caso che il vecchio guard copriva.
 *
 * `classify-issue.mjs` fa da campione della famiglia: è un modulo con un CLI
 * corto e deterministico (stampa JSON su stdout), importato in produzione da
 * `triage-sweep.mjs` e da `followup-drainer.mjs`. Il terzo test tiene la
 * famiglia allineata su tutti i moduli che portavano un guard a suffisso, così
 * il prossimo che ne scrive uno viene fermato qui invece che da un `main()`
 * partito per sbaglio in CI.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SAMPLE = path.join(ROOT, 'scripts/lib/classify-issue.mjs');

const runNode = (entry: string, args: string[]) =>
  execFileSync(process.execPath, [entry, ...args], { encoding: 'utf8' });

describe('guard di entrypoint canonico (#7292)', () => {
  it('non esegue il CLI da un entrypoint diverso col medesimo basename', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'entrypoint-guard-'));
    // Stesso NOME FILE, path diverso: `endsWith('classify-issue.mjs')` è true,
    // l'identità del modulo no.
    const impostor = path.join(dir, 'classify-issue.mjs');
    writeFileSync(impostor, `import ${JSON.stringify(SAMPLE)};\n`);

    const out = runNode(impostor, ['crawler rotto', '[]']);

    expect(out).toBe('');
  });

  it('esegue il CLI quando invocato attraverso un symlink al modulo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'entrypoint-guard-'));
    const link = path.join(dir, 'classify-issue.mjs');
    symlinkSync(SAMPLE, link);

    const out = runNode(link, ['crawler rotto', '[]']);

    // Il punto è che il CLI sia PARTITO: la categoria esatta la coprono i test
    // di `classify-issue`, qui conta solo che il guard non l'abbia zittito.
    expect(out).not.toBe('');
    expect(JSON.parse(out)).toHaveProperty('category');
  });

  it('nessun modulo della famiglia guarda il suffisso di argv[1]', () => {
    // Ogni modulo che portava un guard di entrypoint a suffisso. I primi sono
    // quelli con un secondo consumatore in-repo — lì il difetto è attivo oggi;
    // gli altri sono i gemelli con lo stesso idioma, portati nello stesso giro
    // perché la classe si chiude intera o non si chiude (AGENTS.md #6).
    const family = [
      'scripts/analyze-webcam-frame.mjs',
      'scripts/audit-article-corpus-drift.mjs',
      'scripts/audit-bfs-depth.mjs',
      'scripts/audit-breadcrumb-coverage.mjs',
      'scripts/audit-dist-multi.mjs',
      'scripts/audit-duplicate-meta-description.mjs',
      'scripts/audit-duplicate-structured-data.mjs',
      'scripts/audit-faqpage-validity.mjs',
      'scripts/audit-footer-root-presence.mjs',
      'scripts/audit-h1-title-duplicates.mjs',
      'scripts/audit-image-object-license.mjs',
      'scripts/audit-jsonld-no-nested-scripts.mjs',
      'scripts/audit-link-anchor-text.mjs',
      'scripts/audit-no-literal-markdown.mjs',
      'scripts/audit-page-weight.mjs',
      'scripts/audit-salary-landing-template.mjs',
      'scripts/audit-single-h1-per-page.mjs',
      'scripts/audit-text-html-ratio.mjs',
      'scripts/audit-title-length.mjs',
      'scripts/audit-title-no-disambig-hash.mjs',
      'scripts/build-austrian-border-municipalities.mjs',
      'scripts/build-fiscal-municipalities.mjs',
      'scripts/build-french-border-municipalities.mjs',
      'scripts/build-german-border-municipalities.mjs',
      'scripts/build-liechtenstein-municipalities.mjs',
      'scripts/ci/assert-dist-complete.mjs',
      'scripts/ci/auto-merge-eval.mjs',
      'scripts/ci/followup-drainer.mjs',
      'scripts/lib/classify-issue.mjs',
      'scripts/lib/github-issue-creator.mjs',
      'scripts/lib/pr-body-closes-check.mjs',
      'scripts/lib/shared-jobs-crawler.mjs',
      'scripts/notify-article-search-engines.mjs',
      'scripts/publish-edge-files.mjs',
      'scripts/reconcile-duplicate-stable-id-jobs.mjs',
      'scripts/rerender-article-corpus.mjs',
      'scripts/submit-indexnow-batch.mjs',
    ];

    const offenders = family.filter((rel) => {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      const suffixGuard = /process\.argv\[1\][^\n]*\.endsWith\(|import\.meta\.url\.endsWith\(/;
      const canonical = /import\.meta\.url === pathToFileURL\((?:fs\.)?realpathSync\(process\.argv\[1\]\)\)\.href/;
      return suffixGuard.test(src) || !canonical.test(src);
    });

    expect(offenders).toEqual([]);
  });
});
