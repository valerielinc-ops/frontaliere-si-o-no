#!/usr/bin/env node

import fs from 'node:fs';

/**
 * Parse `git ls-tree -r -z` output into path -> blob OID entries.
 *
 * The verifier deliberately compares blob IDs, not file contents: the full
 * pusher and the delta index therefore have to agree on exactly the same Git
 * tree, while the check remains a cheap metadata comparison after hashing.
 */
export function parseTreeListing(listing) {
  const buffer = Buffer.isBuffer(listing) ? listing : Buffer.from(String(listing));
  const entries = new Map();
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error(`git tree record without path separator: ${record}`);
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const filePath = record.slice(tab + 1);
    if (type !== 'blob' || !mode || !/^[0-9a-f]{40,64}$/i.test(oid || '') || !filePath) {
      throw new Error(`invalid git tree record: ${record}`);
    }
    entries.set(filePath, oid);
  }
  return entries;
}

/**
 * Compare the previous tree with the tree a delta plan would produce, then
 * compare that plan tree with the tree actually pushed by full mode.
 *
 * `files` is the number of files in the planned final tree. `adds`, `mods`,
 * and `dels` describe the delta from the previous tree to that plan. A
 * mismatch is one path whose planned blob is absent/different in the actual
 * tree, or which exists only in the actual tree. The returned mismatch list is
 * capped at 50 for logs/artifacts, while mismatchCount remains exact.
 */
export function compareTreeEntries(base, plan, actual) {
  let adds = 0;
  let mods = 0;
  let dels = 0;

  for (const [filePath, plannedOid] of plan) {
    const baseOid = base.get(filePath);
    if (baseOid === undefined) adds += 1;
    else if (baseOid !== plannedOid) mods += 1;
  }
  for (const filePath of base.keys()) {
    if (!plan.has(filePath)) dels += 1;
  }

  const paths = new Set([...plan.keys(), ...actual.keys()]);
  const mismatches = [];
  for (const filePath of [...paths].sort()) {
    const expected = plan.get(filePath);
    const observed = actual.get(filePath);
    if (expected === observed) continue;
    const kind = expected === undefined ? 'extra' : observed === undefined ? 'missing' : 'blob';
    mismatches.push({
      kind,
      path: filePath,
      expected: expected ?? null,
      actual: observed ?? null,
    });
  }

  return {
    files: plan.size,
    adds,
    mods,
    dels,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 50),
  };
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
    else if (arg.startsWith('--plan=')) args.plan = arg.slice('--plan='.length);
    else if (arg.startsWith('--actual=')) args.actual = arg.slice('--actual='.length);
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.base || !args.plan || !args.actual || !args.out) {
    throw new Error('Uso: shard-push-verify.mjs --base=... --plan=... --actual=... --out=...');
  }
  const summary = compareTreeEntries(
    parseTreeListing(fs.readFileSync(args.base)),
    parseTreeListing(fs.readFileSync(args.plan)),
    parseTreeListing(fs.readFileSync(args.actual)),
  );
  fs.writeFileSync(args.out, `${JSON.stringify(summary)}\n`);
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && process.argv[1].endsWith('/shard-push-verify.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`shard-push-verify: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
