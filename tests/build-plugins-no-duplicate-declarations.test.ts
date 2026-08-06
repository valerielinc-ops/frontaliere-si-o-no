import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * `main` shipped a duplicate-symbol SyntaxError.
 *
 * `build-plugins/constants.ts` carried TWO `const ROBOTS_META_TAG_RE` and TWO
 * `export function replaceRobotsMeta`: two PRs added the same helper to the
 * same file independently. The first one's docblock even predicted it —
 *
 *   "NOTE: PR #5170 (#5001) introduces an identical helper in this same file …
 *    Whichever lands second should drop its copy and keep one definition"
 *
 * — and both landed and neither dropped it, because a note in a comment is not
 * a merge gate. The result is not a lint nit: a duplicate top-level binding is
 * a hard SyntaxError, so esbuild refuses the module, every vitest file that
 * imports it dies at transform time with a message that names the symbol and
 * not the PR, and the SSG build cannot run at all. Nothing ships.
 *
 * This is the gate the comment should have been. It parses each file's real
 * AST (not a regex over text, which would trip over the same identifier inside
 * a nested scope, a string, or a comment) and asserts that no top-level name is
 * declared twice.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIRS = ['build-plugins', 'build-plugins/shared'];

function sourceFilesUnder(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.mts')))
    .filter((e) => !e.name.endsWith('.d.ts'))
    .map((e) => path.join(dir, e.name));
}

/** Every name bound at the TOP LEVEL of a module — the scope that can collide. */
function topLevelNames(src: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ESNext, true);
  const names: string[] = [];

  const pushBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.push(name.text);
      return;
    }
    // Destructuring at module scope: `const { a, b } = …`
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) pushBindingName(el.name);
    }
  };

  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) pushBindingName(decl.name);
    } else if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.name !== undefined
    ) {
      names.push(stmt.name.text);
    } else if (ts.isEnumDeclaration(stmt)) {
      names.push(stmt.name.text);
    }
    // Interfaces and type aliases are erased and legally merge — not collisions.
  }
  return names;
}

const FILES = PLUGIN_DIRS.flatMap(sourceFilesUnder);

describe('build-plugins declare each top-level name exactly once', () => {
  it('finds a non-trivial number of plugin sources to check (guard against a vacuous pass)', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES).toContain('build-plugins/constants.ts');
  });

  it.each(FILES)('%s has no duplicate top-level declaration', (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const names = topLevelNames(src, rel);
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) dupes.add(n);
      seen.add(n);
    }
    expect(
      [...dupes],
      `${rel} declares these names twice at module scope — esbuild rejects the whole module ` +
        `(SyntaxError), so every importer and the SSG build break: ${[...dupes].join(', ')}`,
    ).toEqual([]);
  });

  it('the detector actually catches the shape that broke main (not vacuous)', () => {
    const broken = [
      "const ROBOTS_META_TAG_RE = /a/i;",
      "export function replaceRobotsMeta(h: string): string { return h; }",
      "const ROBOTS_META_TAG_RE = /a/i;",
      "export function replaceRobotsMeta(h: string): string { return h; }",
    ].join('\n');
    const names = topLevelNames(broken, 'broken.ts');
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes.sort()).toEqual(['ROBOTS_META_TAG_RE', 'replaceRobotsMeta']);
  });

  it('does not flag the same identifier reused inside a nested scope', () => {
    const fine = [
      'const tag = 1;',
      'export function a(): number { const tag = 2; return tag; }',
      'export function b(): number { const tag = 3; return tag; }',
    ].join('\n');
    expect(topLevelNames(fine, 'fine.ts')).toEqual(['tag', 'a', 'b']);
  });

  it('does not flag overload signatures or merged interfaces', () => {
    const overloads = [
      'export interface Opts { a?: number }',
      'export interface Opts { b?: number }',
      'type T = string;',
    ].join('\n');
    // Interfaces/types are erased and legally merge — they must not appear.
    expect(topLevelNames(overloads, 'ov.ts')).toEqual([]);
  });
});

describe('constants.ts keeps exactly one robots-meta helper', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'build-plugins/constants.ts'), 'utf8');
  const names = topLevelNames(src, 'constants.ts');

  it.each(['ROBOTS_META_TAG_RE', 'replaceRobotsMeta'])('declares %s once', (name) => {
    expect(names.filter((n) => n === name)).toHaveLength(1);
  });

  it('still exports a working replaceRobotsMeta', async () => {
    const mod = await import('../build-plugins/constants');
    expect(mod.replaceRobotsMeta('<html><head><meta name="robots" content="index,follow"></head>', 'noindex,follow'))
      .toContain('content="noindex,follow"');
    // Inserts when absent rather than silently doing nothing.
    expect(mod.replaceRobotsMeta('<html><head></head>', 'noindex,follow'))
      .toContain('<meta name="robots" content="noindex,follow">');
  });
});
