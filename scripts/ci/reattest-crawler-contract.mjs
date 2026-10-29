#!/usr/bin/env node

/**
 * Re-attest the source revision of the portable crawler contract.
 *
 * Generated crawler artifacts are assembled before a promotion PR is merged.
 * The squash commit that lands that PR therefore cannot be known while the
 * PR branch is being generated.  This helper updates only the two lineage
 * fields after the source change has landed on main; artifact and digest
 * fields are intentionally left untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONTRACT_PATH = '.github/corpus-workflows/contract.json';
export const SOURCE_COMMIT_RE = /^[a-f0-9]{40}$/u;

function assertSourceCommit(sourceCommit) {
  const normalized = String(sourceCommit || '').trim();
  if (!SOURCE_COMMIT_RE.test(normalized)) {
    throw new Error(
      `crawler contract sourceCommit must be a 40-character commit SHA, got ${JSON.stringify(sourceCommit)}`,
    );
  }
  return normalized;
}

function cloneDocument(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Update lineage without regenerating or rewriting any artifact digest.
 *
 * @param {Record<string, unknown>} contract
 * @param {string} sourceCommit
 * @returns {Record<string, unknown>}
 */
export function reattestCrawlerContract(contract, sourceCommit) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('crawler contract must be a JSON object');
  }
  if (!contract.artifactObservation
    || typeof contract.artifactObservation !== 'object'
    || Array.isArray(contract.artifactObservation)) {
    throw new Error('crawler contract artifactObservation must be a JSON object');
  }

  const normalized = assertSourceCommit(sourceCommit);
  const next = cloneDocument(contract);
  next.sourceCommit = normalized;
  next.artifactObservation.sourceCommit = normalized;
  return next;
}

/**
 * @param {string} text
 * @param {string} sourceCommit
 * @returns {string}
 */
export function reattestCrawlerContractText(text, sourceCommit) {
  const contract = JSON.parse(text);
  return `${JSON.stringify(reattestCrawlerContract(contract, sourceCommit), null, 2)}\n`;
}

function parseArgs(argv) {
  const options = {
    contractPath: DEFAULT_CONTRACT_PATH,
    sourceCommit: process.env.CRAWLER_SOURCE_COMMIT || '',
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write') {
      options.write = true;
      continue;
    }
    if (argument === '--path' || argument === '--source-commit') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--path') options.contractPath = value;
      else options.sourceCommit = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--path=')) {
      options.contractPath = argument.slice('--path='.length);
      continue;
    }
    if (argument.startsWith('--source-commit=')) {
      options.sourceCommit = argument.slice('--source-commit='.length);
      continue;
    }
    throw new Error(`unknown option ${argument}`);
  }
  return options;
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const contractPath = path.resolve(options.contractPath);
  const before = fs.readFileSync(contractPath, 'utf8');
  const after = reattestCrawlerContractText(before, options.sourceCommit);
  const changed = before !== after;

  if (options.write && changed) fs.writeFileSync(contractPath, after);
  process.stdout.write(`${changed ? 'changed' : 'already-attested'} ${contractPath}\n`);
  if (!options.write && changed) process.stdout.write(after);
  return { changed, contractPath, before, after };
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1])
      && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    runCli();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}
