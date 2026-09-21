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
const SYNTAX_TREE_ROOTS = new Set([
  'node', 'child', 'children', 'statement', 'element', 'clause', 'sourceFile',
  'parent', 'declaration', 'specifier', 'binding', 'moduleSpecifier',
  'importClause', 'namedBindings', 'propertyName',
]);

export function isAstSourceFile(fileName) {
  return SOURCE_EXTENSIONS.some((extension) => String(fileName).endsWith(extension));
}

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

function declarationIsExported(node) {
  if (!declarationName(node)) return false;
  let declaration = node.parent;
  if (ts.isVariableDeclaration(declaration)) declaration = declaration.parent;
  if (ts.isVariableDeclarationList(declaration)) declaration = declaration.parent;
  return Boolean(declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
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

function expressionRoot(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return expressionRoot(node.expression);
  }
  return null;
}

function isSyntaxTreeMember(node) {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const root = expressionRoot(node.expression);
  return root ? SYNTAX_TREE_ROOTS.has(root) : false;
}

function bindingForExpression(node, imports, externalDerived) {
  const root = expressionRoot(node);
  if (!root) return null;
  return imports.get(root) ?? externalDerived.get(root) ?? null;
}

function initializerBinding(node, imports, externalDerived) {
  const direct = bindingForExpression(node, imports, externalDerived);
  if (direct) return direct;
  if (ts.isCallExpression(node)) {
    return bindingForExpression(node.expression, imports, externalDerived);
  }
  return null;
}

export function isExternalBinding(binding) {
  return Boolean(binding?.module && String(binding.module).startsWith('external:'));
}

function parentRole(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return 'member';
  if (ts.isCallExpression(parent) && parent.expression === node) return 'call';
  if (declarationName(node)) return 'declaration';
  return 'reference';
}

function factFingerprint(sourceFile, node, role) {
  let subject = node;
  if (role === 'declaration') {
    subject = node.parent;
    if (ts.isVariableDeclaration(subject)) subject = subject.parent;
  } else if (role === 'call' && ts.isIdentifier(node) && ts.isCallExpression(node.parent)) {
    subject = node.parent;
  } else if (role === 'member' && ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)) {
    subject = node.parent;
  }
  return subject.getText(sourceFile);
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
  const exportedNames = new Set();
  // A local variable initialized from a package import (for example
  // `const sourceFile = ts.createSourceFile(...)`) is still package-derived.
  // Keeping this tiny derived-binding map prevents every TypeScript compiler
  // API member from becoming a cross-file sibling signal without building a
  // persistent type graph.
  const externalDerived = new Map();
  const localBindings = new Map();
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
      exported: extra.exported ?? false,
      fingerprint: extra.fingerprint ?? factFingerprint(sourceFile, node, role),
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
    if (ts.isExportDeclaration(statement) && statement.exportClause &&
        ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exportedNames.add(element.propertyName?.text ?? element.name.text);
      }
    }
  }

  const registerLocalDeclarations = (node) => {
    if (ts.isIdentifier(node) && declarationName(node)) {
      const exported = declarationIsExported(node) || exportedNames.has(node.text);
      localBindings.set(node.text, {
        module: exported ? fileName : `local:${fileName}`,
        imported: node.text,
      });
    }
    ts.forEachChild(node, registerLocalDeclarations);
  };
  registerLocalDeclarations(sourceFile);

  const bindingForLocalName = (name) =>
    imports.get(name) ?? externalDerived.get(name) ?? localBindings.get(name) ?? null;

  // Resolve a few levels of local aliases. This is intentionally bounded and
  // syntax-only: it is a noise filter for external APIs, not a replacement
  // for the TypeScript checker.
  for (let pass = 0; pass < 3; pass += 1) {
    let added = 0;
    const collectAliases = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const binding = initializerBinding(node.initializer, imports, externalDerived);
        if (binding && isExternalBinding(binding) && !externalDerived.has(node.name.text)) {
          externalDerived.set(node.name.text, {
            module: 'external:derived',
            imported: node.name.text,
          });
          added += 1;
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(sourceFile);
    if (added === 0) break;
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const key = expressionPath(node.expression);
      if (key) {
        const binding = bindingForExpression(node.expression, imports, externalDerived) ??
          localBindings.get(expressionRoot(node.expression));
        addFact('call', key, node, {
          role: 'call',
          binding,
          tokens: moduleTokens(key),
        });
      }
    }

    if (ts.isPropertyAccessExpression(node) && !ts.isCallExpression(node.parent) &&
        !isSyntaxTreeMember(node)) {
      const key = expressionPath(node);
      if (key) addFact('member', key, node.name, {
        role: 'member',
        binding: bindingForExpression(node.expression, imports, externalDerived) ??
          localBindings.get(expressionRoot(node.expression)),
        tokens: moduleTokens(key),
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
        binding: bindingForLocalName(node.text),
        tokens: [node.text],
        exported: declarationIsExported(node) || exportedNames.has(node.text),
      });
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return facts;
}

/**
 * Keep only facts that can say something structural about a project sibling.
 * Plain local identifiers are deliberately excluded: matching `sourceFile`,
 * `moduleSpecifier` or `candidateTokens` across scripts is the exact class of
 * lexical false positive this layer is meant to remove. Package/API facts are
 * excluded too; `ts.createSourceFile` is common infrastructure, not a local
 * relationship between the files being compared.
 */
export function isActionableAstFact(fact) {
  if (!fact) return false;
  if (fact.kind === 'identifier') {
    return fact.role === 'call' ||
      (fact.role === 'declaration' && fact.exported === true);
  }
  if (fact.kind === 'import') {
    return !String(fact.key ?? '').startsWith('external:');
  }
  if (!['call', 'member', 'literal'].includes(fact.kind)) return false;
  return !isExternalBinding(fact.binding);
}

export function factsContainingToken(facts, token) {
  return facts.filter((fact) => fact.tokens.includes(token));
}

function compatibleBinding(changed, candidate) {
  if (!changed.binding || !candidate.binding) return true;
  const changedLocal = String(changed.binding.module).startsWith('local:');
  const candidateLocal = String(candidate.binding.module).startsWith('local:');
  if (changedLocal || candidateLocal) {
    return changed.binding.module === candidate.binding.module &&
      changed.binding.imported === candidate.binding.imported;
  }
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
  const changed = changedFacts.filter(isActionableAstFact);
  // A changed exported declaration may intentionally surface a consumer that
  // declares the same name locally (the historical weak lexical signal). Keep
  // candidate declarations available only for that declaration-to-consumer
  // comparison; plain local identifiers never become evidence on their own.
  const candidate = candidateFacts.filter((fact) =>
    isActionableAstFact(fact) ||
    (fact.kind === 'identifier' && fact.role === 'declaration'),
  );
  for (const changedFact of changed) {
    for (const candidateFact of candidate) {
      if (changedFact.kind !== candidateFact.kind || changedFact.key !== candidateFact.key) continue;
      // An identifier declaration is intentionally allowed to match a call or
      // reference: changing a shared helper declaration must still surface its
      // consumers. Other structural facts retain their exact role.
      if (
        changedFact.kind !== 'identifier' &&
        changedFact.role !== candidateFact.role
      ) continue;
      const exportedDeclarationPair =
        changedFact.kind === 'identifier' &&
        changedFact.role === 'declaration' &&
        changedFact.exported === true &&
        candidateFact.role === 'declaration';
      if (!exportedDeclarationPair && !compatibleBinding(changedFact, candidateFact)) continue;
      const graph = changedFact.binding && candidateFact.binding &&
        !isExternalBinding(changedFact.binding) &&
        !isExternalBinding(candidateFact.binding) &&
        changedFact.binding.module === candidateFact.binding.module &&
        changedFact.binding.imported === candidateFact.binding.imported;
      matches.push({
        kind: changedFact.kind,
        key: changedFact.key,
        role: changedFact.role,
        graph: graph ? `${changedFact.binding.module}#${changedFact.binding.imported}` : null,
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
