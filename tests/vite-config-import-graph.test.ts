import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import ts from 'typescript';

/**
 * `main` shipped four dead deploys in a row with this error, on all four
 * `build-locale` jobs at once:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/data'
 *     imported from node_modules/.vite-temp/vite.config.ts.timestamp-*.mjs
 *
 * The mechanism is worth stating precisely, because it is why every other gate
 * we own stayed green while production was down for hours.
 *
 * To read `vite.config.ts`, Vite first bundles it with esbuild into a throwaway
 * `.mjs` under `node_modules/.vite-temp/`. That bundling step happens BEFORE
 * Vite's own `resolve.alias` exists — the config is what defines it — and Vite
 * does not hand esbuild our `tsconfig.json` either. So the `@/*` path mapping
 * is simply not in scope. esbuild does not treat that as an error: an
 * unresolvable bare specifier is left as an EXTERNAL import in the emitted
 * bundle. The failure lands one step later, in Node, when it loads that bundle
 * and looks for a real npm package literally named `@/data`.
 *
 * That single deferral is the whole problem:
 *
 *   - `tsc` is happy — `paths` resolves `@/data/municipalities` fine.
 *   - vitest is happy — its own alias config resolves it fine.
 *   - the app is happy — inside the app graph, Vite resolves `@/` fine.
 *   - only the config-loading step, which no test exercised, dies.
 *
 * So `@/` is CORRECT almost everywhere in this repo (`App.tsx` is full of it),
 * and FATAL in the handful of modules reachable from `vite.config.ts`. Nothing
 * in the source marks that boundary — a service is just a service until the day
 * a build plugin imports it. #5151 is exactly how it happened: it hoisted a
 * shared helper and imported it with `@/` from two services, and in doing so
 * pulled the alias into the config graph for the first time. Last green deploy
 * 20:27:58Z; #5151 merged 20:58:56Z.
 *
 * This test is that missing boundary, enforced. It starts at `vite.config.ts`,
 * walks the import graph the same way esbuild will, and fails on any
 * non-relative specifier that is not a Node builtin or a declared dependency in
 * `package.json` — i.e. on anything that would survive into the emitted bundle
 * as an external import that Node cannot resolve.
 *
 * It parses each file's real AST rather than grepping for `from '@/`, and that
 * is not a stylistic preference: two files in this very graph
 * (`services/seo/imageObjectLd.ts`, `services/textUtils.ts`) document the alias
 * inside a JSDoc block and a line comment. A regex reports both as violations
 * and sends you editing prose. The AST does not see them at all.
 *
 * Companion guards, same family of failure — a PR that is green on its own base
 * and red once merged: #5212 (duplicate top-level symbols), #5217 (the first
 * half of this alias sweep). Root cause tracked in #5215.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = 'vite.config.ts';

/** Extensions esbuild will walk into looking for more imports. */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** `./x.js` in TS-land often means `./x.ts` on disk. */
const JS_TO_TS: ReadonlyArray<readonly [string, string[]]> = [
  ['.js', ['.ts', '.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
];

const NODE_BUILTINS = new Set<string>(module.builtinModules);

function declaredDependencies(): Set<string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

const DEPENDENCIES = declaredDependencies();

/** `@scope/pkg/deep/path` → `@scope/pkg`; `pkg/deep/path` → `pkg`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

/**
 * Every module specifier in a source file, read off the AST.
 *
 * `typeOnly` marks edges esbuild erases before it emits anything (`import type`
 * / `export type`). They cannot break the bundle at runtime, so we do not walk
 * THROUGH them — following a type-only edge into `components/**` would drag the
 * entire React tree into a graph that the config bundle never contains. We do
 * still report a bad specifier found ON one, because it is a latent landmine:
 * the day someone drops the `type` keyword it becomes a broken deploy.
 */
export function moduleSpecifiers(
  src: string,
  fileName: string,
): Array<{ specifier: string; typeOnly: boolean; line: number }> {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ESNext, true);
  const found: Array<{ specifier: string; typeOnly: boolean; line: number }> = [];

  const record = (node: ts.Node, spec: ts.Expression | undefined, typeOnly: boolean): void => {
    if (spec === undefined || !ts.isStringLiteral(spec)) return;
    found.push({
      specifier: spec.text,
      typeOnly,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // A bare `import './side-effect'` has no clause; treat it as a value edge.
      record(node, node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      record(node, node.moduleSpecifier, node.isTypeOnly);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node, node.moduleReference.expression, false);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) record(node, node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return found;
}

/** Resolve a relative specifier to a real file on disk, esbuild-style. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);

  const asFile = (p: string): string | undefined =>
    fs.existsSync(p) && fs.statSync(p).isFile() ? p : undefined;

  const direct = asFile(base);
  if (direct !== undefined) return direct;

  for (const ext of CODE_EXTENSIONS) {
    const hit = asFile(base + ext);
    if (hit !== undefined) return hit;
  }
  for (const [from, candidates] of JS_TO_TS) {
    if (!base.endsWith(from)) continue;
    for (const to of candidates) {
      const hit = asFile(base.slice(0, -from.length) + to);
      if (hit !== undefined) return hit;
    }
  }
  for (const ext of CODE_EXTENSIONS) {
    const hit = asFile(path.join(base, `index${ext}`));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export interface Violation {
  file: string;
  specifier: string;
  line: number;
  typeOnly: boolean;
}

export interface GraphWalk {
  files: string[];
  violations: Violation[];
}

/**
 * Walk the import graph from `entry`, collecting every non-relative specifier
 * that Node would not be able to resolve out of the emitted config bundle.
 */
export function walkConfigGraph(entryAbs: string): GraphWalk {
  const visited = new Set<string>();
  const violations: Violation[] = [];
  const queue: string[] = [entryAbs];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    let src: string;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const rel = path.relative(REPO_ROOT, file);
    for (const { specifier, typeOnly, line } of moduleSpecifiers(src, rel)) {
      if (isRelative(specifier)) {
        if (typeOnly) continue;
        const target = resolveRelative(file, specifier);
        if (target !== undefined && CODE_EXTENSIONS.includes(path.extname(target))) {
          queue.push(target);
        }
        continue;
      }
      const name = packageNameOf(specifier);
      const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
      if (NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(packageNameOf(bare))) continue;
      if (DEPENDENCIES.has(name)) continue;
      violations.push({ file: rel, specifier, line, typeOnly });
    }
  }

  return {
    files: [...visited].map((f) => path.relative(REPO_ROOT, f)).sort(),
    violations: violations.sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    ),
  };
}

const WALK = walkConfigGraph(path.join(REPO_ROOT, ENTRY));

describe('vite.config.ts import graph resolves without Vite aliases', () => {
  /**
   * The trap that cost hours during the incident itself: on a sparse checkout,
   * unresolvable `../data/*` imports silently TRUNCATE the graph, so the walk
   * finishes clean while never having visited the file that was broken. A green
   * result is only meaningful if the graph is the real one.
   */
  it('walks a complete graph (guard against a truncated, vacuous pass)', () => {
    expect(WALK.files.length).toBeGreaterThan(250);
    // The chain that actually broke production, pinned end to end.
    expect(WALK.files).toContain('vite.config.ts');
    expect(WALK.files).toContain('build-plugins/jobsSeoPagesPlugin.ts');
    expect(WALK.files).toContain('services/employerBrands.ts');
    expect(WALK.files).toContain('services/avgRentEstimate.ts');
    expect(WALK.files).toContain('services/relatedSearchClusters.ts');
  });

  it('has no non-relative import that Node cannot resolve from the config bundle', () => {
    const detail = WALK.violations
      .map(
        (v) =>
          `  ${v.file}:${v.line}  ${v.specifier}${v.typeOnly ? '  (type-only — erased today, fatal the day the `type` keyword goes)' : ''}`,
      )
      .join('\n');
    expect(
      WALK.violations,
      'These specifiers are reachable from vite.config.ts. Vite bundles that config with esbuild\n' +
        'BEFORE its own aliases exist and WITHOUT our tsconfig, so each one survives into\n' +
        'node_modules/.vite-temp/*.mjs as an external import and Node dies with\n' +
        "ERR_MODULE_NOT_FOUND on a package that does not exist. Every build-locale job fails.\n" +
        'Fix: use a relative specifier — it is correct in both contexts. (`@/` stays fine\n' +
        'everywhere OUTSIDE this graph, where Vite is the one doing the resolving.)\n' +
        `${detail}\n`,
    ).toEqual([]);
  });
});

describe('the detector actually catches the shape that broke main (not vacuous)', () => {
  it('flags the exact import that took production down', () => {
    const broken = "import { MUNICIPALITIES } from '@/data/municipalities';";
    const specs = moduleSpecifiers(broken, 'services/avgRentEstimate.ts');
    expect(specs).toEqual([{ specifier: '@/data/municipalities', typeOnly: false, line: 1 }]);
    expect(NODE_BUILTINS.has('@/data')).toBe(false);
    expect(DEPENDENCIES.has(packageNameOf('@/data/municipalities'))).toBe(false);
  });

  it('flags a type-only alias too, and marks it as such', () => {
    const specs = moduleSpecifiers(
      "import type { Municipality } from '@/data/municipalities';",
      'x.ts',
    );
    expect(specs).toEqual([{ specifier: '@/data/municipalities', typeOnly: true, line: 1 }]);
  });

  it('catches re-exports, dynamic import and require, not just static imports', () => {
    const src = [
      "export { a } from '@/services/a';",
      "export * from '@/services/b';",
      "const c = await import('@/services/c');",
      "const d = require('@/services/d');",
    ].join('\n');
    expect(moduleSpecifiers(src, 'x.ts').map((s) => s.specifier)).toEqual([
      '@/services/a',
      '@/services/b',
      '@/services/c',
      '@/services/d',
    ]);
  });

  it('does NOT flag an alias written inside a comment (why this is an AST walk, not a regex)', () => {
    // Both shapes are real, and both are in this graph today:
    // services/seo/imageObjectLd.ts documents the alias in a JSDoc example, and
    // services/textUtils.ts mentions it in a line comment. A regex fails here.
    const src = [
      '/**',
      " *   import { imageObjectLd } from '@/services/seo/imageObjectLd';",
      ' */',
      "// `from '@/services/textUtils'` imports keep working.",
      "import { real } from './real';",
    ].join('\n');
    expect(moduleSpecifiers(src, 'x.ts').map((s) => s.specifier)).toEqual(['./real']);
  });

  it('does not flag builtins, node:-prefixed builtins or declared dependencies', () => {
    for (const ok of ['node:fs', 'fs', 'node:fs/promises', 'path', 'vite', 'sharp']) {
      const bare = ok.startsWith('node:') ? ok.slice(5) : ok;
      const allowed =
        NODE_BUILTINS.has(bare) ||
        NODE_BUILTINS.has(packageNameOf(bare)) ||
        DEPENDENCIES.has(packageNameOf(ok));
      expect(allowed, `${ok} should be allowed`).toBe(true);
    }
  });

  it('maps subpath imports back to the package that must be declared', () => {
    expect(packageNameOf('@vitejs/plugin-react')).toBe('@vitejs/plugin-react');
    expect(packageNameOf('lucide-react/icons/x')).toBe('lucide-react');
    // The alias is what makes this bite: `@/data/municipalities` looks to Node
    // exactly like a scoped package `@/data` — which is what it reports.
    expect(packageNameOf('@/data/municipalities')).toBe('@/data');
  });
});
