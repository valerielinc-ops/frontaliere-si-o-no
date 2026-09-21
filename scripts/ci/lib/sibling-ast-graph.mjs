/**
 * Small, in-process AST and symbol layer for the sibling checker.
 *
 * This is deliberately not a persistent knowledge graph. It parses the files
 * involved in one check with the TypeScript compiler already used by the repo,
 * keeps only structural facts needed by the candidate sweep, and resolves
 * direct local imports so equal names from different modules do not look like
 * the same symbol.
 */
import ts from 'typescript';
import path from 'node:path';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function scriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function moduleTokens(value) {
  const tokens = new Set([value]);
  for (const match of String(value).matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    tokens.add(match[0]);
  }
  for (const match of String(value).matchAll(/[a-z0-9]+(?:-[a-z0-9]+)+/g)) {
    tokens.add(match[0]);
  }
  return [...tokens];
}

function inLineRanges(sourceFile, node, ranges) {
  if (!ranges || ranges.length === 0) return true;
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(
    Math.max(node.getStart(sourceFile), node.getEnd() - 1),
  ).line + 1;
  return ranges.some((range) => start <= range.end && end >= range.start);
}

function isImportOrExportSpecifier(node) {
  return ts.isImportSpecifier(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node) ||
    ts.isExportSpecifier(node);
}

function declarationName(node) {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent)) &&
    parent.name === node
  ) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  return false;
}

function expressionPath(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const parent = expressionPath(node.expression);
    return parent ? `${parent}.${node.name.text}` : node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const parent = expressionPath(node.expression);
    if (parent && ts.isStringLiteralLike(node.argumentExpression)) {
      return `${parent}.${node.argumentExpression.text}`;
    }
  }
  return null;
}

function parentRole(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return 'member';
  if (ts.isCallExpression(parent) && parent.expression === node) return 'call';
  if (declarationName(node)) return 'declaration';
  return 'reference';
}

function moduleKey(fileName, specifier, fileSet) {
  const resolved = resolveRelativeModule(fileName, specifier, fileSet);
  return resolved ?? `external:${specifier}`;
}

/**
 * Resolve a relative TypeScript/JavaScript import against the tracked files
 * present in the revision being inspected. Bare package imports stay external
 * and are compared by their literal specifier.
 */
export function resolveRelativeModule(fileName, specifier, fileSet = new Set()) {
  let normalized;
  if (specifier.startsWith('@/')) {
    // The site tsconfig maps `@/*` to the repository root. Resolve this one
    // project alias without loading a full compiler program.
    normalized = path.posix.normalize(specifier.slice(2));
  } else {
    if (!specifier.startsWith('.')) return null;
    normalized = path.posix.normalize(
      path.posix.join(path.posix.dirname(fileName), specifier),
    );
  }
  const candidates = [normalized];
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${normalized}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${normalized}/index${extension}`);
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

/**
 * Parse unified-diff hunk headers into one-based line ranges for either side.
 */
export function diffLineRanges(diffText, side = 'new') {
  const ranges = [];
  for (const line of String(diffText).split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(side === 'old' ? match[1] : match[3]);
    const count = Number(side === 'old' ? (match[2] ?? 1) : (match[4] ?? 1));
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

/**
 * Return AST facts for a source file. `lineRanges` limits facts to changed
 * lines; leaving it undefined parses the whole file for candidate matching.
 */
export function collectAstFacts(fileName, source, { lineRanges, files = new Set() } = {}) {
  const sourceFile = ts.createSourceFile(
    fileName,
    String(source ?? ''),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const imports = new Map();
  const facts = [];
  const seen = new Set();

  const addFact = (kind, key, node, extra = {}) => {
    if (!inLineRanges(sourceFile, node, lineRanges)) return;
    const role = extra.role ?? kind;
    const binding = extra.binding ?? null;
    const bindingKey = binding ? `${binding.module}#${binding.imported}` : '';
    const dedupe = `${kind}|${key}|${role}|${bindingKey}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    facts.push({
      kind,
      key,
      role,
      tokens: extra.tokens ?? moduleTokens(key),
      binding,
    });
  };

  const registerImportBinding = (local, imported, module) => {
    imports.set(local, { module, imported });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const module = moduleKey(fileName, specifier, files);
      addFact('import', module, statement, {
        role: 'import',
        tokens: moduleTokens(specifier),
      });
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) registerImportBinding(clause.name.text, 'default', module);
      const namedBindings = clause.namedBindings;
      if (!namedBindings) continue;
      if (ts.isNamespaceImport(namedBindings)) {
        registerImportBinding(namedBindings.name.text, '*', module);
      } else if (ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          registerImportBinding(
            element.name.text,
            element.propertyName?.text ?? element.name.text,
            module,
          );
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const module = moduleKey(fileName, specifier, files);
      addFact('import', module, statement, {
        role: 'reexport',
        tokens: moduleTokens(specifier),
      });
    }
  }

  const factBinding = (name) => imports.get(name) ?? null;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const key = expressionPath(node.expression);
      if (key) {
        const binding = ts.isIdentifier(node.expression)
          ? factBinding(node.expression.text)
          : null;
        addFact('call', key, node, {
          role: 'call',
          binding,
          tokens: moduleTokens(key),
        });
      }
    }

    if (ts.isPropertyAccessExpression(node) && !ts.isCallExpression(node.parent)) {
      addFact('member', node.name.text, node.name, {
        role: 'member',
        binding: factBinding(node.name.text),
        tokens: moduleTokens(node.name.text),
      });
    }

    if (ts.isStringLiteralLike(node) &&
        !ts.isImportDeclaration(node.parent) &&
        !ts.isExportDeclaration(node.parent)) {
      addFact('literal', node.text, node, {
        role: 'literal',
        tokens: moduleTokens(node.text),
      });
    }

    if (ts.isIdentifier(node) && !isImportOrExportSpecifier(node.parent)) {
      const role = parentRole(node);
      addFact('identifier', node.text, node, {
        role,
        binding: factBinding(node.text),
        tokens: [node.text],
      });
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return facts;
}

export function factsContainingToken(facts, token) {
  return facts.filter((fact) => fact.tokens.includes(token));
}

function compatibleBinding(changed, candidate) {
  if (!changed.binding || !candidate.binding) return true;
  return changed.binding.module === candidate.binding.module &&
    changed.binding.imported === candidate.binding.imported;
}

/**
 * Match structural facts from changed lines against a full candidate file.
 * A known, different import binding is rejected; an unresolved binding remains
 * an AST-only match so the checker stays conservative around barrels and
 * generated modules it cannot resolve locally.
 */
export function matchAstFacts(changedFacts, candidateFacts) {
  const matches = [];
  for (const changed of changedFacts) {
    for (const candidate of candidateFacts) {
      if (changed.kind !== candidate.kind || changed.key !== candidate.key) continue;
      // An identifier declaration is intentionally allowed to match a call or
      // reference: changing a shared helper declaration must still surface its
      // consumers. Other structural facts retain their exact role.
      if (
        changed.kind !== 'identifier' &&
        changed.role !== candidate.role
      ) continue;
      if (!compatibleBinding(changed, candidate)) continue;
      const graph = changed.binding && candidate.binding &&
        changed.binding.module === candidate.binding.module &&
        changed.binding.imported === candidate.binding.imported;
      matches.push({
        kind: changed.kind,
        key: changed.key,
        role: changed.role,
        graph: graph ? `${changed.binding.module}#${changed.binding.imported}` : null,
      });
    }
  }
  const unique = new Map();
  for (const match of matches) {
    unique.set(
      `${match.kind}|${match.key}|${match.role}|${match.graph ?? ''}`,
      match,
    );
  }
  return [...unique.values()];
}

export function astMatchLabels(matches) {
  const labels = new Set();
  for (const match of matches) {
    labels.add(`ast:${match.kind}:${match.key}`);
    if (match.graph) labels.add(`graph:${match.graph}`);
  }
  return [...labels];
}
