#!/usr/bin/env node
/**
 * Check the dependency-free relative-import closure extracted for the Mac
 * host. This file is intentionally built only from Node built-ins so the
 * launcher can run it before node_modules is linked or the robot is loaded.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '');
const entries = ['scripts/social-robot/run.mjs', 'scripts/load-rc-env.mjs'];
const extensions = ['', '.mjs', '.js', '.cjs', '.json'];
const importPatterns = [
  /^[ \t]*import[ \t]+(?:[^'"`;\n]*(?:\n[^'"`;\n]*){0,20}(?:[ \t]+from[ \t]*|[ \t]*\n[ \t]*from[ \t]*))?['"]([^'"]+)['"]/gm,
  /^[ \t]*export[ \t]+(?:\{[^'"`;\n]*(?:\n[^'"`;\n]*){0,20}\}|\*[ \t]*(?:as[ \t]+[A-Za-z_$][A-Za-z0-9_$]*)?)(?:[ \t]+from[ \t]*|[ \t]*\n[ \t]*from[ \t]*)['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function stripComments(source) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      out += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      out += character;
    } else if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      out += '\n';
    } else if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 1;
    } else {
      out += character;
    }
  }
  return out;
}

function stringRanges(source) {
  const ranges = [];
  let quote = null;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!quote) {
      if (character === '\'' || character === '"' || character === '`') {
        quote = character;
        start = index;
      }
      continue;
    }
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === quote) {
      ranges.push([start, index + 1]);
      quote = null;
    }
  }
  return ranges;
}

function importSpecifiers(source) {
  const code = stripComments(source);
  const literals = stringRanges(code);
  const specs = new Set();
  for (const pattern of importPatterns) {
    for (const match of code.matchAll(pattern)) {
      const index = match.index ?? -1;
      if (literals.some(([start, end]) => index >= start && index < end)) continue;
      specs.add(match[1]);
    }
  }
  return specs;
}

function relative(file) {
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`import escapes snapshot: ${rel}`);
  return rel;
}

function resolve(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => path.join(base, `index${extension}`))];
  const file = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!file) throw new Error(`${relative(from)} imports ${specifier}, but ${relative(base)} is missing`);
  return file;
}

const seen = new Set();
function walk(entry) {
  const file = path.resolve(root, entry);
  const rel = relative(file);
  if (seen.has(rel)) return;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`snapshot entry is missing: ${rel}`);
  seen.add(rel);
  for (const specifier of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
    if (specifier.startsWith('.')) walk(resolve(file, specifier));
  }
}

for (const entry of entries) walk(entry);
