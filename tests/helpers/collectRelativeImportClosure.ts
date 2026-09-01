import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Recursively walks the relative-import graph of `entrypoint`, returning the
 * sorted, deduped set of relative runtime paths it (transitively) reaches.
 *
 * Static `import`/`export ... from './x'` are parsed without resolving them
 * through the module loader — this is a test tool, not a bundler. A dynamic
 * `import('./x')` with a literal relative specifier is walked the same way,
 * including when it has an import-options argument. A dynamic `import(expr)`
 * whose specifier is NOT a string literal (e.g. a computed path) cannot be
 * resolved statically at all — rather than
 * silently under-reporting the closure in that case, this throws so the
 * caller fails loudly and points at the file that needs a manual look.
 */
export function collectRelativeImportClosure(repoRoot: string, entrypoint: string): string[] {
  const pending = [entrypoint];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const runtimePath = pending.pop()!;
    if (visited.has(runtimePath)) continue;
    visited.add(runtimePath);
    const source = fs.readFileSync(path.join(repoRoot, runtimePath), 'utf8');
    const sourceFile = ts.createSourceFile(runtimePath, source, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node) => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
          throw new Error(
            `collectRelativeImportClosure: ${runtimePath} contains a dynamic import() with a ` +
            'non-literal specifier — this cannot be resolved statically. Update the closure ' +
            'walk (or the module) before trusting this test.',
          );
        }
        specifier = argument.text;
      }

      if (specifier?.startsWith('.')) {
        pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(runtimePath), specifier)));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...visited].sort();
}
