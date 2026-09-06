/**
 * Il gate `tsc --noEmit` MISURA anche in un worktree sparse (#7677).
 *
 * Prima: `check-typecheck-baseline.mjs` decideva con un solo probe
 * (`existsSync('data/blog-articles-data.ts')`, che è un symlink verso
 * `packages/articles/content/`) che il worktree era inutilizzabile e usciva 2
 * PRIMA di invocare `tsc`. Siccome questo repo si lavora quasi sempre in
 * sparse, il typecheck non girava MAI in locale: solo in CI, cioè mai prima di
 * aprire una PR.
 *
 * Questi casi fissano il contratto della modalità degradata. Sono sulle
 * funzioni pure perché il verdetto end-to-end richiede un `tsc` su tutto il
 * programma (~40s) e un worktree senza `packages/articles/content` — la
 * verifica e2e è stata fatta a mano sulla PR, simulando lo sparse: worktree
 * simulato pulito → exit 0, stessa simulazione con una regressione piantata a
 * `services/router.ts:4056` → exit 1 su quel file, `--write-baseline` → exit 2.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifySparseErrors,
  moduleCandidates,
  missingModuleSpecifier,
  trackedButAbsent,
  tsconfigPaths,
  unmeasurableBaselineFiles,
} from '../scripts/ci/lib/typecheck-sparse.mjs';

const ROOT = path.resolve(__dirname, '..');
const GATE_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'check-typecheck-baseline.mjs'), 'utf8');

const err = (file: string, line: number, code: string, msg: string) => ({ file, line, code, msg });
const notFound = (mod: string) => `Cannot find module '${mod}' or its corresponding type declarations.`;

describe('classificazione degli errori tsc in worktree sparse (#7677)', () => {
  it('riconosce lo specificatore di un TS2307 e ignora gli altri codici', () => {
    expect(missingModuleSpecifier(err('a.ts', 1, 'TS2307', notFound('./b')))).toBe('./b');
    expect(missingModuleSpecifier(err('a.ts', 1, 'TS2322', "Type 'string' is not assignable"))).toBeNull();
  });

  it('risolve gli specificatori relativi e quelli con alias di tsconfig', () => {
    expect(moduleCandidates('services/seo/x.ts', './y')).toContain('services/seo/y.ts');
    expect(moduleCandidates('services/seo/x.ts', '../router')).toContain('services/router.ts');
    // L'alias è il caso che rende il modulo necessario: metà del repo importa i
    // dati come `@/data/...`, e senza `paths` restavano 9 falsi rossi.
    const paths = { '@/*': ['*'] };
    expect(moduleCandidates('components/community/JobBoard.tsx', '@/data/blog-articles-data', paths)).toContain(
      'data/blog-articles-data.ts',
    );
    // Uno specificatore bare risolve in node_modules, che lo sparse non tocca.
    expect(moduleCandidates('components/x.tsx', 'react', paths)).toEqual([]);
  });

  it("legge l'alias reale dal tsconfig del repo", () => {
    const paths = tsconfigPaths(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
    expect(moduleCandidates('components/x.tsx', '@/data/blog-articles-data', paths)).toContain(
      'data/blog-articles-data.ts',
    );
  });

  it('un tsconfig illeggibile non fa crashare il gate, degrada a nessun alias', () => {
    expect(tsconfigPaths('{ non json')).toEqual({});
  });

  it('scusa solo i TS2307 verso path tracciati-ma-assenti, non quelli strutturali', () => {
    const missing = new Set(['data/blog-articles-data.ts']);
    const sparseCaused = err('components/x.tsx', 10, 'TS2307', notFound('@/data/blog-articles-data'));
    // `./seoMetadataType` non esiste in NESSUN checkout: è uno dei 20 errori
    // strutturali già registrati nella baseline, e va contato.
    const structural = err('services/seo/seo-blog.ts', 3, 'TS2307', notFound('./seoMetadataType'));
    const { measured, environment } = classifySparseErrors([sparseCaused, structural], missing, {
      paths: { '@/*': ['*'] },
    });
    expect(environment).toEqual([sparseCaused]);
    expect(measured).toEqual([structural]);
  });

  it('declassa gli errori sulla RIGA di un import rotto, mai il resto del file', () => {
    const missing = new Set(['data/blog-articles-data.ts']);
    const unresolved = err('services/seo/articleAuthorUrl.ts', 72, 'TS2307', notFound('@/data/blog-articles-data'));
    const sameLine = err('services/seo/articleAuthorUrl.ts', 72, 'TS2322', "Type 'Promise<Map<unknown, unknown>>' …");
    // La regressione vera che il primo tentativo (declassamento per FILE) si
    // mangiava, uscendo 0 su un errore reale: fail-open, mai.
    const realRegression = err('services/seo/articleAuthorUrl.ts', 4056, 'TS2322', "Type 'string' … 'number'.");
    const { measured, environment, downstream } = classifySparseErrors(
      [unresolved, sameLine, realRegression],
      missing,
      { paths: { '@/*': ['*'] } },
    );
    expect(environment).toEqual([unresolved]);
    expect(downstream).toEqual([sameLine]);
    expect(measured).toEqual([realRegression]);
  });

  it('dichiara i file della baseline che questo worktree non ha materializzato', () => {
    const missing = new Set(['data/blog-articles-data.ts', 'services/routerBlogData.ts']);
    expect(
      unmeasurableBaselineFiles({ 'data/blog-articles-data.ts': 1, 'components/pages/AdminPanel.tsx': 1 }, missing),
    ).toEqual(['data/blog-articles-data.ts']);
  });

  it('conta come assente il symlink che non risolve, non solo il file mancante', () => {
    const missing = trackedButAbsent(ROOT, {
      listTracked: () => ['data/blog-articles-data.ts', 'services/router.ts'],
      // `existsSync` segue il link: un symlink senza target legge `false`.
      exists: (rel) => rel !== 'data/blog-articles-data.ts',
    });
    expect([...missing]).toEqual(['data/blog-articles-data.ts']);
  });
});

describe('contratto del gate in sparse (#7677)', () => {
  it('il probe sparse non è più un abort: accende la modalità degradata', () => {
    expect(GATE_SRC).toMatch(/const sparse = isWorktreeIncomplete\(\);/);
    // Il vecchio comportamento: `if (isWorktreeIncomplete()) { … process.exit(2) }`
    // prima di `runTsc()`. Se tornasse, il typecheck locale tornerebbe a zero.
    expect(GATE_SRC).not.toMatch(/if \(isWorktreeIncomplete\(\)\) \{/);
    expect(GATE_SRC).toContain('classifySparseErrors');
  });

  it('in CI la modalità degradata non si attiva: il gate di merge resta pieno', () => {
    // `tests.yml` fa un checkout sparse anche in CI, ma materializza i target
    // dei symlink file per file. Se quel profilo perdesse un carve-out, senza
    // questo guard il check che governa l'auto-merge misurerebbe in modo
    // degradato senza dirlo: un gate abbassato per errore (non-negotiable #1).
    expect(GATE_SRC).toMatch(/if \(sparse && process\.env\.GITHUB_ACTIONS === 'true'\) \{/);
    const guard = GATE_SRC.slice(GATE_SRC.indexOf("if (sparse && process.env.GITHUB_ACTIONS === 'true')"));
    expect(guard.slice(0, guard.indexOf('const missingTracked'))).toContain('process.exit(2)');
  });

  it('--write-baseline resta vietato in sparse e dice come verificare il blocco', () => {
    // VISION.md: un `blocked:` non scade da solo — il messaggio deve portare il
    // comando con cui si riconferma qui e ora, non solo l'affermazione.
    const guard = GATE_SRC.slice(GATE_SRC.indexOf("if (sparse && args.includes('--write-baseline'))"));
    expect(guard).toContain('git config core.sparseCheckout');
    expect(guard).toContain('ls -l data/blog-articles-data.ts');
    expect(guard.slice(0, guard.indexOf('const output'))).toContain('process.exit(2)');
  });

  it('la baseline si legge in modo sparse-immune, non solo dal disco', () => {
    // Sotto `data/`, che è esattamente ciò che un worktree sparse non ha: senza
    // il fallback su git il gate morirebbe di exit 2 sul file che serve a
    // evitarlo.
    expect(GATE_SRC).toContain('readSiteText');
  });
});
