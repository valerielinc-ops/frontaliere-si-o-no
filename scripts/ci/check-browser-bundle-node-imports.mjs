#!/usr/bin/env node
/**
 * Cammina il grafo dei moduli dall'entry SPA e conta le foglie che importano
 * un builtin Node.
 *
 * Perche' esiste (#8125): `build-plugins/**` e' raggiungibile dalla SPA per
 * scelta — i costruttori di path e gli elenchi di slug hanno una sola sorgente
 * condivisa fra l'emettitore SSG e il router del browser. Il difetto non e'
 * l'arco, e' un modulo che MESCOLA quei costruttori con codice di build che
 * legge da disco: rollup risolve `node:fs`/`node:crypto` a
 * `__vite-browser-external`, che non ha export nominati. Un import NOMINALE di
 * un builtin e' quindi fatale al link — cioe' dopo ~80 minuti di build — mentre
 * un import namespace resta un warning. Sono la stessa classe di difetto: il
 * warning diventa fatale il giorno in cui qualcuno riscrive
 * `import * as _fs` come `import { readFileSync }`.
 *
 * La misura e' quindi sulla PRESENZA del builtin nel grafo, non sulla forma
 * sintattica dell'import ne' sul fatto che il browser lo esegua (l'errore di
 * #8123 e' un fallimento di risoluzione del binding: `createHash` non veniva
 * mai chiamato dal browser).
 *
 * Uso: node scripts/ci/check-browser-bundle-node-imports.mjs [--json]
 * Exit 1 se il grafo contiene almeno una foglia con import Node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRIES = ['App.tsx', 'index.tsx'];
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.mts', '.cjs'];
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/** Import/export specifier, statico o dinamico. Deliberatamente sintattico:
 *  serve la stessa popolazione di archi che rollup mette nel grafo. */
const SPECIFIER_RE =
  /(?:\bimport\s+[^;'"]*?\bfrom\s*|\bexport\s+[^;'"]*?\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** `import type { X } from` non produce un arco a runtime: rollup lo cancella. */
const TYPE_ONLY_RE = /\bimport\s+type\b|\bexport\s+type\b/;

const isBuiltin = (spec) => BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);

function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // dipendenza npm: non e' codice del repo

  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  for (const ext of EXTENSIONS.slice(1)) {
    const candidate = path.join(base, `index${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readEdges(file) {
  const source = fs.readFileSync(file, 'utf-8');
  // Commenti e stringhe template fuori: un `node:fs` citato in un docblock non
  // e' un arco, e contarlo renderebbe la misura non falsificabile.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const edges = [];
  for (const match of code.matchAll(SPECIFIER_RE)) {
    const stmt = code.slice(Math.max(0, match.index - 24), match.index + match[0].length);
    if (TYPE_ONLY_RE.test(stmt)) continue;
    edges.push(match[1]);
  }
  return edges;
}

function walk() {
  const visited = new Set();
  const parents = new Map();
  const leaves = [];
  const queue = ENTRIES.map((e) => path.join(ROOT, e));
  for (const entry of queue) visited.add(entry);

  while (queue.length) {
    const file = queue.shift();
    for (const spec of readEdges(file)) {
      if (isBuiltin(spec)) {
        leaves.push({ file: path.relative(ROOT, file), builtin: spec });
        continue;
      }
      const resolved = resolveSpecifier(spec, file);
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);
      parents.set(resolved, file);
      queue.push(resolved);
    }
  }
  return { modules: visited, leaves, parents };
}

function chainOf(file, parents) {
  const chain = [file];
  let current = path.join(ROOT, file);
  while (parents.has(current)) {
    current = parents.get(current);
    chain.unshift(path.relative(ROOT, current));
  }
  return chain;
}

export function measureBrowserGraph() {
  const { modules, leaves, parents } = walk();
  const byFile = new Map();
  for (const leaf of leaves) {
    if (!byFile.has(leaf.file)) byFile.set(leaf.file, { file: leaf.file, builtins: [] });
    byFile.get(leaf.file).builtins.push(leaf.builtin);
  }
  return {
    moduleCount: modules.size,
    leaves: [...byFile.values()].map((leaf) => ({
      ...leaf,
      chain: chainOf(leaf.file, parents),
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = measureBrowserGraph();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`moduli raggiunti dall'entry SPA: ${result.moduleCount}`);
    console.log(`foglie con import Node: ${result.leaves.length}`);
    for (const leaf of result.leaves) {
      console.log(`\n  ${leaf.file} -> ${leaf.builtins.join(', ')}`);
      console.log(`  catena: ${leaf.chain.join('\n          -> ')}`);
    }
  }
  process.exit(result.leaves.length === 0 ? 0 : 1);
}
