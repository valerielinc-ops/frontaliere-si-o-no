#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { validateItShardGroupPlan } from './it-shard-group-plan.mjs';
import { sectionBatch } from './shard-content-manifest.mjs';

// The section tars add up to most of the runner disk: copying them into the
// batch dirs doubled that and died with ENOSPC on publish run 43237316438.
// A hard link adds no bytes and leaves the source tar in place for later steps;
// only a cross-device layout falls back to a copy.
export function linkOrCopy(source, target) {
  try {
    fs.linkSync(source, target);
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM') throw error;
    fs.copyFileSync(source, target);
  }
}

export function packageItShardValidationBatches({ planFile, tarDir, outDir }) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const verdict = validateItShardGroupPlan(plan);
  if (!verdict.valid) {
    throw new Error(`IT shard source plan is invalid: ${verdict.errors.join('; ')}`);
  }
  const required = plan.requiredSections;
  const batches = new Map(Array.from({ length: 6 }, (_, index) => [index + 1, []]));
  for (const section of required) {
    const tar = path.join(tarDir, section + '-dist-it.tar');
    if (!fs.existsSync(tar) || fs.statSync(tar).size === 0) {
      console.warn('[it-shard-batches] ' + section + ': post-push validation tar is absent');
      continue;
    }
    batches.get(sectionBatch(section)).push(tar);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [batch, files] of batches) {
    const dir = path.join(outDir, String(batch));
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) linkOrCopy(file, path.join(dir, path.basename(file)));
  }
  const summary = Object.fromEntries([...batches].map(([batch, files]) => [batch, files.map((file) => path.basename(file))]));
  console.log(JSON.stringify(summary));
  return summary;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    args[key] = argv[index + 1]?.startsWith('--') ? true : (argv[index + 1] ?? true);
    if (args[key] !== true) index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plan || !args['tar-dir'] || !args.out) {
    throw new Error('usage: package-it-shard-validation-batches.mjs --plan <file> --tar-dir <dir> --out <dir>');
  }
  packageItShardValidationBatches({ planFile: args.plan, tarDir: args['tar-dir'], outDir: args.out });
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  try { main(); } catch (error) {
    console.error('[it-shard-batches] ' + (error?.stack || error?.message || error));
    process.exitCode = 1;
  }
}
