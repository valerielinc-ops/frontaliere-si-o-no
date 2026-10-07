/**
 * Guard di entrypoint: identità del modulo, non suffisso del path (#7292).
 *
 * L'osservatore percorre tutte le radici di codice materializzate dal profilo
 * sparse del checkout. Un nuovo guard ESM deve usare la forma canonica con
 * realpath oppure l'helper condiviso `isInvokedDirectly(import.meta.url)`.
 *
 * Le forme canoniche sono due. Quella a un lato canonicalizza `process.argv[1]`
 * e la confronta con `import.meta.url`. Quella a due lati passa da `realpathSync`
 * anche il modulo: e' la forma che il repository pubblicatore pretende dai propri
 * entrypoint (`generator/tests/main-guard-followups.test.mjs` la'), quindi un
 * gemello identico puo' viaggiare solo con quella. Finche' qui era ammessa solo
 * la prima, `scripts/ci/claude-codex-fallback.mjs` non aveva un testo che
 * passasse nei due repository, e il trasporto di 25 gemelli e' rimasto rosso
 * (PR 2439 del pubblicatore, 2026-10-07).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const CLASSIFY_SAMPLE = path.join(ROOT, 'scripts/lib/classify-issue.mjs');
const PATH_RESOLVE_SAMPLE = path.join(ROOT, 'scripts/lib/pr-body-generator-contract.mjs');
const FILE_URL_SAMPLE = path.join(ROOT, 'scripts/ci/validate-modified-workflows.mjs');

const CENSUS_ROOTS = [
  'scripts',
  'build-plugins',
  'packages/articles/engine',
  'functions',
  'infra',
];
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'public',
  'data',
  '.cache',
  'cache',
  'fixtures',
  '__fixtures__',
  'fixture',
]);
const CODE_FILE_RE = /\.(mjs|js|ts|tsx)$/;
const ONE_SIDED_GUARD_RE = /pathToFileURL\(\s*(?:[A-Za-z_$][\w$]*\.)?realpathSync\(\s*process\.argv\[1\]\s*\)\s*\)\.href/;
const TWO_SIDED_GUARD_RE = /(?:[A-Za-z_$][\w$]*\.)?realpathSync\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*===\s*(?:[A-Za-z_$][\w$]*\.)?realpathSync\(\s*process\.argv\[1\](?:\s*\|\|\s*(?:''|""))?\s*\)/;
const isCanonicalGuard = (text: string) => ONE_SIDED_GUARD_RE.test(text) || TWO_SIDED_GUARD_RE.test(text);
// Gemelli identici i cui guard sono fissati anche dal test del pubblicatore.
const TWO_SIDED_TWINS = ['scripts/ci/claude-codex-fallback.mjs'];
const HELPER_GUARD_RE = /isInvokedDirectly\(\s*import\.meta\.url\s*\)/;

const runNode = (entry: string, args: string[], options: Record<string, unknown> = {}) =>
  execFileSync(process.execPath, [entry, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });

function walkCodeFiles(dir: string, files: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkCodeFiles(full, files);
    else if (entry.isFile() && CODE_FILE_RE.test(entry.name)) files.push(full);
  }
}

type GuardFacts = {
  arg: boolean;
  meta: boolean;
  marker: boolean;
  canonical: boolean;
};

function factsForSource(source: string): GuardFacts {
  return {
    arg: /process\.argv\s*\[\s*1\s*\]/.test(source),
    meta: /import\.meta\.(?:url|filename)|fileURLToPath\(\s*import\.meta\.url|new\s+URL\(\s*import\.meta\.url/.test(source),
    marker: /__filename|SCRIPT_PATH|endsWith\s*\(|basename\s*\(/.test(source),
    canonical: isCanonicalGuard(source),
  };
}

function mergeFacts(target: GuardFacts, source: GuardFacts) {
  target.arg ||= source.arg;
  target.meta ||= source.meta;
  target.marker ||= source.marker;
  target.canonical ||= source.canonical;
}

type BabelNode = {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number } };
  [key: string]: any;
};

function babelChildren(node: BabelNode) {
  const children: BabelNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') children.push(item);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      children.push(value);
    }
  }
  return children;
}

function censusFile(file: string, parse: (source: string) => { type: string; [key: string]: any }) {
  const source = readFileSync(file, 'utf8');
  if (HELPER_GUARD_RE.test(source)) return [];

  const ast = parse(source) as BabelNode;
  const bindings = new Map<string, Array<{ init: BabelNode; start: number }>>();
  const nodes: BabelNode[] = [];
  const nodeText = (node: BabelNode) => source.slice(node.start, node.end);

  function collect(node: BabelNode) {
    nodes.push(node);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      const current = bindings.get(node.id.name) ?? [];
      current.push({ init: node.init, start: node.start });
      bindings.set(node.id.name, current);
    }
    for (const child of babelChildren(node)) collect(child);
  }
  collect(ast);

  function bindingFor(name: string, position: number) {
    const candidates = bindings.get(name) ?? [];
    let selected: { init: BabelNode; start: number } | undefined;
    for (const candidate of candidates) {
      if (candidate.start < position && (!selected || candidate.start > selected.start)) selected = candidate;
    }
    return selected;
  }

  const memo = new Map<string, GuardFacts>();
  function facts(node: BabelNode, stack = new Set<string>(), position = node.start): GuardFacts {
    if (node.type === 'Identifier') {
      const binding = bindingFor(node.name, position);
      if (binding) {
        const key = `${node.name}:${binding.start}`;
        if (!stack.has(key)) {
          const cached = memo.get(key);
          if (cached) return cached;
          const next = new Set(stack);
          next.add(key);
          const resolved = facts(binding.init, next, binding.start);
          memo.set(key, resolved);
          return resolved;
        }
      }
    }

    const result = factsForSource(nodeText(node));
    for (const child of babelChildren(node)) mergeFacts(result, facts(child, stack, child.start));
    return result;
  }

  const identityNodes: BabelNode[] = [];
  const suffixNodes: BabelNode[] = [];
  for (const node of nodes) {
    if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node.operator)) {
      const left = facts(node.left);
      const right = facts(node.right);
      const isIdentity = (left.arg && (right.meta || right.marker)) || (right.arg && (left.meta || left.marker));
      if (isIdentity && !isCanonicalGuard(nodeText(node))) identityNodes.push(node);
    }
    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && /\.endsWith\s*\(/.test(nodeText(node))) {
      const current = facts(node);
      if (current.arg && (current.meta || current.marker) && !isCanonicalGuard(nodeText(node))) suffixNodes.push(node);
    }
  }

  const inside = (inner: BabelNode, outer: BabelNode) =>
    inner.start >= outer.start
    && inner.end <= outer.end
    && (inner.start !== outer.start || inner.end !== outer.end);
  const selected: BabelNode[] = [];
  for (const node of nodes) {
    if (node.type !== 'LogicalExpression' || node.operator !== '||') continue;
    const currentText = nodeText(node);
    if (!/endsWith\s*\(|basename\s*\(/.test(currentText)) continue;
    const hasIdentity = identityNodes.some((candidate) => inside(candidate, node));
    const hasSuffix = suffixNodes.some((candidate) => inside(candidate, node));
    const current = facts(node);
    if ((hasIdentity && hasSuffix || isCanonicalGuard(currentText) && hasSuffix)
      && current.arg && (current.meta || current.marker)) selected.push(node);
  }
  for (const node of identityNodes) if (!selected.some((outer) => inside(node, outer))) selected.push(node);
  for (const node of suffixNodes) {
    if (selected.some((outer) => inside(node, outer))) continue;
    if (selected.some((outer) => outer.start === node.start && outer.end === node.end)) continue;
    selected.push(node);
  }

  return selected.map((node) => `${path.relative(ROOT, file)}:${node.loc?.start.line ?? 0}`);
}

async function censusEntrypointGuards() {
  const parserModule = await import('@babel/parser');
  const parse = ((parserModule as any).parse ?? (parserModule as any).default?.parse) as (source: string, options: Record<string, unknown>) => BabelNode;
  const roots = CENSUS_ROOTS
    .map((relative) => path.join(ROOT, relative))
    .filter((directory) => existsSync(directory) && statSync(directory).isDirectory());
  const files: string[] = [];
  for (const root of roots) walkCodeFiles(root, files);

  const offenders: string[] = [];
  for (const file of files) {
    try {
      offenders.push(...censusFile(file, (source) => parse(source, {
        sourceType: 'module',
        errorRecovery: true,
        plugins: ['importMeta', 'topLevelAwait', 'jsx', 'typescript', 'classProperties', 'decorators-legacy'],
      })));
    } catch (error) {
      offenders.push(`${path.relative(ROOT, file)}:parse-error:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { roots, files, offenders: [...new Set(offenders)] };
}

describe('guard di entrypoint canonico (#7292)', () => {
  it('non esegue il CLI da un entrypoint diverso col medesimo basename', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'entrypoint-guard-'));
    // Stesso NOME FILE, path diverso: l'identità del modulo no.
    const impostor = path.join(dir, 'classify-issue.mjs');
    writeFileSync(impostor, `import ${JSON.stringify(CLASSIFY_SAMPLE)};\n`);

    const out = runNode(impostor, ['crawler rotto', '[]']);

    expect(out).toBe('');
  });

  it('esegue il CLI quando invocato attraverso un symlink al modulo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'entrypoint-guard-'));
    const link = path.join(dir, 'classify-issue.mjs');
    symlinkSync(CLASSIFY_SAMPLE, link);

    const out = runNode(link, ['crawler rotto', '[]']);

    expect(out).not.toBe('');
    expect(JSON.parse(out)).toHaveProperty('category');
  });

  it('censisce tutte le radici materializzate e rifiuta ogni guard non canonico', async () => {
    const census = await censusEntrypointGuards();

    expect(census.roots.length).toBeGreaterThan(0);
    expect(census.files.length).toBeGreaterThan(0);
    expect(census.offenders).toEqual([]);
  });

  it('la forma a due lati esegue dal symlink e non dall\'omonimo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'entrypoint-guard-'));
    const moduleDir = path.join(dir, 'real');
    const impostorDir = path.join(dir, 'other');
    mkdirSync(moduleDir);
    mkdirSync(impostorDir);
    const entry = path.join(moduleDir, 'two-sided.mjs');
    writeFileSync(entry, [
      "import fs from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      'const invokedDirectly = (() => {',
      '  try {',
      "    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '');",
      '  } catch {',
      '    return false;',
      '  }',
      '})();',
      "if (invokedDirectly) process.stdout.write('ran');",
      '',
    ].join('\n'));
    expect(TWO_SIDED_GUARD_RE.test(readFileSync(entry, 'utf8'))).toBe(true);

    const link = path.join(dir, 'link.mjs');
    symlinkSync(entry, link);
    expect(runNode(link, [])).toBe('ran');
    expect(runNode(entry, [])).toBe('ran');

    const impostor = path.join(impostorDir, 'two-sided.mjs');
    writeFileSync(impostor, `import ${JSON.stringify(entry)};\n`);
    expect(runNode(impostor, [])).toBe('');
  });

  it('i gemelli fissati anche dal pubblicatore usano la forma a due lati', () => {
    for (const relative of TWO_SIDED_TWINS) {
      const source = readFileSync(path.join(ROOT, relative), 'utf8');
      const guard = source.slice(source.lastIndexOf('const invokedDirectly'));

      // Le quattro asserzioni del test del pubblicatore, alla lettera: un testo
      // che non le passa qui non puo' essere trasportato la'.
      expect(guard, relative).toMatch(/realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
      expect(guard, relative).toMatch(/realpathSync\(process\.argv\[1\]\s*\|\|\s*['"]['"]\)/);
      expect(guard, relative).not.toMatch(/pathToFileURL\(process\.argv\[1\]/);
      expect(guard, relative).not.toMatch(/path\.resolve\(process\.argv\[1\]\)/);
      expect(TWO_SIDED_GUARD_RE.test(guard), relative).toBe(true);
    }
  });

  it('il selettore dei test correlati fa girare questo censimento sul suo perimetro', () => {
    // Il censimento legge l'albero da disco: senza questa voce uno script nuovo
    // con un guard non canonico entra su main senza che il test giri.
    const runner = readFileSync(path.join(ROOT, 'scripts/ci/run-related-tests.mjs'), 'utf8');
    const entry = /\[\s*'tests\/entrypoint-guard-identity\.test\.ts',\s*\/(.+)\/,?\s*\]/.exec(runner);
    expect(entry, 'voce assente in sourceTreeLintTests').not.toBeNull();

    const perimeter = new RegExp(entry![1]);
    for (const root of CENSUS_ROOTS) {
      for (const extension of ['mjs', 'js', 'ts', 'tsx']) {
        expect(perimeter.test(`${root}/nuovo/script.${extension}`), `${root} .${extension}`).toBe(true);
      }
    }
    expect(perimeter.test('docs/nota.md')).toBe(false);
    expect(perimeter.test('tests/qualcosa.test.ts')).toBe(false);
  });

  it('mantiene i campioni di comportamento delle due famiglie convertite', () => {
    const pathResolveOut = runNode(PATH_RESOLVE_SAMPLE, ['--closing-ref'], {
      input: JSON.stringify({ number: 7292, title: 'guard', body: '' }),
    });
    expect(pathResolveOut.trim()).toBe('Closes #7292');

    const fileUrlOut = runNode(FILE_URL_SAMPLE, []);
    expect(fileUrlOut).toMatch(/^(?:Nessun workflow modificato|Workflow modificati validati dal contratto prompt:)/);
  });
});
