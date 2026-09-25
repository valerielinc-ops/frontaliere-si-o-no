#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function mergeUniqueArrays(current, incoming) {
  const merged = [];
  const positions = new Map();
  for (const value of [...current, ...incoming]) {
    const key = value && typeof value === 'object' && !Array.isArray(value) && value.id != null
      ? `id:${String(value.id)}`
      : `canonical:${canonical(value)}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, merged.length);
      merged.push(value);
    } else {
      merged[position] = value;
    }
  }
  return merged;
}

export function mergeAppendOnlyDocument(current, incoming, arrayField) {
  const currentItems = Array.isArray(current?.[arrayField]) ? current[arrayField] : [];
  const incomingItems = Array.isArray(incoming?.[arrayField]) ? incoming[arrayField] : [];
  const currentStamp = Date.parse(String(current?.updatedAt ?? ''));
  const incomingStamp = Date.parse(String(incoming?.updatedAt ?? ''));
  const newest = incomingStamp > currentStamp ? incoming : current;
  const mergedItems = mergeUniqueArrays(currentItems, incomingItems).sort((a, b) =>
    String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? '')) || canonical(a).localeCompare(canonical(b)),
  );
  return { ...current, ...incoming, ...(newest === current ? current : incoming), [arrayField]: mergedItems };
}

function gitJson(commit, relativePath) {
  return JSON.parse(execFileSync('git', ['show', `${commit}:${relativePath}`], { encoding: 'utf8' }));
}

function readCurrent(relativePath, fallback) {
  try {
    return JSON.parse(readFileSync(relativePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--commit' || arg === '--path' || arg === '--array-field') options[arg.slice(2)] = argv[++i];
    else if (arg === '--array') options.array = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.commit || !options.path || (!options.array && !options.arrayField)) {
    throw new Error('usage: merge-generated-json.mjs --commit SHA --path FILE --array [--array-field FIELD]');
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const { commit, path, array, arrayField } = parseArgs(argv);
  const incoming = gitJson(commit, path);
  const current = readCurrent(path, array ? [] : {});
  const merged = array
    ? mergeUniqueArrays(Array.isArray(current) ? current : [], Array.isArray(incoming) ? incoming : [])
    : mergeAppendOnlyDocument(current, incoming, arrayField);
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
