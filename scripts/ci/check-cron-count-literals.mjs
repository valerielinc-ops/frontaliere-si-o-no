#!/usr/bin/env node
/**
 * check-cron-count-literals.mjs — gate zero-Claude: un test non fissa un
 * CONTEGGIO LETTERALE su un file che un cron riscrive da solo su `main`.
 *
 * IL DIFETTO (issue #9743). `tests/pharmacy-directory-country-spa.test.tsx`
 * pretendeva 266 farmacie in provincia di Varese. Il 24-09 alle 17:13
 * `sync-pharmacies-border.yml` ha riscritto `data/pharmacies-italy-border.json`
 * (268) e il test e' diventato rosso sulla stessa revisione di codice: ha
 * fermato una PR che parlava d'altro (#9724). Un numero che il cron cambia non
 * e' un contratto del codice, e' una fotografia del dato.
 *
 * COSA SEGNALA. In un file di test, un'asserzione di uguaglianza esatta con un
 * intero >= 2 — `toHaveLength(N)`, oppure `toBe/toEqual/toStrictEqual(N)` su
 * un soggetto che e' un conteggio (`.length`, `.size`, `count`, `total`) —
 * quando il soggetto deriva da un file riscritto dai cron:
 *   - un `import` del JSON (`import x from '../data/foo.json'`);
 *   - un path letterale ancorato alla root del repo (`join(ROOT, 'data',
 *     'foo.json')`, `readFileSync('data/foo.json')`, `new URL('../data/…',
 *     import.meta.url)`);
 *   - una variabile o una funzione che ne deriva, seguita a punto fisso nel
 *     file (`const rows = load(); const it = rows.filter(…)`);
 *   - un export di un modulo applicativo il cui VALORE deriva dal cron
 *     (`ITALY_BORDER_PHARMACIES` di `services/pharmacies/data`), seguito per
 *     import locali; una funzione o un componente che legge il dato vivo, quando
 *     il test la chiama o lo renderizza con sola configurazione (letterali,
 *     parametri come il `locale` di `it.each`), non con una fixture.
 * `0` e `1` non contano: «nessun duplicato» e «esattamente uno» sono
 * invarianti, non fotografie.
 *
 * COSA NON SEGNALA (limite per scelta, misurato sul repo il 2026-09-25):
 *   - le query globali del DOM (`screen.getAllByRole(…)`): non sono legate al
 *     `render` che le ha popolate, e legarle renderebbe «del cron» ogni test di
 *     componente che ne renderizza uno vivo accanto;
 *   - un numero confrontato come TESTO (`toContain(String(266))`, il caso di
 *     Varese): non e' un'uguaglianza su un conteggio;
 *   - la granularita' e' il binding, non la proprieta': un export oggetto con
 *     UNA voce derivata dal cron contamina tutte le altre (le 15 festivita' di
 *     `seo-pages.ts` accanto al tasso di cambio). Li' serve `cron-count-ok`.
 * Questi casi restano alla partizione `scripts/ci/live-data-test-guard.mjs`
 * (traccia a runtime) e alla review.
 *
 * QUALI FILE SONO «DEL CRON». Tre sorgenti, nessuna lista nuova da tenere a
 * mano per i casi ordinari:
 *   1. `CRON_MANAGED_GLOBS` (`scripts/lib/cron-managed-paths.mjs`);
 *   2. le directory e i file `data/`/`public/` di `LIVE_DATA_ROOTS`
 *      (`scripts/ci/live-data-test-guard.mjs`), misurati dai commit dei bot
 *      (non le radici di nome come `data/pharmac`: vedi `buildCronPathMatcher`);
 *   3. i path che i workflow SCHEDULATI aggiungono al commit (`git add`,
 *      `add-paths`, `file_pattern`, i `for f in …` e i `git diff --quiet`
 *      che decidono se committare), letti a runtime: un cron nuovo e' coperto
 *      senza toccare questo file.
 * `EXTRA_CRON_PATHS` qui sotto raccoglie solo i file che i bot committano da
 * workflow non schedulati o da script, misurati dalla storia di `main`.
 *
 * COME SI ESCE. Si legge il valore atteso dal dataset (`expect(x).toHaveLength(
 * rows.filter(…).length)`) o si verifica un invariante (`> 0`, schema,
 * ordinamento, unicita'). Se il numero e' davvero un contratto (26 cantoni),
 * un commento `cron-count-ok: <motivo>` sulla riga dell'asserzione o su quella
 * sopra lo dichiara; senza motivo non vale.
 *
 * DOVE GIRA. `tests/check-cron-count-literals.test.ts` esegue la scansione
 * dell'intero albero; `scripts/ci/run-related-tests.mjs` lo seleziona su ogni
 * PR che tocca un file di test (i test non sono importati da nessuno, quindi
 * il grafo inverso da solo non lo sceglierebbe mai).
 *
 * Exit codes: 0 = pulito, 1 = violazioni. `--json` stampa un report macchina.
 * Usage: node scripts/ci/check-cron-count-literals.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isCronManagedPath } from '../lib/cron-managed-paths.mjs';
import { LIVE_DATA_ROOTS } from './live-data-test-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * File riscritti dai bot ma non attraverso un workflow schedulato leggibile
 * (push, dispatch, script che committano da soli). Misura del 2026-09-24:
 *   git log origin/main --since=21.days --format='@@%an' --name-only -- data public/data
 * filtrato sugli autori bot; qui solo quelli con almeno 3 commit e non
 * coperti dalle tre sorgenti sopra. Baseline e configurazioni curate a mano
 * (`*-baseline.json`, `canton-*.json`) restano fuori: cambiano per decisione.
 */
export const EXTRA_CRON_PATHS = Object.freeze([
  'data/build-history/',
  'data/loop-fleet/',
  'data/crawler-generation-ledger.jsonl',
  'data/translation-stats-history.json',
  'data/translation-observability-history.json',
  'data/translation-observability-state.json',
  'data/translation-title-fix-attempts.json',
  'data/dist-size-history.jsonl',
  'data/url-first-seen.json',
  'data/cascade-company-skip.json',
  'data/jobs-ai-cache.json',
  'data/previous-slug-winners.json',
  'data/local-mt-negative-cache.json',
  'data/weekly-employers-top-pairs.json',
  'data/crawler-manifest.json',
  'data/crawler-companies-auto.json',
  'data/crawler-group-assignments.json',
  'data/related-search-enriched.json',
  'data/orphan-reconciliation-history.json',
  'data/orphan-indexed-job-slugs.json',
  // Coperti prima solo dalle radici di nome di `LIVE_DATA_ROOTS`
  // (`data/border-wait`, `data/gsc-orphan-queries`), ora escluse. Misura del
  // 2026-09-25 su 30 giorni: 88 e 6 commit diretti dei bot.
  'data/border-wait-averages.json',
  'data/gsc-orphan-queries.json',
]);

const WORKFLOW_WRITE_LINE_RE =
  /git add|add-paths|file_pattern|\bfor \w+ in\b|git diff (?:--cached )?--quiet|git status --porcelain/;
const DATA_PATH_RE = /(?:public\/)?data\/[A-Za-z0-9_./*{}-]+/g;

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+?^$()|[\]\\]/g, '\\$&')
    .replace(/\{[^}]*\}?/g, '.*')
    .replace(/\*+/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Path che i workflow schedulati aggiungono al commit.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function collectScheduledWorkflowWritePaths(root = ROOT) {
  const dir = path.join(root, '.github', 'workflows');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = new Set();
  for (const name of entries.sort()) {
    if (!/\.ya?ml$/i.test(name)) continue;
    let src = '';
    try { src = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    if (!/^\s*schedule:/m.test(src)) continue;
    for (const line of src.replace(/\\\n/g, ' ').split('\n')) {
      if (!WORKFLOW_WRITE_LINE_RE.test(line)) continue;
      for (const m of line.matchAll(DATA_PATH_RE)) out.add(m[0].replace(/[.]+$/, ''));
    }
  }
  return [...out].sort();
}

/**
 * Predicato unico: `repoPath` (relativo alla root, con `/`) e' un file che un
 * cron riscrive?
 *
 * @param {string} [root]
 * @returns {(repoPath: string) => boolean}
 */
export function buildCronPathMatcher(root = ROOT) {
  // Di `LIVE_DATA_ROOTS` si prendono le directory (`data/jobs/`) e i file
  // interi (`data/events.json`), non le RADICI DI NOME (`data/pharmac`,
  // `data/border-wait`): quelle servono al guard dei dati vivi, che deve
  // essere largo, ma qui prenderebbero anche le configurazioni curate a mano
  // accanto al dato. Misurato il 2026-09-25: `data/pharmac` copriva
  // `pharmacy-duties-geneva-sources.json` e `pharmacy-sources-registry.json`,
  // scritti solo da PR, e faceva segnalare come «fotografia del cron» i 365
  // giorni del calendario di Ginevra e i 26 cantoni del registro. I file del
  // cron sotto quelle radici arrivano gia' dai workflow schedulati o da
  // `EXTRA_CRON_PATHS`.
  const prefixes = [
    ...LIVE_DATA_ROOTS.filter((r) => /^(?:data|public)\//.test(r) && (r.endsWith('/') || /\.[a-z]+$/.test(r))),
    ...EXTRA_CRON_PATHS,
  ];
  const workflowPaths = collectScheduledWorkflowWritePaths(root);
  const exact = new Set();
  const regexes = [];
  for (const p of workflowPaths) {
    if (p.endsWith('/')) prefixes.push(p);
    else if (/[*{]/.test(p)) regexes.push(globToRegExp(p));
    else exact.add(p);
  }
  return (repoPath) => {
    const p = String(repoPath || '').replace(/^\.\//, '');
    if (!/^(?:public\/)?data\//.test(p)) return false;
    if (exact.has(p) || isCronManagedPath(p)) return true;
    if (prefixes.some((r) => p.startsWith(r))) return true;
    // Una directory nominata senza slash finale (`data/fuel-prices-history`).
    if ([...exact].some((e) => p.startsWith(`${e}/`))) return true;
    return regexes.some((re) => re.test(p));
  };
}

// ─── Scansione di un sorgente di test ──────────────────────────────────────

const EXACT_MATCHERS = new Set(['toHaveLength', 'toBe', 'toEqual', 'toStrictEqual']);
const COUNT_NAME_RE = /(?:^|[a-z])(?:Count|Total|Length|Size)$|^(?:count|total|length|size|n)$/;
const ESCAPE_RE = /cron-count-ok:\s*\S.{7,}/;
const PATH_JOIN_RE = /^(?:(?:path|posix|path\.posix|nodePath)\.)?(?:join|resolve)$/;
const FS_READ_RE = /(?:^|\.)(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|createReadStream|readJsonSync)$/;

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function stringValue(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** Testa costante di una stringa: `'data/x.json'` intera, `` `data/jobs/${s}` `` fino al primo `${`. */
function stringPrefix(node) {
  const v = stringValue(node);
  if (v != null) return v;
  if (node && ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

function unwrap(node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n))) n = n.expression;
  return n;
}

/**
 * Directory o file, RELATIVO ALLA ROOT DEL REPO, a cui il nodo si risolve; null
 * se non e' deducibile staticamente o se esce dal repo. E' il cuore del gate:
 * `join(root, 'data', 'jobs.json')` e' il dataset vivo solo se `root` e' la
 * root del repo (`process.cwd()`, `__dirname` + `..`, `import.meta.url`), non
 * se e' un `mkdtempSync(...)` in cui il test ha scritto la sua fixture. Il nome
 * della variabile non conta: conta da dove viene.
 *
 * @param {ts.Node} node
 * @param {{ file: string, decls: Map<string, ts.Expression[]> }} ctx
 * @returns {string|null}
 */
function repoPathOf(node, ctx, depth = 0) {
  const n = unwrap(node);
  if (!n || depth > 12) return null;
  const fileDir = path.posix.dirname(ctx.file);
  const finish = (p) => {
    const norm = path.posix.normalize(p || '.');
    if (norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm)) return null;
    return norm === '.' ? '' : norm;
  };
  if (ts.isIdentifier(n)) {
    if (n.text === '__dirname') return finish(fileDir);
    if (n.text === '__filename') return finish(ctx.file);
    const inits = ctx.decls.get(n.text);
    if (!inits || inits.length === 0) return null;
    const values = new Set(inits.map((i) => repoPathOf(i, ctx, depth + 1)));
    if (values.size !== 1) return null;
    return [...values][0];
  }
  const text = n.getText();
  if (text === 'import.meta.dirname') return finish(fileDir);
  if (text === 'import.meta.filename' || text === 'import.meta.url') return finish(ctx.file);
  if (ts.isCallExpression(n)) {
    const callee = n.expression.getText();
    const args = [...n.arguments];
    if (/^process\.cwd$/.test(callee)) return '';
    if (/(?:^|\.)fileURLToPath$/.test(callee) && args[0]) return repoPathOf(args[0], ctx, depth + 1);
    if (/(?:^|\.)dirname$/.test(callee) && args[0]) {
      const inner = repoPathOf(args[0], ctx, depth + 1);
      return inner == null ? null : finish(path.posix.dirname(inner || '.'));
    }
    if (PATH_JOIN_RE.test(callee) && args.length >= 1) {
      const base = repoPathOf(args[0], ctx, depth + 1);
      if (base == null) return null;
      const parts = [base];
      for (const a of args.slice(1)) {
        const v = stringValue(a);
        if (v == null) break; // la coda variabile resta fuori: vale il prefisso noto
        if (path.posix.isAbsolute(v)) return null;
        parts.push(v);
      }
      return finish(path.posix.join(...parts));
    }
    return null;
  }
  if (ts.isNewExpression(n) && n.expression.getText() === 'URL') {
    const args = n.arguments ? [...n.arguments] : [];
    const spec = stringValue(args[0]);
    if (spec != null && args[1] && args[1].getText() === 'import.meta.url') {
      return finish(path.posix.join(fileDir, spec));
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'pathname') return repoPathOf(n.expression, ctx, depth + 1);
  return null;
}

const isDataPath = (p) => typeof p === 'string' && /^(?:public\/)?data\//.test(p);

/**
 * Il nodo e' una lettura del dataset vivo di un cron? Restituisce il path (per
 * il report) o null.
 */
function cronReferenceOf(node, ctx, isCronPath) {
  // import x from '../data/foo.json'
  if (ts.isImportDeclaration(node)) {
    const spec = stringValue(node.moduleSpecifier);
    if (!spec || !spec.startsWith('.')) return null;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ctx.file), spec));
    return isCronPath(resolved) ? resolved : null;
  }
  const isUrl = ts.isNewExpression(node) && node.expression.getText() === 'URL';
  if (isUrl || (ts.isCallExpression(node) && PATH_JOIN_RE.test(node.expression.getText()))) {
    // Una join annidata in un'altra conta una volta sola, al livello piu' esterno.
    const parent = node.parent;
    if (parent && ts.isCallExpression(parent) && PATH_JOIN_RE.test(parent.expression.getText())
      && parent.arguments[0] === node) return null;
    const p = repoPathOf(node, ctx);
    return isDataPath(p) && isCronPath(p) ? p : null;
  }
  if (!ts.isCallExpression(node)) return null;
  // readFileSync('data/foo.json') o readJson('data/foo.json'): path relativo
  // alla cwd, cioe' alla root. Solo se il path e' il PRIMO argomento e non c'e'
  // un'altra radice accanto: `readLedger(fixture.work, 'data/x')` e
  // `mergeProspectorPath('data/x', base, upstream, local)` passano un nome, non
  // leggono il file del repo.
  const args = [...node.arguments];
  const first = stringPrefix(args[0]);
  if (first == null) return null;
  const p = first.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!isDataPath(p)) return null;
  const callee = node.expression.getText();
  const onlyEncodingAfter = args.slice(1).every((a) => stringValue(a) != null || ts.isObjectLiteralExpression(a));
  const looksLikeRead = FS_READ_RE.test(callee) ? onlyEncodingAfter : args.length === 1;
  return looksLikeRead && isCronPath(p) ? p : null;
}

/** name -> inizializzatori di tutte le `const/let name = …` del file. */
function collectDeclarations(sf) {
  const decls = new Map();
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const list = decls.get(n.name.text) || [];
      list.push(n.initializer);
      decls.set(n.name.text, list);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return decls;
}

// ─── Letture INDIRETTE: il grafo degli import locali ───────────────────────
//
// Il caso che ha aperto #9743 non nominava il dataset: il test importava
// `ITALY_BORDER_PHARMACIES` da `services/pharmacies/data`, che importa
// `data/pharmacies-italy-border.json`. Un gate che guarda solo il file di test
// non l'avrebbe visto.
//
// La prima stesura marcava «del cron» ogni binding importato da un modulo che
// RAGGIUNGE un file del cron: 450 segnalazioni su 202 file, quasi tutte parser
// di crawler chiamati su una fixture (`parseSodexoListing(doubled)`), perche'
// quasi ogni crawler importa, da qualche parte, il registro degli slug. Rumore
// che avrebbe insegnato a ignorare il gate. Qui la contaminazione segue il
// BINDING, non il modulo: un export e' del cron solo se il SUO valore ne deriva
// (`ITALY_BORDER_PHARMACIES = italyBorderJson.pharmacies.map(…)` si',
// `ITALY_BORDER_PROVINCES = [{ code: 'CO' … }]` accanto no), con la stessa
// propagazione a punto fisso del file di test applicata al modulo.
//
// Le FUNZIONI e i COMPONENTI esportati che leggono il dato vivo contano solo
// dove il test li usa come interrogazione del dataset: chiamate senza
// argomenti (`pharmacyPageDescriptors()`), con soli letterali
// (`pharmaciesForProvince('VA')`) o con parametri della funzione che le
// racchiude (il `locale` di `it.each`), e allo stesso modo un
// `render(<PharmacyDirectory page={{ kind: 'country', locale }} />)`. Chiamate
// e props con una fixture o un valore del test non sono una lettura del cron —
// e se l'argomento stesso viene dal cron, lo vede gia' la propagazione sugli
// argomenti.

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mjs', '.js', '.mts', '.cjs', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;

function resolveModule(spec, fromRel, root) {
  let rel;
  if (spec.startsWith('.')) rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  else if (spec.startsWith('@/')) rel = path.posix.normalize(spec.slice(2));
  else return null; // pacchetto npm: fuori dal grafo del repo
  if (rel.startsWith('../')) return null;
  // I dati non si risolvono con uno stat: nel worktree sparse `data/` non c'e',
  // ma l'import esiste lo stesso.
  if (isDataPath(rel)) return rel;
  for (const ext of RESOLVE_EXTS) {
    const cand = rel + ext;
    try {
      if (fs.statSync(path.join(root, cand)).isFile()) return cand;
    } catch { /* prossimo candidato */ }
  }
  return null;
}

function bindingIdentifiers(nameNode, acc = []) {
  if (!nameNode) return acc;
  if (ts.isIdentifier(nameNode)) acc.push(nameNode);
  else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) if (!ts.isOmittedExpression(el)) bindingIdentifiers(el.name, acc);
  }
  return acc;
}

/**
 * Checker di TypeScript sul SOLO file di test (niente lib, niente import
 * risolti): serve a legare ogni identificatore alla sua dichiarazione. Senza,
 * un `const groups = readJson('data/…')` in un `it` renderebbe «dato del cron»
 * ogni altro `groups` del file, anche quello costruito da una fixture.
 */
function checkerFor(sf) {
  const target = path.posix.resolve('/', sf.fileName);
  const host = {
    getSourceFile: (name) => (path.posix.resolve('/', name) === target ? sf : undefined),
    getDefaultLibFileName: () => '/__no_lib__.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (name) => path.posix.resolve('/', name) === target,
    readFile: () => undefined,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const options = { noResolve: true, noLib: true, allowJs: true, types: [], jsx: ts.JsxEmit.Preserve };
  return ts.createProgram([sf.fileName], options, host).getTypeChecker();
}

/**
 * Il checker costa quanto il parse del file: lo si crea solo se il file ha
 * davvero qualcosa da legare (un seme o un import del cron). Su ~1.500 test
 * scansionati la maggior parte non ne ha.
 */
function lazyCheckerFor(sf) {
  let real = null;
  const get = () => {
    if (!real) real = checkerFor(sf);
    return real;
  };
  return {
    getSymbolAtLocation: (node) => get().getSymbolAtLocation(node),
    getShorthandAssignmentValueSymbol: (node) => get().getShorthandAssignmentValueSymbol(node),
  };
}

/**
 * Chiave di binding di un identificatore: il simbolo, o il nome se il checker
 * non lo lega. Il checker serve anche nei moduli: per nome, il `const raw =
 * JSON.parse(…)` di una funzione contaminerebbe ogni altro `raw` del file.
 */
function bindingKey(checker, id) {
  if (!checker) return `name:${id.text}`;
  const parent = id.parent;
  let sym;
  try {
    sym = parent && ts.isShorthandPropertyAssignment(parent) && parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(id);
  } catch { sym = undefined; }
  return sym || `name:${id.text}`;
}

/** L'identificatore e' un USO di un binding (non il nome di una proprieta')? */
function isReference(id) {
  const p = id.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)
    || ts.isMethodDeclaration(p) || ts.isJsxAttribute(p)) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return false;
  return true;
}

function unwrapInit(node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)) || ts.isTypeAssertionExpression(n))) n = n.expression;
  return n;
}

function isCallableInit(init) {
  const n = unwrapInit(init);
  return Boolean(n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isClassExpression(n)));
}

function isPrimitiveLiteral(n) {
  if (!n) return false;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return true;
  if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(n) && n.text === 'undefined') return true;
  return ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand);
}

/**
 * Il valore e' il parametro di una funzione che lo racchiude? E' il caso di
 * `it.each(locales)('…', (locale) => …)` e del componente che inoltra le sue
 * props: un selettore, non un dato scritto nel test.
 */
function isParameterReference(id, checker) {
  if (!checker) return false;
  let sym;
  try { sym = checker.getSymbolAtLocation(id); } catch { sym = undefined; }
  const decl = sym && (sym.valueDeclaration || (sym.declarations && sym.declarations[0]));
  if (!decl) return false;
  // Anche il binding destrutturato di un parametro: `({ locale }) => …`.
  let n = decl;
  while (n && (ts.isBindingElement(n) || ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n))) n = n.parent;
  return Boolean(n && ts.isParameter(n));
}

/**
 * Un argomento (o una prop) «di configurazione»: un letterale primitivo, un
 * array di primitivi, un parametro della funzione che racchiude la chiamata,
 * un oggetto di opzioni fatto di quelli. `pharmaciesForProvince('VA')` e
 * `<PharmacyDirectory page={{ kind: 'country', locale }} />` interrogano il
 * dataset; `parseListing(fixture)` elabora un dato del test. Un array di
 * OGGETTI e' una fixture scritta in linea (`buildTargets([{ key: 'alpha' }])`),
 * non una configurazione.
 */
function isConfigArg(node, checker) {
  const n = unwrapInit(node);
  if (!n) return false;
  if (isPrimitiveLiteral(n)) return true;
  if (ts.isIdentifier(n)) return isParameterReference(n, checker);
  if (ts.isArrayLiteralExpression(n)) return n.elements.every((el) => isPrimitiveLiteral(unwrapInit(el)));
  if (ts.isObjectLiteralExpression(n)) {
    return n.properties.every((p) => (ts.isPropertyAssignment(p) && isConfigArg(p.initializer, checker))
      || (ts.isShorthandPropertyAssignment(p) && isParameterReferenceShorthand(p, checker)));
  }
  return false;
}

function isParameterReferenceShorthand(prop, checker) {
  if (!checker) return false;
  let sym;
  try { sym = checker.getShorthandAssignmentValueSymbol(prop); } catch { sym = undefined; }
  const decl = sym && (sym.valueDeclaration || (sym.declarations && sym.declarations[0]));
  let n = decl;
  while (n && (ts.isBindingElement(n) || ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n))) n = n.parent;
  return Boolean(n && ts.isParameter(n));
}

const isLiveCall = (call, checker) => [...(call.arguments || [])].every((a) => isConfigArg(a, checker));

/** Un elemento JSX di un componente del cron, renderizzato con sole props di configurazione. */
function isLiveJsx(element, checker) {
  return element.attributes.properties.every((attr) => {
    if (!ts.isJsxAttribute(attr)) return false; // {...spread}: puo' portare una fixture
    const init = attr.initializer;
    if (!init || ts.isStringLiteral(init)) return true;
    if (ts.isJsxExpression(init)) return !init.expression || isConfigArg(init.expression, checker);
    return false;
  });
}

/** Binding di una `import`: `{ id, imported }`, con `imported` = 'default' | '*' | nome esportato. */
function importBindings(stmt) {
  const clause = stmt.importClause;
  if (!clause || clause.isTypeOnly) return [];
  const out = [];
  if (clause.name) out.push({ id: clause.name, imported: 'default' });
  const nb = clause.namedBindings;
  if (nb && ts.isNamespaceImport(nb)) out.push({ id: nb.name, imported: '*' });
  if (nb && ts.isNamedImports(nb)) {
    for (const el of nb.elements) if (!el.isTypeOnly) out.push({ id: el.name, imported: (el.propertyName || el.name).text });
  }
  return out;
}

/**
 * Propagazione a punto fisso dentro UN sorgente, comune a test e moduli.
 *
 * @param {ts.SourceFile} sf
 * @param {(p: string) => boolean} isCronPath
 * @param {{ checker?: ts.TypeChecker|null, importTaint?: ((stmt: ts.ImportDeclaration, imported: string) => any)|null }} opts
 *   `importTaint` restituisce, per un binding importato, `{ paths, callable }`
 *   (o, per `import * as ns`, una Map nome -> `{ paths, callable }`), null se
 *   il binding non deriva dal cron.
 */
function propagateTaint(sf, isCronPath, { checker = null, importTaint = null } = {}) {
  const ctx = { file: sf.fileName, decls: collectDeclarations(sf) };
  const seeds = new Map(); // node -> cron path
  const collectSeeds = (n) => {
    const ref = cronReferenceOf(n, ctx, isCronPath);
    if (ref) seeds.set(n, ref);
    ts.forEachChild(n, collectSeeds);
  };
  collectSeeds(sf);

  const tainted = new Map(); // binding key -> Set<cron path>
  const callables = new Map(); // binding key -> { paths, callable: true } (funzioni importate)
  const namespaces = new Map(); // binding key -> Map<nome, { paths, callable }>
  const taint = (ids, paths) => {
    if (!paths || paths.size === 0) return false;
    let changed = false;
    for (const id of ids) {
      const key = bindingKey(checker, id);
      const cur = tainted.get(key) || new Set();
      const before = cur.size;
      for (const p of paths) cur.add(p);
      if (!tainted.has(key) || cur.size !== before) changed = true;
      tainted.set(key, cur);
    }
    return changed;
  };

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = importBindings(stmt);
    // import x from '../data/foo.json': ogni binding del modulo JSON e' il dato.
    if (seeds.has(stmt)) {
      taint(bindings.map((b) => b.id), new Set([seeds.get(stmt)]));
      continue;
    }
    if (!importTaint) continue;
    for (const b of bindings) {
      const info = importTaint(stmt, b.imported);
      if (!info) continue;
      const key = bindingKey(checker, b.id);
      if (b.imported === '*') {
        if (info.size > 0) namespaces.set(key, info);
      } else if (info.callable) {
        callables.set(key, info);
      } else {
        taint([b.id], info.paths);
      }
    }
  }

  // Niente semi e niente import del cron: nessun binding puo' derivarne.
  if (seeds.size === 0 && tainted.size === 0 && callables.size === 0 && namespaces.size === 0) {
    return { tainted, callables, namespaces, pathsIn: () => new Set() };
  }

  /** Path del cron raggiunti dal sottoalbero (vuoto = non deriva dal cron). */
  const pathsIn = (node) => {
    const out = new Set();
    const add = (paths) => { if (paths) for (const p of paths) out.add(p); };
    const visit = (n) => {
      if (seeds.has(n) && !ts.isImportDeclaration(n)) out.add(seeds.get(n));
      if (ts.isIdentifier(n) && isReference(n)) {
        const key = bindingKey(checker, n);
        add(tainted.get(key));
        const fn = callables.get(key);
        const parent = n.parent;
        if (fn && parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent))
          && parent.expression === n && isLiveCall(parent, checker)) add(fn.paths);
        if (fn && parent && (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent))
          && parent.tagName === n && isLiveJsx(parent, checker)) add(fn.paths);
        const ns = namespaces.get(key);
        if (ns && parent && ts.isPropertyAccessExpression(parent) && parent.expression === n) {
          const member = ns.get(parent.name.text);
          const call = parent.parent;
          if (member && !member.callable) add(member.paths);
          else if (member && call && ts.isCallExpression(call) && call.expression === parent && isLiveCall(call, checker)) add(member.paths);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };

  // Punto fisso: variabili, funzioni e assegnazioni che derivano da un seme.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        changed = taint(bindingIdentifiers(n.name), pathsIn(n.initializer)) || changed;
      } else if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.body) {
        changed = taint([n.name], pathsIn(n.body)) || changed;
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
        changed = taint([n.left], pathsIn(n.right)) || changed;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!changed) break;
  }

  return { tainted, callables, namespaces, pathsIn };
}

const hasModifier = (node, kind) => Boolean(node.modifiers && node.modifiers.some((m) => m.kind === kind));

/**
 * Export di un modulo applicativo che derivano dal cron: nome -> `{ paths,
 * callable }`. Un modulo gia' in analisi (ciclo di import) vale «nessun export
 * del cron» per il ramo che chiude il ciclo: l'esito di un ciclo puo' dipendere
 * dall'ordine di visita, ma solo verso un falso negativo, mai verso un rosso
 * che non c'e'.
 */
function createExportIndex(root, isCronPath) {
  const parsed = new Map();
  const parse = (rel) => {
    if (parsed.has(rel)) return parsed.get(rel);
    let sf = null;
    if (CODE_FILE_RE.test(rel)) {
      try {
        const src = fs.readFileSync(path.join(root, rel), 'utf8');
        sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
      } catch { sf = null; }
    }
    parsed.set(rel, sf);
    return sf;
  };
  const cache = new Map();
  const inProgress = new Set();
  const EMPTY = new Map();

  const exportsOf = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    if (isDataPath(rel)) {
      // `export { default as X } from '../data/x.json'`: il modulo JSON e' il dato.
      const m = new Map();
      if (isCronPath(rel)) m.set('default', { paths: new Set([rel]), callable: false });
      cache.set(rel, m);
      return m;
    }
    if (inProgress.has(rel)) return EMPTY;
    const sf = parse(rel);
    if (!sf) return EMPTY;
    inProgress.add(rel);
    const importTaint = (stmt, imported) => {
      const spec = stringValue(stmt.moduleSpecifier);
      const to = spec ? resolveModule(spec, rel, root) : null;
      if (!to) return null;
      const ex = exportsOf(to);
      if (imported === '*') return ex;
      return ex.get(imported) || null;
    };
    // Il checker serve anche qui: per nome, il `const raw = JSON.parse(…)` di
    // una funzione che legge la cache dei geocoding contaminava ogni altro
    // `raw` del modulo (misurato su `scripts/lib/events-utils.mjs`, dove
    // `loadAllComuni()` legge soltanto l'elenco statico dei comuni).
    const checker = lazyCheckerFor(sf);
    const { tainted, callables, pathsIn } = propagateTaint(sf, isCronPath, { checker, importTaint });
    const topLevel = new Map(); // nome -> { id, callable }
    for (const st of sf.statements) {
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) topLevel.set(st.name.text, { id: st.name, callable: true });
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          for (const id of bindingIdentifiers(d.name)) {
            topLevel.set(id.text, { id, callable: ts.isIdentifier(d.name) && isCallableInit(d.initializer) });
          }
        }
      }
      if (ts.isImportDeclaration(st)) {
        for (const b of importBindings(st)) topLevel.set(b.id.text, { id: b.id, callable: false });
      }
    }
    const localInfo = (name) => {
      if (tainted.size === 0 && callables.size === 0) return null;
      const decl = topLevel.get(name);
      if (!decl) return null;
      const key = bindingKey(checker, decl.id);
      if (callables.has(key)) return callables.get(key);
      const paths = tainted.get(key);
      return paths && paths.size > 0 ? { paths, callable: decl.callable } : null;
    };
    const out = new Map();
    for (const st of sf.statements) {
      const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
      if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
        const info = localInfo(st.name.text);
        if (info) out.set(isDefault ? 'default' : st.name.text, info);
      } else if (exported && ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          for (const id of bindingIdentifiers(d.name)) {
            const info = localInfo(id.text);
            if (info) out.set(id.text, info);
          }
        }
      } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
        const expr = unwrapInit(st.expression);
        const info = expr && ts.isIdentifier(expr) ? localInfo(expr.text) : null;
        const paths = info ? info.paths : pathsIn(st.expression);
        if (paths.size > 0) out.set('default', { paths, callable: info ? info.callable : isCallableInit(st.expression) });
      } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
        const spec = st.moduleSpecifier ? stringValue(st.moduleSpecifier) : null;
        const to = spec ? resolveModule(spec, rel, root) : null;
        const from = to ? exportsOf(to) : null;
        const clause = st.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const el of clause.elements) {
            if (el.isTypeOnly) continue;
            const local = (el.propertyName || el.name).text;
            const info = spec ? (from && from.get(local)) : localInfo(local);
            if (info) out.set(el.name.text, info);
          }
        } else if (!clause && from) {
          for (const [name, info] of from) if (name !== 'default' && !out.has(name)) out.set(name, info);
        }
      }
    }
    inProgress.delete(rel);
    cache.set(rel, out);
    return out;
  };
  return { exportsOf, parse };
}

/** Il receiver `expect(<subject>)` di una catena `expect(x).not.toBe(…)`. */
function expectSubjectOf(matcherCall) {
  let obj = matcherCall.expression.expression; // prima del `.toX`
  let negated = false;
  while (obj && ts.isPropertyAccessExpression(obj)) {
    if (obj.name.text === 'not') negated = true;
    obj = obj.expression;
  }
  if (!obj || !ts.isCallExpression(obj)) return null;
  const callee = obj.expression.getText();
  if (callee !== 'expect' && callee !== 'expect.soft') return null;
  return { subject: obj.arguments[0], negated };
}

function integerLiteral(node) {
  if (node && ts.isNumericLiteral(node)) {
    const v = Number(node.text.replace(/_/g, ''));
    return Number.isInteger(v) ? v : null;
  }
  return null;
}

/**
 * Il valore atteso e' una fotografia? Un intero >= 2, oppure (per
 * `toEqual`/`toStrictEqual`) un array di interi letterali con almeno un
 * elemento >= 2 — `expect(provinces.map((p) => p.duties.length)).toEqual([2, 3, 0])`.
 * `0` e `1` da soli sono invarianti («nessuno», «esattamente uno»).
 */
function pinnedCount(node, matcher) {
  const v = integerLiteral(node);
  if (v != null) return v >= 2 ? v : null;
  if (node && ts.isArrayLiteralExpression(node) && (matcher === 'toEqual' || matcher === 'toStrictEqual')
    && node.elements.length > 0) {
    const values = node.elements.map((el) => integerLiteral(el));
    if (values.every((x) => x != null) && values.some((x) => x >= 2)) return Math.max(...values);
  }
  return null;
}

function isCountLike(subject) {
  const n = unwrap(subject);
  if (!n) return false;
  if (ts.isPropertyAccessExpression(n)) return COUNT_NAME_RE.test(n.name.text);
  if (ts.isIdentifier(n)) return COUNT_NAME_RE.test(n.text);
  if (ts.isCallExpression(n)) {
    const callee = n.expression;
    // xs.map((x) => x.duties.length): un array di conteggi.
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'map') {
      const cb = n.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && !ts.isBlock(cb.body)) return isCountLike(cb.body);
      return false;
    }
    if (ts.isPropertyAccessExpression(callee)) return /^(?:count|size|length)$/i.test(callee.name.text);
    if (ts.isIdentifier(callee)) return /^(?:count|size)/i.test(callee.text);
  }
  return false;
}

function hasEscapeComment(sf, node) {
  const lines = sf.text.split('\n');
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
  for (let l = Math.max(0, line - 1); l <= end; l++) {
    if (ESCAPE_RE.test(lines[l] || '')) return true;
  }
  return false;
}

/** Moduli sostituiti da `vi.mock(...)`: nel test il loro export non e' il dato vivo. */
function mockedModules(sf, file, root) {
  const out = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n) && /^(?:vi|vitest)\.(?:mock|doMock)$/.test(n.expression.getText()) && n.arguments[0]) {
      const spec = stringValue(n.arguments[0]);
      const to = spec ? resolveModule(spec, file, root) : null;
      if (to) out.add(to);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * @param {string} source contenuto del file di test
 * @param {string} file path relativo alla root (serve a risolvere gli import)
 * @param {(p: string) => boolean} isCronPath
 * @param {{ exportsOf?: ((rel: string) => Map<string, { paths: Set<string>, callable: boolean }>)|null, root?: string }} [opts]
 * @returns {{ file: string, line: number, matcher: string, value: number, cronPaths: string[], text: string }[]}
 */
export function scanTestSource(source, file, isCronPath, { exportsOf = null, root = ROOT } = {}) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const mocked = exportsOf ? mockedModules(sf, file, root) : new Set();
  const importTaint = exportsOf
    ? (stmt, imported) => {
      const spec = stringValue(stmt.moduleSpecifier);
      const to = spec ? resolveModule(spec, file, root) : null;
      if (!to || mocked.has(to)) return null;
      const ex = exportsOf(to);
      if (imported === '*') return ex;
      return ex.get(imported) || null;
    }
    : null;
  const { pathsIn } = propagateTaint(sf, isCronPath, { checker: lazyCheckerFor(sf), importTaint });

  const violations = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && EXACT_MATCHERS.has(n.expression.name.text)) {
      const matcher = n.expression.name.text;
      const value = pinnedCount(n.arguments[0], matcher);
      const exp = expectSubjectOf(n);
      if (value != null && exp && !exp.negated && exp.subject
        && (matcher === 'toHaveLength' || isCountLike(exp.subject))
        && !hasEscapeComment(sf, n)) {
        const cronPaths = pathsIn(exp.subject);
        if (cronPaths.size > 0) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          violations.push({
            file,
            line: line + 1,
            matcher,
            value,
            cronPaths: [...cronPaths].sort(),
            text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 160),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return violations;
}

const PREFILTER_RE = /\.to(?:HaveLength|Be|Equal|StrictEqual)\(\s*\[?\s*\d/;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function listTestFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '__snapshots__') continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (TEST_FILE_RE.test(e.name)) out.push(r);
    }
  };
  walk(path.join(root, 'tests'), 'tests');
  const pkgs = path.join(root, 'packages');
  let pkgEntries = [];
  try { pkgEntries = fs.readdirSync(pkgs, { withFileTypes: true }); } catch { /* sparse */ }
  for (const p of pkgEntries) if (p.isDirectory()) walk(path.join(pkgs, p.name, 'tests'), `packages/${p.name}/tests`);
  return out.sort();
}

/**
 * @param {string} [root]
 */
export function scanRepository(root = ROOT) {
  const isCronPath = buildCronPathMatcher(root);
  const { exportsOf } = createExportIndex(root, isCronPath);
  const files = listTestFiles(root);
  const violations = [];
  for (const file of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    // Prefiltro: senza un'uguaglianza con un numero letterale non c'e' niente da vedere.
    if (!PREFILTER_RE.test(src)) continue;
    violations.push(...scanTestSource(src, file, isCronPath, { exportsOf, root }));
  }
  return { scanned: files.length, violations };
}

function main() {
  const json = process.argv.includes('--json');
  const { scanned, violations } = scanRepository(ROOT);
  if (json) {
    process.stdout.write(`${JSON.stringify({ scanned, violations }, null, 2)}\n`);
  } else if (violations.length === 0) {
    console.log(`check-cron-count-literals: OK (${scanned} file di test, nessun conteggio letterale su dati dei cron)`);
  } else {
    console.error(`check-cron-count-literals: ${violations.length} conteggi letterali su file riscritti dai cron:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}  <- ${v.cronPaths.join(', ')}`);
    }
    console.error('Leggi il valore atteso dal dataset o verifica un invariante (> 0, schema, ordinamento).');
    console.error('Se il numero e\' un contratto vero, dichiaralo con `// cron-count-ok: <motivo>`. Issue #9743.');
  }
  process.exitCode = violations.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
