/**
 * Small, in-process AST and symbol layer for the sibling checker.
 *
 * This is deliberately not a persistent knowledge graph. It parses the files
 * involved in one check with the TypeScript compiler already used by the repo,
 * keeps only structural facts needed by the candidate sweep, and resolves
 * direct local imports so equal names from different modules do not look like
 * the same symbol.
 */
// TypeScript 7 no longer exposes the compiler namespace through its default
// ESM export. Namespace import remains compatible with the TypeScript 5 line.
import * as ts from 'typescript';
import path from 'node:path';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
// Runtime APIs are infrastructure just like package imports. Resolve lexical
// symbols first: a project import/parameter named Buffer is NOT the global.
const RUNTIME_GLOBALS = new Set([
  'Buffer', 'process', 'console', 'globalThis', 'global', 'window', 'document',
  'Array', 'ArrayBuffer', 'SharedArrayBuffer', 'Atomics', 'BigInt', 'Boolean',
  'DataView', 'Date', 'Error', 'EvalError', 'Function', 'Intl', 'JSON', 'Map',
  'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError',
  'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError', 'TypeError',
  'URIError', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'Blob', 'File', 'FormData', 'Headers',
  'Request', 'Response', 'ReadableStream', 'WritableStream', 'TransformStream',
  'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
  'performance', 'crypto', 'navigator', 'localStorage', 'sessionStorage',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'atob', 'btoa',
]);
const SYNTAX_TREE_ROOTS = new Set([
  'node', 'child', 'children', 'statement', 'element', 'clause', 'sourceFile',
  'parent', 'declaration', 'specifier', 'binding', 'moduleSpecifier',
  'importClause', 'namedBindings', 'propertyName',
]);

export function isAstSourceFile(fileName) {
  return SOURCE_EXTENSIONS.some((extension) => String(fileName).endsWith(extension));
}

/** A complete function signature with an empty body, not an executable guard.
 * Parse modifiers/destructuring instead of inferring them from identifier text.
 * Default initializers may carry domain behavior and remain evidence.
 */
export function isBareFunctionHeader(text) {
  const value = String(text ?? '').trim();
  if (!/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b/.test(value) || !value.endsWith('{')) return false;
  const parsed = ts.createSourceFile('header.ts', `${value}}`, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  if (parsed.parseDiagnostics.length || parsed.statements.length !== 1) return false;
  const declaration = parsed.statements[0];
  return ts.isFunctionDeclaration(declaration) && Boolean(declaration.body) &&
    declaration.body.statements.length === 0 && declaration.parameters.every((parameter) => !parameter.initializer);
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

export function isExternalBinding(binding) {
  return Boolean(binding?.module && String(binding.module).startsWith('external:'));
}

/** Identity of a directly referenced project export, independent of its local alias.
 * Namespace/object members still need their member path: sharing an imported
 * object alone must not equate two different methods on it.
 */
export function projectBindingKey(fact) {
  const binding = fact?.binding;
  if (!binding || isExternalBinding(binding) || binding.module.startsWith('local:') ||
      binding.imported === '*' || !['identifier', 'call'].includes(fact.kind) ||
      !/^[A-Za-z_$][\w$]*$/.test(fact.key)) return null;
  return `${binding.module}#${binding.imported}`;
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
 * `candidateOnly` keeps requested `factKeys` or `bindingKeys` (aliased exports),
 * so a sibling AST does not retain unrelated facts.
 */
export function collectAstFacts(
  fileName,
  source,
  { lineRanges, files = new Set(), candidateOnly = false, factKeys = null, bindingKeys = null } = {},
) {
  // YAML/shell sources use the checker's lexical path, never the JS binder.
  if (!isAstSourceFile(fileName)) return [];
  const sourceFile = ts.createSourceFile(
    fileName,
    String(source ?? ''),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  // Bind this source in isolation. TypeScript handles lexical shadowing and
  // hoisting; no type checking, dependency loading or repository-wide program.
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true, allowJs: true }, {
    getSourceFile: (name) => name === fileName ? sourceFile : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {},
    getCurrentDirectory: () => '', getDirectories: () => [],
    fileExists: (name) => name === fileName, readFile: () => undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker();
  const symbolOf = (node) => checker.getSymbolAtLocation(node);
  const imports = new Map();
  const exportedSymbols = new Set();
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
    const bindingKeyMatch = bindingKeys?.has(projectBindingKey({ kind, key, binding }));
    if (candidateOnly && factKeys && !factKeys.has(`${kind}|${key}|${role}`) && !bindingKeyMatch) return;
    const candidateDeclaration = kind === 'identifier' && role === 'declaration';
    if (candidateOnly && !candidateDeclaration && !isActionableAstFact({
      kind,
      role,
      binding,
      exported: extra.exported ?? false,
    })) return;
    const fingerprint = extra.fingerprint ?? factFingerprint(sourceFile, node, role);
    const dedupe = `${kind}|${key}|${role}|${bindingKey}|${fingerprint}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    facts.push({
      kind,
      key,
      role,
      tokens: extra.tokens ?? moduleTokens(key),
      binding,
      exported: extra.exported ?? false,
      fingerprint,
    });
  };

  const registerImportBinding = (local, imported, module) => {
    imports.set(symbolOf(local), { module, imported });
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
      if (clause.name) registerImportBinding(clause.name, 'default', module);
      const namedBindings = clause.namedBindings;
      if (!namedBindings) continue;
      if (ts.isNamespaceImport(namedBindings)) {
        registerImportBinding(namedBindings.name, '*', module);
      } else if (ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          registerImportBinding(
            element.name,
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
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause &&
        ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const symbol = checker.getExportSpecifierLocalTargetSymbol(element);
        if (symbol) exportedSymbols.add(symbol);
      }
    }
  }

  const registerLocalDeclarations = (node) => {
    if (ts.isIdentifier(node) && declarationName(node)) {
      const exported = declarationIsExported(node) || exportedSymbols.has(symbolOf(node));
      localBindings.set(symbolOf(node), {
        module: exported ? fileName : `local:${fileName}`,
        imported: node.text,
      });
    }
    ts.forEachChild(node, registerLocalDeclarations);
  };
  registerLocalDeclarations(sourceFile);

  const bindingForNode = (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const rootBinding = bindingForNode(node.expression);
      // Global containers also carry project hooks. Only known runtime
      // exports count as infrastructure (globalThis.Buffer).
      if (rootBinding?.module === 'external:runtime' &&
          ['globalThis', 'global', 'window'].includes(rootBinding.imported)) {
        const member = ts.isPropertyAccessExpression(node) ? node.name.text
          : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text : null;
        return RUNTIME_GLOBALS.has(member)
          ? { module: 'external:runtime', imported: member }
          : null;
      }
      return rootBinding;
    }
    if (!ts.isIdentifier(node)) return null;
    const symbol = symbolOf(node);
    if (symbol?.declarations?.length) {
      return imports.get(symbol) ?? externalDerived.get(symbol) ?? localBindings.get(symbol) ?? null;
    }
    return RUNTIME_GLOBALS.has(node.text)
      ? { module: 'external:runtime', imported: node.text }
      : null;
  };

  // Package/runtime aliases remain infrastructure, including destructuring.
  for (let pass = 0; pass < 3; pass += 1) {
    let added = 0;
    const collectAliases = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = ts.isCallExpression(node.initializer)
          ? node.initializer.expression : node.initializer;
        const binding = bindingForNode(initializer);
        if (isExternalBinding(binding)) {
          const bindName = (name, origin = binding) => {
            if (ts.isIdentifier(name)) {
              const symbol = symbolOf(name);
              if (symbol && !externalDerived.has(symbol)) {
                externalDerived.set(symbol, origin);
                added += 1;
              }
            } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
              for (const element of name.elements) {
                if (!ts.isBindingElement(element)) continue;
                if (origin.module === 'external:runtime' &&
                    ['globalThis', 'global', 'window'].includes(origin.imported)) {
                  const member = element.propertyName?.text ?? element.name.text;
                  if (RUNTIME_GLOBALS.has(member)) {
                    bindName(element.name, { module: 'external:runtime', imported: member });
                  }
                } else bindName(element.name, origin);
              }
            }
          };
          bindName(node.name);
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
        const binding = bindingForNode(node.expression);
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
        binding: bindingForNode(node.expression),
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
        binding: bindingForNode(node),
        tokens: [node.text],
        exported: declarationIsExported(node) || exportedSymbols.has(symbolOf(node)),
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
 * excluded too; `Buffer.isBuffer`, `ts.createSourceFile` and a package import
 * are common infrastructure, not a local relationship between the files being
 * compared.
 */
export function isActionableAstFact(fact) {
  if (!fact) return false;
  if (fact.kind === 'identifier') {
    return (fact.role === 'call' && !isExternalBinding(fact.binding)) ||
      (fact.role === 'declaration' && fact.exported === true);
  }
  if (fact.kind === 'import') {
    // Importing a module alone does not change its contract or its consumers.
    return false;
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
  // Keep declarations for binding-aware comparisons. A same-named private
  // helper in another file is not a consumer of the changed export.
  const candidate = candidateFacts.filter((fact) =>
    isActionableAstFact(fact) ||
    (fact.kind === 'identifier' && fact.role === 'declaration'),
  );
  for (const changedFact of changed) {
    for (const candidateFact of candidate) {
      if (changedFact.kind !== candidateFact.kind) continue;
      const changedBindingKey = projectBindingKey(changedFact);
      const sameExport = changedBindingKey && changedBindingKey === projectBindingKey(candidateFact);
      if (changedFact.key !== candidateFact.key && !sameExport) continue;
      // An identifier declaration is intentionally allowed to match a call or
      // reference: changing a shared helper declaration must still surface its
      // consumers. Other structural facts retain their exact role.
      if (
        changedFact.kind !== 'identifier' &&
        changedFact.role !== candidateFact.role
      ) continue;
      if (!compatibleBinding(changedFact, candidateFact)) continue;
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
