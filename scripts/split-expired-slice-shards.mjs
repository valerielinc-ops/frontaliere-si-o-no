#!/usr/bin/env node
/**
 * One-shot, lossless migration of an expired archive monolith
 * (`data/jobs/expired/by-crawler/<key>.json`) into
 * `<key>.shard-001.json`, `<key>.shard-002.json`… (scripts/lib/expired-slice-store.mjs).
 *
 * The pipeline writers do NOT need this: once a monolith is past the shard
 * target they stop growing it and append to `<key>.shard-NNN.json`. This tool
 * is for an offline split (and for measuring one): the rows read back through
 * `readExpiredSliceRows` are the same, in the same order, before and after.
 *
 *   node scripts/split-expired-slice-shards.mjs --key coop-ticino            # dry run, prints the plan
 *   node scripts/split-expired-slice-shards.mjs --key coop-ticino --apply
 *   node scripts/split-expired-slice-shards.mjs --all-over-target --dir /tmp/x
 *
 * Committing an applied split from a data workflow deletes the monolith: the
 * isolated commit path only deletes a named file with --extra-only, and its
 * integrity guard refuses a catastrophic slice deletion, so run it only with a
 * commit path that names the monolith AND its shards together.
 */
import fs from 'node:fs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  DEFAULT_EXPIRED_SLICES_DIR,
  EXPIRED_SLICE_SHARD_TARGET_BYTES,
  listExpiredSliceFiles,
  listExpiredSliceKeys,
  readExpiredSliceRows,
  splitExpiredSliceMonolith,
} from './lib/expired-slice-store.mjs';

function parseArgs(argv) {
  const args = { keys: [], dir: DEFAULT_EXPIRED_SLICES_DIR, apply: false, allOverTarget: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--key') args.keys.push(argv[++i]);
    else if (flag === '--dir') args.dir = argv[++i];
    else if (flag === '--apply') args.apply = true;
    else if (flag === '--all-over-target') args.allOverTarget = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let keys = args.keys;
  if (args.allOverTarget) {
    keys = listExpiredSliceKeys({ dir: args.dir }).filter((key) => {
      const files = listExpiredSliceFiles(key, { dir: args.dir });
      return files.length === 1 && files[0].index === 0
        && fs.statSync(files[0].path).size > EXPIRED_SLICE_SHARD_TARGET_BYTES;
    });
  }
  if (keys.length === 0) {
    console.error('usage: split-expired-slice-shards.mjs (--key <crawler> ... | --all-over-target) [--dir <dir>] [--apply]');
    return 2;
  }
  for (const key of keys) {
    const before = args.apply ? readExpiredSliceRows(key, { dir: args.dir }) : null;
    const result = splitExpiredSliceMonolith(key, { dir: args.dir, apply: args.apply });
    if (args.apply) {
      const after = readExpiredSliceRows(key, { dir: args.dir });
      const same = before.length === after.length
        && before.every((row, i) => JSON.stringify(row) === JSON.stringify(after[i]));
      if (!same) throw new Error(`${key}: rows differ after the split`);
    }
    console.log(JSON.stringify({ key, applied: args.apply, ...result }));
  }
  return 0;
}

if (isInvokedDirectly(import.meta.url)) process.exit(main());
