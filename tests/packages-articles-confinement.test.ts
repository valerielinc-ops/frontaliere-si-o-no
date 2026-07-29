import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Confinement test — issue #4881 Fase 6, Step 3.
 *
 * `packages/articles` is meant to become a standalone, separately
 * installable package (Step 4: `npm install github:.../frontaliere-articles`).
 * That only works if it NEVER reaches outside its own directory for
 * anything except Node builtins and its own declared dependencies
 * (`packages/articles/package.json`) — everything else must come through
 * `SiteShellContract` (see `packages/articles/engine/siteShell.ts`).
 *
 * Import specifiers are extracted via the real TypeScript AST (not a text
 * regex): the package's body-copy corpus (`content/blog-body*`, ~14k files
 * of natural-language article text) can contain arbitrary prose — including
 * strings that look like `from 'somewhere'` in running English/French/
 * German/Italian sentences — which would produce false positives from any
 * regex scan naive enough to search raw file text. Parsing the real AST and
 * reading only genuine `ImportDeclaration` / `ExportDeclaration` module
 * specifiers and dynamic `import()`/`require()` call arguments sidesteps
 * that risk entirely: prose can never masquerade as a parsed import node.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', 'packages', 'articles');

// Node builtins actually used in the package (see engine/ogPagesPlugin.ts,
// engine/newsTickerDataPlugin.ts — both prefixed `node:` and legacy
// unprefixed `path`/`fs` forms are in use).
const NODE_BUILTINS = new Set(['fs', 'path', 'node:fs', 'node:path']);

// Bare (non-relative) package deps the engine is allowed to import — must
// also be declared in packages/articles/package.json so a standalone
// consumer's `npm install` resolves them. Currently only `vite`, and only
// for its `Plugin` TYPE (erased at build time, zero runtime footprint) —
// see the `import type { Plugin } from 'vite'` in ogPagesPlugin.ts,
// blogContextualLinksPlugin.ts, newsTickerDataPlugin.ts.
const ALLOWED_EXTERNAL_DEPS = new Set(['vite']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface ImportHit {
  specifier: string;
  isTypeOnly: boolean;
}

/** Real import/export/dynamic-import/require specifiers, via the TS AST. */
function extractImports(filePath: string, source: string): ImportHit[] {
  const scriptKind = /\.(mjs|js)$/.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false, scriptKind);
  const hits: ImportHit[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      hits.push({ specifier: node.moduleSpecifier.text, isTypeOnly: !!node.importClause?.isTypeOnly });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      hits.push({ specifier: node.moduleSpecifier.text, isTypeOnly: !!node.isTypeOnly });
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const firstArg = node.arguments[0];
      if ((isDynamicImport || isRequire) && firstArg && ts.isStringLiteral(firstArg)) {
        hits.push({ specifier: firstArg.text, isTypeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}

describe('packages/articles confinement (issue #4881 Fase 6, Step 3)', () => {
  const files = walk(PACKAGE_ROOT);

  it('walks a non-trivial number of package files (sanity-check the walker)', () => {
    // Guards against a silently-empty walk (e.g. PACKAGE_ROOT typo) making
    // the confinement check below vacuously pass.
    expect(files.length).toBeGreaterThan(1000);
  });

  it('never imports anything outside packages/articles/, and every bare specifier is declared/allowed', () => {
    const violations: string[] = [];

    for (const file of files) {
      const dir = path.dirname(file);
      const source = fs.readFileSync(file, 'utf-8');
      const imports = extractImports(file, source);

      for (const { specifier, isTypeOnly } of imports) {
        if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)) continue;

        if (!specifier.startsWith('.')) {
          if (!ALLOWED_EXTERNAL_DEPS.has(specifier)) {
            violations.push(
              `${path.relative(PACKAGE_ROOT, file)}: bare import '${specifier}'` +
                `${isTypeOnly ? ' (type-only)' : ''} is not a Node builtin and not in` +
                ` ALLOWED_EXTERNAL_DEPS — declare it in packages/articles/package.json` +
                ` and add it here, or remove it (confinement).`,
            );
          }
          continue;
        }

        const resolved = path.normalize(path.join(dir, specifier));
        const isInside = resolved === PACKAGE_ROOT || resolved.startsWith(PACKAGE_ROOT + path.sep);
        if (!isInside) {
          violations.push(
            `${path.relative(PACKAGE_ROOT, file)}: imports '${specifier}' which resolves` +
              ` OUTSIDE packages/articles/ (${resolved}) — route through SiteShellContract instead.`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
