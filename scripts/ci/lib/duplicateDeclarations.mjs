/**
 * duplicateDeclarations.mjs — shared AST-based duplicate top-level binding
 * detector (issue #5212 / #5215).
 *
 * Extracted from `tests/build-plugins-no-duplicate-declarations.test.ts`
 * (which now imports it) so the SAME logic can also run against a synthetic
 * merge-preview tree in `mergePreviewCheck.mjs` — a duplicated copy would be
 * exactly the kind of drift AGENTS.md non-negotiable #6 warns about.
 *
 * Parses the real TypeScript AST (not a regex over text, which would trip
 * over the same identifier inside a nested scope, a string, or a comment)
 * and returns every name bound at MODULE scope — the scope where two
 * independent additions collide into a hard esbuild SyntaxError.
 */
import ts from 'typescript';

/** Every name bound at the TOP LEVEL of a module — the scope that can collide. */
export function topLevelNames(src, fileName) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ESNext, true);
  const names = [];

  const pushBindingName = (name) => {
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

/** Names bound MORE THAN ONCE at module scope in `src` (empty array = clean). */
export function findDuplicateTopLevelNames(src, fileName) {
  const names = topLevelNames(src, fileName);
  const seen = new Set();
  const dupes = new Set();
  for (const n of names) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return [...dupes];
}
