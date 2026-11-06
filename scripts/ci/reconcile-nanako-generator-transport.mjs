#!/usr/bin/env node
/**
 * Reconcile the site-owned portion of nanako's generator transport.
 *
 * The transport is an overlay because nanako owns other files under
 * generator/.  A persisted ledger is therefore required to distinguish a
 * site-owned file removed from the source manifest from a nanako-owned file
 * that must survive the overlay.  The ledger is written into the nanako
 * branch and the previous version is copied to a runner-temporary file for
 * the staged-deletion guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SITE_OWNED_MANIFEST_PATH = '.github/transport/nanako-generator-site-owned-manifest.txt';

function assertSafeTransportPath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || value.includes('\r')
    || value.includes('\\')
    || value.startsWith('/')
  ) {
    throw new Error(`${label} must contain safe repository-relative paths, got ${JSON.stringify(value)}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe path: ${JSON.stringify(value)}`);
  }
}

function readPathList(filePath, { allowMissing = false, label = filePath } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) return [];
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);

  const paths = [];
  const seen = new Set();
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const [index, rawLine] of lines.entries()) {
    const value = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (value === '') continue;
    assertSafeTransportPath(value, `${label}:${index + 1}`);
    if (seen.has(value)) throw new Error(`${label} contains a duplicate path: ${value}`);
    seen.add(value);
    paths.push(value);
  }
  return paths.sort();
}

function formatPathList(paths) {
  return paths.length > 0 ? `${paths.join('\n')}\n` : '';
}

function generatorTarget(corpusRoot, sitePath) {
  assertSafeTransportPath(sitePath, 'transport path');
  const generatorRoot = path.resolve(corpusRoot, 'generator');
  const target = path.resolve(generatorRoot, ...sitePath.split('/'));
  if (target === generatorRoot || !target.startsWith(`${generatorRoot}${path.sep}`)) {
    throw new Error(`transport path escapes generator/: ${sitePath}`);
  }
  return target;
}

function requireRegularSource(sourceRoot, sitePath) {
  const source = path.resolve(sourceRoot, ...sitePath.split('/'));
  const sourceRootResolved = path.resolve(sourceRoot);
  if (source !== sourceRootResolved && !source.startsWith(`${sourceRootResolved}${path.sep}`)) {
    throw new Error(`transport path escapes source checkout: ${sitePath}`);
  }
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`resolved transport source is missing: ${sitePath}`);
  }
  return source;
}

function removeStaleSiteOwnedFile(corpusRoot, sitePath) {
  const target = generatorTarget(corpusRoot, sitePath);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`stale site-owned transport path is not a file: generator/${sitePath}`);
  }
  fs.unlinkSync(target);
  return true;
}

/**
 * Overlay the current resolved manifest and reconcile only stale paths that
 * the previous transport ledger proves were site-owned.
 *
 * @param {{sourceRoot: string, corpusRoot: string, resolvedManifestPath: string, previousManifestOutputPath?: string}} options
 * @returns {{currentPaths: string[], previousPaths: string[], removed: string[], ledgerPath: string}}
 */
export function reconcileNanakoGeneratorTransport({
  sourceRoot,
  corpusRoot,
  resolvedManifestPath,
  previousManifestOutputPath,
} = {}) {
  if (!sourceRoot || !corpusRoot || !resolvedManifestPath) {
    throw new Error('sourceRoot, corpusRoot, and resolvedManifestPath are required');
  }

  const ledgerPath = path.join(corpusRoot, SITE_OWNED_MANIFEST_PATH);
  const currentPaths = readPathList(resolvedManifestPath, { label: 'resolved manifest' });
  const previousPaths = readPathList(ledgerPath, {
    allowMissing: true,
    label: 'previous site-owned manifest',
  });
  if (previousManifestOutputPath) {
    fs.mkdirSync(path.dirname(previousManifestOutputPath), { recursive: true });
    fs.writeFileSync(previousManifestOutputPath, formatPathList(previousPaths));
  }

  const currentSet = new Set(currentPaths);
  const removed = [];
  for (const sitePath of previousPaths) {
    if (currentSet.has(sitePath)) continue;
    if (removeStaleSiteOwnedFile(corpusRoot, sitePath)) removed.push(sitePath);
  }

  for (const sitePath of currentPaths) {
    const source = requireRegularSource(sourceRoot, sitePath);
    const target = generatorTarget(corpusRoot, sitePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, formatPathList(currentPaths));
  return { currentPaths, previousPaths, removed, ledgerPath };
}

/**
 * Check staged deletions against the previous and current site-owned ledgers.
 * A deletion is valid only when the previous ledger names it and the current
 * resolved manifest no longer does. Every other deletion remains fatal.
 */
export function validateStagedGeneratorDeletions({
  corpusRoot,
  resolvedManifestPath,
  previousManifestPath,
  stagedPaths,
  stagedPathsFile,
} = {}) {
  if (!corpusRoot || !resolvedManifestPath || !previousManifestPath || (!stagedPaths && !stagedPathsFile)) {
    throw new Error('corpusRoot, resolvedManifestPath, previousManifestPath, and staged paths are required');
  }
  const currentPaths = new Set(readPathList(resolvedManifestPath, { label: 'resolved manifest' }));
  const previousPaths = new Set(readPathList(previousManifestPath, {
    label: 'previous site-owned manifest',
  }));
  const deleted = Array.isArray(stagedPaths)
    ? [...stagedPaths]
    : fs.readFileSync(stagedPathsFile, 'utf8').split('\0').filter(Boolean);
  const allowed = [];
  const unexpected = [];

  for (const target of deleted) {
    if (!target.startsWith('generator/')) {
      unexpected.push(target);
      continue;
    }
    const sitePath = target.slice('generator/'.length);
    try {
      assertSafeTransportPath(sitePath, 'staged generator deletion');
    } catch {
      unexpected.push(target);
      continue;
    }
    if (previousPaths.has(sitePath) && !currentPaths.has(sitePath)) allowed.push(target);
    else unexpected.push(target);
  }

  return { deleted, allowed, unexpected };
}

function runCli() {
  const mode = process.argv[2];
  try {
    if (mode === '--stage') {
      const [sourceRoot, corpusRoot, resolvedManifestPath, previousManifestOutputPath] = process.argv.slice(3);
      const result = reconcileNanakoGeneratorTransport({
        sourceRoot,
        corpusRoot,
        resolvedManifestPath,
        previousManifestOutputPath,
      });
      console.log(JSON.stringify({
        ledger: result.ledgerPath,
        copied: result.currentPaths.length,
        removed: result.removed,
      }));
      return;
    }
    if (mode === '--guard') {
      const [corpusRoot, resolvedManifestPath, previousManifestPath, stagedPathsFile] = process.argv.slice(3);
      const result = validateStagedGeneratorDeletions({
        corpusRoot,
        resolvedManifestPath,
        previousManifestPath,
        stagedPathsFile,
      });
      console.log(`staged deletions: ${result.deleted.length}`);
      for (const target of result.allowed) {
        console.log(`allowed stale site-owned deletion: ${target}`);
      }
      if (result.unexpected.length > 0) {
        console.error('::error::transport would delete an unowned or current generator file — refusing. Files:');
        for (const target of result.unexpected) console.error(target);
        process.exitCode = 1;
      }
      return;
    }
    throw new Error('usage: --stage <sourceRoot> <corpusRoot> <resolvedManifest> <previousManifestOut> | --guard <corpusRoot> <resolvedManifest> <previousManifest> <stagedDeletionsFile>');
  } catch (error) {
    console.error(`reconcile-nanako-generator-transport fallito: ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (invokedDirectly) runCli();
