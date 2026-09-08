#!/usr/bin/env node
/**
 * Verify the transitive import closure used by followup-drainer.yml without
 * installing node_modules. Relative imports must resolve inside this checkout;
 * package imports must be Node builtins, except for firebase-admin's guarded
 * REST fallback in scripts/load-rc-env.mjs.
 */
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const ENTRYPOINTS = [
  'scripts/ci/followup-drainer.mjs',
  'scripts/load-rc-env.mjs',
  'scripts/ci/mint-app-token.mjs',
  'scripts/ci/alert-pat-down.mjs',
  'scripts/ci/probe-workflow-scope.mjs',
];

const BUILTINS = new Set(builtinModules);
const ALLOWED_PACKAGES = new Map([
  ['scripts/load-rc-env.mjs', new Set(['firebase-admin'])],
]);

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function importSpecifiers(source) {
  const code = stripComments(source);
  const specs = [];
  const seen = new Set();
  const add = (specifier) => {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      specs.push(specifier);
    }
  };

  for (const re of [
    /^\s*import\s+(?:[^'";\n]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /^\s*export\s+[^'";\n]*?\s+from\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of code.matchAll(re)) add(match[1]);
  }
  return specs;
}

function relativeInsideRoot(file) {
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`relative import escapes repository root: ${rel}`);
  }
  return rel;
}

function resolveRelative(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  relativeInsideRoot(base);
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.mjs'),
    path.join(base, 'index.js'),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file) {
    throw new Error(`${relativeInsideRoot(from)} imports ${specifier}, but no local module resolves at ${relativeInsideRoot(base)}`);
  }
  return file;
}

function isBuiltin(specifier) {
  return specifier.startsWith('node:') || BUILTINS.has(specifier);
}

export function scanImportClosure({ root = ROOT, entries = ENTRYPOINTS } = {}) {
  if (root !== ROOT) throw new Error('scanImportClosure currently supports the repository root only');
  const pending = entries.map((entry) => path.resolve(root, entry));
  const visited = new Set();
  const packageImports = [];
  while (pending.length > 0) {
    const file = pending.pop();
    const rel = relativeInsideRoot(file);
    if (visited.has(rel)) continue;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`entrypoint or imported file does not exist: ${rel}`);
    }
    visited.add(rel);
    for (const specifier of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        pending.push(resolveRelative(file, specifier));
        continue;
      }
      if (isBuiltin(specifier)) continue;
      if (ALLOWED_PACKAGES.get(rel)?.has(specifier)) {
        packageImports.push({ file: rel, specifier });
        continue;
      }
      throw new Error(`undeclared npm import in dependency-free closure: ${rel} -> ${specifier}`);
    }
  }
  return { files: [...visited].sort(), packageImports };
}

export function main() {
  const result = scanImportClosure();
  console.log(`dependency-free import closure OK: ${result.files.length} files`);
  for (const { file, specifier } of result.packageImports) {
    console.log(`  guarded package exception: ${file} -> ${specifier}`);
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) main();
