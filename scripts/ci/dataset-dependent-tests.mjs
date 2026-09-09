/**
 * dataset-dependent-tests.mjs — classifica i test in base al fatto che leggano
 * o meno gli OUTPUT di `scripts/assemble-jobs-dataset.mjs`.
 *
 * Perché esiste: su un job `tests` da ~648s, l'assemble costa 133-155s misurati
 * (run 30355205859 / 30357073975) e la sua cache è di fatto sempre un miss —
 * la key include `hashFiles('data/jobs/by-crawler/**')` e i crawler committano
 * slice decine di volte al giorno, per cui la key non ricentra mai; per giunta
 * la quota cache del repo è satura (9.54GB/10GB, 12 cache attive) e la LRU
 * evicta prima che una key si ripresenti. Quei ~140s erano puro tempo morto in
 * coda a vitest.
 *
 * Solo 37 file di test su 1388 leggono un output dell'assemble: gli altri
 * possono girare MENTRE l'assemble lavora in background (`background:` step in
 * tests.yml), e i 37 girano dopo il `wait-all`. Questo file è la singola fonte
 * di verità di quella partizione — è calcolata a runtime dal sorgente, non
 * committata come lista, così un test nuovo non può andare fuori sync.
 *
 * IMPORTANTE — le slice NON contano. `data/jobs/by-crawler/**` è committato nel
 * repo: un test che legge le slice non ha bisogno dell'assemble. Contano solo i
 * file che l'assemble GENERA (gitignored), elencati in ASSEMBLE_OUTPUTS.
 *
 * Classificazione volutamente CONSERVATIVA (over-include): un falso positivo
 * costa solo un po' di parallelismo in meno, un falso negativo costa un test
 * rosso. Per lo stesso motivo si segue anche il grafo di import (un test che
 * importa un helper che legge jobs.json è dipendente pur non nominandolo).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Basename dei file prodotti da assemble-jobs-dataset.mjs (vedi le costanti
 * `DATA_…` e `PUBLIC_…` in quello script). Match sul solo basename perché i test
 * costruiscono i path in modi diversi — `'data/jobs.json'`, ma anche
 * `path.join(ROOT, 'data', 'jobs.json')` che un grep sul path completo
 * mancherebbe.
 */
const ASSEMBLE_OUTPUTS = [
  'jobs.json',
  'expired-jobs.json',
  'jobs-meta.json',
  'jobs-stats.json',
  'jobs-crawler-summaries.json',
  'job-canton-pins.json',
  // Scritto da scripts/migrate-all-known-job-slugs-canton-aware.mjs, che gira
  // SUBITO DOPO l'assemble perché ne legge data/jobs.json. Nel job `tests`
  // entrambi stanno dietro lo stesso `wait-all`, quindi un test che legge
  // questo file va nello stesso gruppo dei dataset-dipendenti: prima del
  // wait il file è ancora nella versione committata, non migrata.
  //
  // Senza `.json` finale (issue #4248): il registro è passato da monolite a
  // shard sotto `data/all-known-job-slugs/`, e i lettori ora importano
  // `scripts/lib/all-known-job-slugs-store.mjs`. Il prefisso senza estensione
  // matcha entrambe le forme — il path degli shard E il path del modulo store
  // — così un test che legge il registro tramite l'accessor resta classificato
  // come dataset-dipendente invece di scivolare nel gruppo veloce e girare
  // prima che la migrazione canton-aware abbia scritto gli shard.
  'all-known-job-slugs',
  // Idem per il ledger degli orfani arricchiti (issue #4248, seconda metà):
  // anch'esso è passato da monolite `orphan-enriched-data.json` a shard sotto
  // `data/orphan-enriched-data/`, letti via
  // `scripts/lib/orphan-enriched-store.mjs`. Senza `.json` per la stessa
  // ragione: il prefisso matcha sia il path degli shard sia quello del modulo.
  // È scritto da sync-gsc-orphans/enrich-compat-orphan-slugs, ma un test che lo
  // legge vede comunque la versione committata finché la pipeline dati non ha
  // finito, quindi appartiene allo stesso gruppo.
  'orphan-enriched-data',
];

const OUTPUT_RE = new RegExp(
  `(^|['"\`/\\\\])(${ASSEMBLE_OUTPUTS.map((f) => f.replace(/[.]/g, '\\.')).join('|')})`,
);

/**
 * Nominare un output NON basta: `services/jobSlugShards.ts` cita
 * `/data/jobs.json` come URL da `fetch` a runtime nel browser, e siccome
 * `services/router.ts` lo importa ed è a sua volta importato da quasi ogni
 * componente, il solo match sul nome classificava 640/1388 test come
 * dipendenti (46%) — inclusi casi assurdi come `AdBlockGate.test.tsx`, la cui
 * catena è AdBlockGate → NavigationContext → router → jobSlugShards.
 *
 * L'AST conta solo una chiamata di lettura del filesystem che riceve l'output
 * (o un binding che lo contiene): un `fetch` di un URL pubblico non ha bisogno
 * che l'assemble sia finito, una `readFileSync` sì. Un file non analizzabile
 * resta sconosciuto e quindi conserva il comportamento fail-safe.
 */
const TEST_EXTS = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mjs', '.js', '.mts', '/index.ts', '/index.tsx', '/index.mjs'];
const DATASET_READ_CALLS = new Set([
  'readFileSync',
  'readFile',
  'existsSync',
  'statSync',
  'createReadStream',
  'readJson',
  'loadJson',
]);
const DATASET_READER_EXPORTS = new Set([
  'readJobsDataset',
  'readAllKnownJobSlugs',
  'readOrphanEnriched',
]);

/** Tutti i file di test sotto tests/, ricorsivo. */
function listTestFiles(dir = path.join(ROOT, 'tests'), acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__snapshots__') continue;
      listTestFiles(full, acc);
    } else if (TEST_EXTS.some((ext) => e.name.endsWith(ext))) {
      acc.push(full);
    }
  }
  return acc;
}

const sourceTextCache = new Map();
function readSource(file) {
  if (sourceTextCache.has(file)) return sourceTextCache.get(file);
  let src = '';
  try {
    src = fs.readFileSync(file, 'utf-8');
  } catch {
    src = '';
  }
  sourceTextCache.set(file, src);
  return src;
}

const astCache = new Map();
const fileAnalysisCache = new Map();

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts') || file.endsWith('.mts')) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function parseSource(file) {
  if (astCache.has(file)) return astCache.get(file);
  let parsed = null;
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file: ' + file);
    parsed = ts.createSourceFile(
      file,
      readSource(file),
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(file),
    );
    if (parsed.parseDiagnostics.length > 0) parsed = null;
  } catch {
    // L'incertezza non è evidenza di indipendenza: il chiamante deve restare
    // sul ramo required finché il file non è analizzabile.
    parsed = null;
  }
  astCache.set(file, parsed);
  return parsed;
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessor(node)
    || ts.isSetAccessor(node);
}

// Visita il codice runtime sotto root senza entrare nei callback annidati.
function visitRuntime(node, visit, root = node) {
  visit(node);
  ts.forEachChild(node, (child) => {
    if (child !== root && isFunctionLike(child)) return;
    visitRuntime(child, visit, root);
  });
}

function visitAll(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => visitAll(child, visit));
}

function isInsideImportDeclaration(node) {
  let current = node.parent;
  while (current) {
    if (ts.isImportDeclaration(current)) return true;
    current = current.parent;
  }
  return false;
}

function expressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function outputBindings(sourceFile) {
  const bindings = new Set();
  visitAll(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    if (OUTPUT_RE.test(node.initializer.getText(sourceFile))) bindings.add(node.name.text);
  });
  return bindings;
}

function importedDatasetCallNames(sourceFile) {
  const readCallNames = new Set(DATASET_READ_CALLS);
  const readerNames = new Set(DATASET_READER_EXPORTS);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
    const named = statement.importClause.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text || element.name.text;
      if (DATASET_READ_CALLS.has(imported)) readCallNames.add(element.name.text);
      if (DATASET_READER_EXPORTS.has(imported)) readerNames.add(element.name.text);
    }
  }
  return { readCallNames, readerNames };
}

function callReadsDataset(node, bindings, sourceFile, { readCallNames, readerNames } = {
  readCallNames: DATASET_READ_CALLS,
  readerNames: DATASET_READER_EXPORTS,
}) {
  if (!ts.isCallExpression(node)) return false;
  const name = expressionName(node.expression);
  if (readerNames.has(name)) return true;
  if (!readCallNames.has(name)) return false;
  const call = node.getText(sourceFile);
  return OUTPUT_RE.test(call)
    || [...bindings].some((binding) => new RegExp('\\b' + binding.replace(/[$]/g, '\\$&') + '\\b').test(call));
}

function functionName(node, parent, fallback) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return fallback;
}

function functionInfo(node, name, bindings, sourceFile, datasetCallNames) {
  const calls = new Set();
  const usedIdentifiers = new Set();
  const namespaceProperties = new Map();
  let direct = false;
  visitRuntime(node, (child) => {
    if (callReadsDataset(child, bindings, sourceFile, datasetCallNames)) direct = true;
    if (ts.isCallExpression(child)) {
      const called = expressionName(child.expression);
      if (called) calls.add(called);
    }
    if (ts.isIdentifier(child)) usedIdentifiers.add(child.text);
    if (ts.isPropertyAccessExpression(child)
      && ts.isIdentifier(child.expression)
      && ts.isIdentifier(child.name)) {
      if (!namespaceProperties.has(child.expression.text)) namespaceProperties.set(child.expression.text, new Set());
      namespaceProperties.get(child.expression.text).add(child.name.text);
    }
  });
  return { node, name, calls, usedIdentifiers, namespaceProperties, direct };
}

// Estrae solo binding ed effetti necessari a seguire una lettura runtime.
function analyzeFile(file) {
  if (fileAnalysisCache.has(file)) return fileAnalysisCache.get(file);
  const sourceFile = parseSource(file);
  if (!sourceFile) {
    const unknown = {
      unknown: true,
      imports: [],
      allImports: [],
      exports: new Map(),
      functions: new Map(),
      topDirect: true,
      allDirect: true,
      usedIdentifiers: new Set(),
      namespaceProperties: new Map(),
    };
    fileAnalysisCache.set(file, unknown);
    return unknown;
  }

  const bindings = outputBindings(sourceFile);
  const datasetCallNames = importedDatasetCallNames(sourceFile);
  const imports = [];
  const allImports = [];
  const exports = new Map();
  const functions = new Map();
  const registerFunction = (node, parent, fallback) => {
    const name = functionName(node, parent, fallback);
    functions.set(name, functionInfo(node, name, bindings, sourceFile, datasetCallNames));
    return name;
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const spec = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      if (!spec) continue;
      allImports.push({ spec });
      const clause = statement.importClause;
      if (!clause) {
        imports.push({ spec, side: true });
        continue;
      }
      if (clause.isTypeOnly) continue;
      if (clause.name) imports.push({ spec, local: clause.name.text, imported: 'default' });
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          imports.push({ spec, namespace: clause.namedBindings.name.text });
        } else {
          for (const element of clause.namedBindings.elements) {
            if (element.isTypeOnly) continue;
            imports.push({
              spec,
              local: element.name.text,
              imported: element.propertyName?.text || element.name.text,
            });
          }
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      const name = registerFunction(statement, sourceFile, '__default_function__');
      const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        exports.set(isDefault ? 'default' : name, { local: name });
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (isFunctionLike(declaration.initializer)) {
          const name = registerFunction(declaration.initializer, declaration, declaration.name.text);
          if (isExported) exports.set(declaration.name.text, { local: name });
        } else if (isExported) {
          exports.set(declaration.name.text, { value: true });
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        exports.set('default', { local: statement.expression.text });
      } else if (isFunctionLike(statement.expression)) {
        const name = registerFunction(statement.expression, statement, '__default_expression__');
        exports.set('default', { local: name });
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const spec = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
      if (spec) allImports.push({ spec });
      if (!statement.exportClause) {
        if (spec) exports.set('*', { spec, star: true });
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const local = element.propertyName?.text || element.name.text;
        exports.set(element.name.text, spec
          ? { spec, imported: local, reexport: true }
          : { local });
      }
    }
  }

  // Mantieni nel grafo anche gli archi runtime non espressi da un import
  // statico: il vecchio parser li seguiva con `import()` e `require()`.
  visitAll(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    const argument = node.arguments[0];
    if ((isDynamicImport || isRequire) && ts.isStringLiteral(argument)) {
      imports.push({ spec: argument.text, side: true });
      allImports.push({ spec: argument.text });
    }
  });

  let topDirect = false;
  const usedIdentifiers = new Set();
  const namespaceProperties = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || isFunctionLike(statement)) continue;
    visitRuntime(statement, (node) => {
      if (callReadsDataset(node, bindings, sourceFile, datasetCallNames)) topDirect = true;
      if (ts.isIdentifier(node)) usedIdentifiers.add(node.text);
      if (ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && ts.isIdentifier(node.name)) {
        if (!namespaceProperties.has(node.expression.text)) namespaceProperties.set(node.expression.text, new Set());
        namespaceProperties.get(node.expression.text).add(node.name.text);
      }
    });
  }
  let allDirect = false;
  visitAll(sourceFile, (node) => {
    if (isInsideImportDeclaration(node)) return;
    if (callReadsDataset(node, bindings, sourceFile, datasetCallNames)) allDirect = true;
    if (ts.isIdentifier(node)) usedIdentifiers.add(node.text);
    if (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && ts.isIdentifier(node.name)) {
      if (!namespaceProperties.has(node.expression.text)) namespaceProperties.set(node.expression.text, new Set());
      namespaceProperties.get(node.expression.text).add(node.name.text);
    }
  });

  const analysis = {
    unknown: false,
    sourceFile,
    imports,
    allImports,
    exports,
    functions,
    topDirect,
    allDirect,
    usedIdentifiers,
    namespaceProperties,
  };
  fileAnalysisCache.set(file, analysis);
  return analysis;
}

/** Risolve uno specifier locale (relativo o alias `@/`) a un file reale. */
function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith('@/')) {
    base = path.join(ROOT, spec.slice(2));
  } else {
    return null; // pacchetto npm: fuori dal grafo del repo
  }
  for (const ext of RESOLVE_EXTS) {
    const cand = base + ext;
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      /* prossimo candidato */
    }
  }
  return null;
}

/**
 * Import locali risolti di `file`, entro il repo. Cached: il grafo viene
 * percorso più volte dal fixed-point sotto.
 *
 * ESPORTATA per `scripts/ci/corpus-wide-tests.mjs`, che deve sapere quali file
 * sorgente un test corpus-wide raggiunge per decidere se il diff di una PR lo
 * rende ancora bloccante. Riscrivere lì la stessa risoluzione (RESOLVE_EXTS +
 * alias `@/` + parser AST degli import) creerebbe due copie della stessa regola
 * destinate a divergere (AGENTS.md #6), e la divergenza si presenterebbe nel
 * modo peggiore
 * possibile: un gate che smette di scattare senza che niente diventi rosso.
 * Nessun cambio di comportamento per i chiamanti esistenti — solo `export`.
 */
const importsCache = new Map();
const runtimeImportsCache = new Map();

function runtimeImports(file) {
  if (runtimeImportsCache.has(file)) return runtimeImportsCache.get(file);
  const entries = analyzeFile(file).imports.map((entry) => ({
    ...entry,
    to: resolveSpecifier(entry.spec, file),
  }));
  runtimeImportsCache.set(file, entries);
  return entries;
}
export function localImports(file) {
  const cached = importsCache.get(file);
  if (cached) return cached;
  const out = [];
  for (const entry of analyzeFile(file).allImports) {
    const resolved = resolveSpecifier(entry.spec, file);
    if (resolved) out.push(resolved);
  }
  importsCache.set(file, out);
  return out;
}

/**
 * Classificazione a FIXED-POINT, calcolata una volta sola.
 *
 * Il fixed-point segue gli effetti runtime, non la semplice presenza di un
 * nome o di un arco nel grafo: un import type è ignorato, una funzione pura
 * non eredita la lettura di un'altra export dello stesso modulo e un helper
 * che chiama davvero un reader resta dipendente. Il ramo sconosciuto resta
 * conservativo: viene considerato dipendente.
 *
 * Un primo tentativo usava una DFS con memoizzazione dei soli risultati
 * positivi più un set `seen` per spezzare i cicli di import. Non era
 * idempotente: `seen` è condiviso fra i rami di una stessa visita, quindi un
 * modulo già attraversato veniva liquidato come `false` in un contesto e
 * risolto `true` in un altro, e la memo dei positivi cambiava l'esito della
 * chiamata SUCCESSIVA — 594 dipendenti alla prima invocazione, 596 alla
 * seconda. Su una partizione che decide quali test girano in quale delle due
 * run vitest, un risultato che dipende dall'ordine delle chiamate può perdere
 * file per strada (copertura persa in silenzio, vedi
 * tests/dataset-test-partition.test.ts).
 *
 * Il fixed-point non ha quel difetto: per ogni test si parte dalle chiamate che
 * leggono davvero il dataset e si propaga attraverso gli effetti runtime degli
 * import e delle funzioni esportate finché non resta un percorso da risolvere.
 * Gli archi type-only e i binding inutilizzati non partecipano; i cicli
 * convergono naturalmente e l'esito non dipende dall'ordine di visita.
 */
let taintedCache = null;
const datasetEffectCache = new Map();

function rememberDatasetEffect(key, result, state) {
  // Un ciclo può far vedere un falso negativo prima che un altro ramo trovi
  // il seed. I risultati positivi sono monotoni; una risposta negativa si
  // memorizza solo quando la visita è aciclica.
  if (result || !state.cyclic) datasetEffectCache.set(key, result);
  return result;
}

function moduleHasTopLevelDatasetRead(file) {
  const analysis = analyzeFile(file);
  return analysis.unknown || analysis.topDirect;
}

function exportReadsDataset(file, name, stack = new Set(), state = { cyclic: false }) {
  const key = 'export:' + file + ':' + name;
  if (datasetEffectCache.has(key)) return datasetEffectCache.get(key);
  if (stack.has(key)) {
    state.cyclic = true;
    return false;
  }
  const nextStack = new Set(stack).add(key);
  const analysis = analyzeFile(file);
  if (analysis.unknown || analysis.topDirect || DATASET_READER_EXPORTS.has(name)) {
    datasetEffectCache.set(key, true);
    return true;
  }
  const binding = analysis.exports.get(name);
  if (!binding) {
    const star = analysis.exports.get('*');
    if (!star) {
      return rememberDatasetEffect(key, false, state);
    }
    const target = resolveSpecifier(star.spec, file);
    const result = target ? exportReadsDataset(target, name, nextStack, state) : true;
    return rememberDatasetEffect(key, result, state);
  }
  if (binding.reexport) {
    const target = resolveSpecifier(binding.spec, file);
    const result = target
      ? exportReadsDataset(target, binding.imported, nextStack, state)
      : true;
    return rememberDatasetEffect(key, result, state);
  }
  const result = binding.local
    ? functionReadsDataset(file, binding.local, nextStack, state)
    : false;
  return rememberDatasetEffect(key, result, state);
}

function functionReadsDataset(file, name, stack = new Set(), state = { cyclic: false }) {
  const key = 'function:' + file + ':' + name;
  if (datasetEffectCache.has(key)) return datasetEffectCache.get(key);
  if (stack.has(key)) {
    state.cyclic = true;
    return false;
  }
  const nextStack = new Set(stack).add(key);
  if (DATASET_READER_EXPORTS.has(name)) {
    datasetEffectCache.set(key, true);
    return true;
  }
  const analysis = analyzeFile(file);
  const info = analysis.functions.get(name);
  if (!info) {
    // Un export di valore non è una funzione lettore: la sua presenza nel
    // modulo non basta.
    return rememberDatasetEffect(key, false, state);
  }
  if (info.direct) {
    datasetEffectCache.set(key, true);
    return true;
  }
  for (const called of info.calls) {
    if (analysis.functions.has(called)
      && functionReadsDataset(file, called, nextStack, state)) {
      datasetEffectCache.set(key, true);
      return true;
    }
  }
  for (const entry of runtimeImports(file)) {
    if (!entry.to) continue;
    const used = entry.namespace
      ? info.usedIdentifiers.has(entry.namespace)
      : info.usedIdentifiers.has(entry.local);
    if (!used) continue;
    if (moduleHasTopLevelDatasetRead(entry.to)) {
      datasetEffectCache.set(key, true);
      return true;
    }
    if (entry.namespace) {
      const properties = info.namespaceProperties.get(entry.namespace) || new Set();
      if ([...properties].some((property) => exportReadsDataset(entry.to, property, nextStack, state))) {
        datasetEffectCache.set(key, true);
        return true;
      }
    } else if (exportReadsDataset(entry.to, entry.imported, nextStack, state)) {
      datasetEffectCache.set(key, true);
      return true;
    }
  }
  return rememberDatasetEffect(key, false, state);
}

function testReadsDataset(file) {
  const analysis = analyzeFile(file);
  if (analysis.unknown || analysis.allDirect) return true;
  for (const entry of runtimeImports(file)) {
    if (!entry.to) continue;
    const used = entry.side || (entry.namespace
      ? analysis.usedIdentifiers.has(entry.namespace)
      : analysis.usedIdentifiers.has(entry.local));
    if (!used) continue;
    if (moduleHasTopLevelDatasetRead(entry.to)) return true;
    if (entry.side) continue;
    if (entry.namespace) {
      const properties = analysis.namespaceProperties.get(entry.namespace) || new Set();
      if ([...properties].some((property) => exportReadsDataset(entry.to, property))) return true;
    } else if (exportReadsDataset(entry.to, entry.imported)) {
      return true;
    }
  }
  return false;
}

function taintedFiles() {
  if (taintedCache) return taintedCache;

  // Il fixed-point è sugli effetti runtime; la lista finale contiene solo
  // test, non ogni modulo intermedio che espone un lettore.
  const tainted = new Set(listTestFiles().filter(testReadsDataset));

  taintedCache = tainted;
  return tainted;
}

const toPosixRel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

/** Path POSIX relativi alla root, ordinati — dei test che richiedono l'assemble. */
export function listDatasetDependentTests() {
  const tainted = taintedFiles();
  return listTestFiles().filter((f) => tainted.has(f)).map(toPosixRel).sort();
}

/** Path POSIX relativi alla root — dei test che NON richiedono l'assemble. */
export function listDatasetIndependentTests() {
  const tainted = taintedFiles();
  return listTestFiles().filter((f) => !tainted.has(f)).map(toPosixRel).sort();
}

// These paths can change the artifacts consumed by the post-assemble related
// run even when the related graph contains no dataset-dependent test. Keep the
// direct-input guard here, beside the partition it complements, so tests.yml
// does not grow a second copy of the dataset decision.
const DIRECT_ASSEMBLE_INPUT_RE = /^(?:scripts\/(?:assemble-jobs-dataset|migrate-all-known-job-slugs-canton-aware)\.mjs|scripts\/lib\/parse-job-slices-worker\.mjs|scripts\/(?:generate-job-board-stats|reconcile-job-slugs)\.mjs|data\/(?:canton-url-slugs|canton-municipalities|swiss-postal-codes)\.json|data\/orphan-indexed-job-slugs\.json|data\/(?:all-known-job-slugs|orphan-enriched-data)\/|data\/jobs\/(?:by-crawler|expired\/by-crawler)\/|data\/jobs-crawler-summaries\/by-crawler\/)/;

function normalizeDecisionPath(file) {
  return String(file).replaceAll('\\', '/').replace(/^\.\//, '');
}

/** True when a changed path can alter the artifacts produced by the step. */
export function isDirectAssembleInput(file) {
  return DIRECT_ASSEMBLE_INPUT_RE.test(normalizeDecisionPath(file));
}

/**
 * Decide whether `Assemble + migrate` must run before the related Vitest run.
 *
 * Every malformed or incomplete input is deliberately an execution decision:
 * skipping an assembly that was needed breaks the dependent tests, while an
 * unnecessary assembly only spends time. The selected-test list is produced
 * by the same related runner that later invokes Vitest; this function only
 * reuses the existing dataset partition to inspect that list.
 *
 * Those fail-safe branches carry `degraded: true`. The distinction is not
 * cosmetic: a `required: true` that means «this diff needs the dataset» is the
 * feature working, while one that means «I could not see the repo» is the
 * optimization silently turned off. The second kind is indistinguishable from
 * the first in the log, so it can sit there for months as a permanent no-op —
 * exactly the failure mode `unreadableCount > 0` would produce if the
 * `vitest:` sparse-checkout ever stopped materializing the files that
 * `trackedFiles()` selects. The caller turns `degraded` into a CI warning
 * annotation; `tests/ci-vitest-check-name.test.ts` pins the sparse profile so
 * the condition cannot arise in the first place.
 */
export function shouldAssembleForRelatedTests({
  eventName,
  changedPaths,
  changedStatus,
  selectedTests,
  unreadableCount,
} = {}) {
  if (eventName !== 'pull_request') {
    return { required: true, reason: 'event is not pull_request' };
  }
  if (changedStatus !== 'complete') {
    return {
      required: true,
      degraded: true,
      reason: `changed-paths status is ${String(changedStatus || 'unknown')}`,
    };
  }
  if (!Array.isArray(changedPaths) || !Array.isArray(selectedTests)) {
    return { required: true, degraded: true, reason: 'related selection input is not classifiable' };
  }
  if (!Number.isInteger(unreadableCount) || unreadableCount < 0) {
    return { required: true, degraded: true, reason: 'related graph completeness is unknown' };
  }
  if (unreadableCount > 0) {
    return { required: true, degraded: true, reason: 'related graph contains unreadable tracked files' };
  }

  let dependentTests;
  try {
    dependentTests = new Set(listDatasetDependentTests());
  } catch (error) {
    return {
      required: true,
      degraded: true,
      reason: `dataset partition failed: ${error?.message || String(error)}`,
    };
  }

  if (selectedTests.some((file) => dependentTests.has(normalizeDecisionPath(file)))) {
    return { required: true, reason: 'related selection includes a dataset-dependent test' };
  }
  if (changedPaths.some(isDirectAssembleInput)) {
    return { required: true, reason: 'diff touches an assemble/migrate input' };
  }
  return { required: false, reason: 'related selection is dataset-independent' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv.includes('--independent') ? 'independent' : 'dependent';
  const list = mode === 'independent' ? listDatasetIndependentTests() : listDatasetDependentTests();
  if (process.argv.includes('--count')) {
    const dep = listDatasetDependentTests().length;
    const all = listTestFiles().length;
    console.log(`dataset-dependent: ${dep} / ${all} test file (${((dep / all) * 100).toFixed(1)}%)`);
  } else {
    console.log(list.join('\n'));
  }
}
