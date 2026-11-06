import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { build, type Metafile, type Plugin } from 'esbuild';

/**
 * Deploy fermo dal 2026-10-03 16:59Z: i quattro `build-locale` morivano in
 * ~20 s con `Cannot find package '@/data' imported from
 * node_modules/.vite-temp/vite.config.ts.timestamp-*.mjs`. La PR 11327 aveva
 * fatto importare a `build-plugins/shared/authorEditorial.ts` il modulo
 * `services/seo/seo-authors.ts`, che importava `@/data/authors`.
 *
 * Il gemello `tests/vite-config-import-graph.test.ts` ricostruisce il grafo con
 * un walker AST proprio. Questo test fa invece quello che fa Vite:
 * `bundleConfigFile` impacchetta `vite.config.ts` con esbuild (bundle, node,
 * esm) e il suo plugin `externalize-deps` rende esterno OGNI specifier non
 * relativo prima che entrino in gioco `paths` di tsconfig o `resolve.alias`.
 * `--packages=external` da solo NON basta a riprodurlo: esbuild applica i
 * `paths` di tsconfig prima di decidere cosa e' un pacchetto, risolve `@/` e
 * il test passerebbe sul main rotto. Da qui il plugin qui sotto.
 *
 * Due adattamenti, entrambi dichiarati:
 * - gli `import(\`./locales/blog-body/${l}/${id}.ts\`)` con template diventano
 *   glob che esbuild impacchetta per intero (26k moduli dati `export default`,
 *   senza import): li neutralizziamo, altrimenti il test costa minuti e nei
 *   worktree sparse fallisce sulla directory assente;
 * - un relativo che non esiste su disco (worktree sparse senza il corpus)
 *   resta esterno e viene annotato; in CI il checkout e' pieno e l'elenco deve
 *   essere vuoto, altrimenti un pezzo di grafo non sarebbe stato giudicato.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = 'vite.config.ts';

/** Prefissi alias: `paths` di tsconfig e chiavi di `resolve.alias` del config. */
export function aliasPrefixes(): string[] {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const fromTsconfig = Object.keys(tsconfig.compilerOptions?.paths ?? {}).map((key) => key.replace(/\*$/, ''));
  const configSrc = fs.readFileSync(path.join(REPO_ROOT, ENTRY), 'utf8');
  const aliasBlock = /\balias:\s*\{([^}]*)\}/.exec(configSrc)?.[1] ?? '';
  const fromConfig = [...aliasBlock.matchAll(/['"]([^'"]+)['"]\s*:/g)].map((m) => `${m[1].replace(/\/$/, '')}/`);
  return [...new Set([...fromTsconfig, ...fromConfig])].sort();
}

const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function existsAsModule(base: string): boolean {
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isFile(base)) return true;
  if (CODE_EXT.some((ext) => isFile(base + ext))) return true;
  if (/\.(?:m|c)?js$/.test(base) && ['.ts', '.tsx', '.mts', '.cts'].some((ext) => isFile(base.replace(/\.(?:m|c)?js$/, ext)))) return true;
  return CODE_EXT.some((ext) => isFile(path.join(base, `index${ext}`)));
}

function viteConfigBundlerMimic(missing: string[]): Plugin {
  return {
    name: 'vite-config-bundler-mimic',
    setup(b) {
      // Come `externalize-deps` di Vite: filtro `^[^.#]`, assoluti esclusi.
      b.onResolve({ filter: /^[^.#/]/ }, (args) =>
        args.kind === 'entry-point' ? undefined : { path: args.path, external: true },
      );
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (existsAsModule(path.resolve(args.resolveDir, args.path))) return undefined;
        missing.push(`${path.relative(REPO_ROOT, args.importer)} -> ${args.path}`);
        return { path: args.path, external: true };
      });
      b.onLoad({ filter: /\.(?:[mc]?[jt]sx?)$/ }, (args) => {
        if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
        const src = fs.readFileSync(args.path, 'utf8');
        const templateImport = /import\(\s*`[^`]*\$\{[^`]*`\s*\)/g;
        if (!templateImport.test(src)) return undefined;
        const ext = path.extname(args.path).slice(1);
        const loader = ext.startsWith('t') || ext.startsWith('mt') || ext.startsWith('ct')
          ? (ext.endsWith('x') ? 'tsx' : 'ts')
          : (ext.endsWith('x') ? 'jsx' : 'js');
        return { contents: src.replace(templateImport, 'Promise.resolve({})'), loader, resolveDir: path.dirname(args.path) };
      });
    },
  };
}

export interface AliasLeak {
  importer: string;
  specifier: string;
}

export async function bundleLikeVite(entry: { file: string } | { contents: string }): Promise<{
  metafile: Metafile;
  missing: string[];
  leaks: AliasLeak[];
}> {
  const missing: string[] = [];
  const result = await build({
    ...('file' in entry
      ? { entryPoints: [path.join(REPO_ROOT, entry.file)] }
      : { stdin: { contents: entry.contents, loader: 'ts', resolveDir: REPO_ROOT, sourcefile: 'stdin.ts' } }),
    absWorkingDir: REPO_ROOT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [viteConfigBundlerMimic(missing)],
  });
  const prefixes = aliasPrefixes();
  const leaks: AliasLeak[] = [];
  for (const [importer, input] of Object.entries(result.metafile.inputs)) {
    for (const imp of input.imports) {
      if (imp.external && prefixes.some((prefix) => imp.path.startsWith(prefix))) {
        leaks.push({ importer, specifier: imp.path });
      }
    }
  }
  return { metafile: result.metafile, missing, leaks };
}

describe('vite.config.ts impacchettato come lo impacchetta Vite', () => {
  it('legge gli alias dal config e da tsconfig, @/ incluso', () => {
    expect(aliasPrefixes()).toContain('@/');
  });

  it('nessun import esterno del grafo usa un alias dell\'app', async () => {
    const { metafile, missing, leaks } = await bundleLikeVite({ file: ENTRY });
    const inputs = Object.keys(metafile.inputs);
    // Non vacuo: il grafo vero e' di centinaia di moduli e contiene la catena
    // che ha fermato il deploy del 03-10.
    expect(inputs.length).toBeGreaterThan(250);
    expect(inputs).toContain('build-plugins/staticPagesPlugin.ts');
    expect(inputs).toContain('build-plugins/shared/authorEditorial.ts');
    expect(inputs).toContain('services/seo/seo-authors.ts');
    if (process.env.CI) expect(missing, 'checkout pieno: nessun relativo deve mancare').toEqual([]);
    expect(
      leaks,
      'Questi import con alias sono raggiungibili da vite.config.ts. Vite impacchetta il config con\n' +
        'esbuild lasciando esterni gli specifier non relativi: Node li cerca come pacchetti e ogni\n' +
        'build-locale muore con ERR_MODULE_NOT_FOUND. Usa un import relativo, oppure togli il modulo\n' +
        'dell\'app dal grafo del plugin.\n' +
        leaks.map((leak) => `  ${leak.importer} -> ${leak.specifier}`).join('\n'),
    ).toEqual([]);
  }, 60_000);

  it('il rilevatore vede la forma che ha rotto il deploy (non vacuo)', async () => {
    const { leaks } = await bundleLikeVite({
      contents: "import { AUTHORS } from '@/data/authors';\nexport default AUTHORS;\n",
    });
    expect(leaks).toEqual([{ importer: 'stdin.ts', specifier: '@/data/authors' }]);
  });
});
